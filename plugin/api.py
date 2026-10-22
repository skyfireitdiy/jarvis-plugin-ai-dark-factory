"""
Reversa 插件私有功能层（运行在 gateway，供前端代理调用；不暴露给 Agent）。

提供 Reversa 逆向工程插件的全部业务功能纯函数（无状态）：
- install_project：绕过交互式 CLI 直连 Reversa installer 库安装工作区
- get_status：读取 .reversa/state.json 返回分析进度
- list_artifacts：列出 _reversa_sdd/ 产物文件树
- read_artifact：读取单个产物文件内容
- export_rules：把产物按置信度导出为 Jarvis rule（写入项目 .jarvis/rules/reversa/）
- uninstall_project：卸载 Reversa 工作区（保留 _reversa_sdd/ 产物）
- get_skills：列出已安装的 Reversa skills（供 Agent 加载执行）

设计（issue #328 讨论定稿）：
- 后端无状态：本模块是纯函数，不存配置、不维护会话；设置纯前端 localStorage。
- 按项目目录 ACL 校验：所有函数都要求 project_dir 为已存在的目录，且
  通过 _resolve_project 规范化（防路径穿越）。
- 安装/卸载通过 node 子进程调用 plugin/reversa_bridge.mjs（Reversa 库是 ESM，
  Python 无法直接 import），bridge 直连 Reversa installer 库用代码构造 answers。

每个函数返回 dict：{"success": bool, "data": .../ "message": .../ "error": ...}。
本模块不声明在 tool_load_dirs，因此不会被 ToolRegistry 加载，Agent 不可见；
gateway 通过插件功能代理端点动态加载本模块并调用。
"""
import hashlib
import json
import os
import re
import subprocess
from typing import Any
from typing import Dict
from typing import List
from typing import Optional

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_BRIDGE_PATH = os.path.join(_THIS_DIR, "reversa_bridge.mjs")

# 默认输出目录（与 Reversa 默认一致）
_DEFAULT_OUTPUT_FOLDER = "_reversa_sdd"
# 导出规则的目标目录（项目内）
_EXPORT_RULES_DIR = os.path.join(".jarvis", "rules", "reversa", "artifacts")
# 项目依赖配置（各仓库目录下，B 依赖 A 就写 B 的 deps.json 含 A 的绝对路径）
_DEPS_FILE = os.path.join(".jarvis", "reversa", "deps.json")
# 知识回流基线记录（与产物同生命周期，卸载保留产物时一并保留）
_SYNC_FILE = os.path.join(_DEFAULT_OUTPUT_FOLDER, ".reversa-sync.json")
# 置信度标记
_CONFIDENCE_CONFIRMED = "🟢CONFIRMED"
_CONFIDENCE_INFERRED = "🟡INFERRED"
_CONFIDENCE_GAP = "🔴GAP"
# 默认导出置信度（决策 8：默认只导出 CONFIRMED/INFERRED，GAP 不导出）
_DEFAULT_EXPORT_CONFIDENCES = (_CONFIDENCE_CONFIRMED, _CONFIDENCE_INFERRED)


# ---------------------------------------------------------------------------
# 路径校验（ACL）
# ---------------------------------------------------------------------------
def _resolve_project(project_dir: Any) -> tuple:
    """校验并规范化项目目录。返回 (abs_path, error)；非法时 error 非空。

    要求：非空、展开 ~、绝对化、必须存在且为目录。
    """
    project_dir = (project_dir or "").strip()
    if not project_dir:
        return "", "未指定项目目录（project_dir）"
    abs_path = os.path.abspath(os.path.expanduser(project_dir))
    if not os.path.isdir(abs_path):
        return "", f"项目目录不存在: {abs_path}"
    return abs_path, ""


def _resolve_artifact_path(project_dir: str, rel_path: Any) -> tuple:
    """校验产物相对路径，防止路径穿越。返回 (abs_path, error)。

    rel_path 必须是 _reversa_sdd/ 下的相对路径，且解析后仍在项目目录内。
    """
    rel_path = (rel_path or "").strip().lstrip("/\\")
    if not rel_path:
        return "", "未指定产物路径"
    output_dir = os.path.join(project_dir, _DEFAULT_OUTPUT_FOLDER)
    abs_path = os.path.abspath(os.path.join(output_dir, rel_path))
    if not abs_path.startswith(os.path.abspath(output_dir) + os.sep):
        return "", f"非法路径（越界）: {rel_path}"
    if not os.path.isfile(abs_path):
        return "", f"产物文件不存在: {rel_path}"
    return abs_path, ""


# ---------------------------------------------------------------------------
# node 子进程调用 bridge
# ---------------------------------------------------------------------------
def _run_bridge(args: List[str], timeout: int = 300) -> Dict[str, Any]:
    """通过 npm exec 调用 reversa_bridge.mjs。

    返回 {"success": bool, "data": dict / "error": str}。
    npm exec --package=reversa 会把 reversa 包加入 PATH，bridge 据此定位包根。
    """
    cmd = ["npm", "exec", "--yes", "--package=reversa", "--", "node", _BRIDGE_PATH] + args
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except FileNotFoundError:
        return {"success": False, "error": "未找到 npm 命令（请确认已安装 Node.js/npm）"}
    except subprocess.TimeoutExpired:
        return {"success": False, "error": f"执行超时（>{timeout}s）"}
    except Exception as e:  # noqa: BLE001
        return {"success": False, "error": f"执行异常: {e}"}
    if result.returncode != 0:
        # 尝试解析 stdout 中的 JSON 错误
        try:
            parsed = json.loads((result.stdout or "").strip().splitlines()[-1])
            if isinstance(parsed, dict) and parsed.get("success") is False:
                return {"success": False, "error": parsed.get("error", "未知错误")}
        except Exception:  # noqa: BLE001
            pass
        detail = (result.stderr or result.stdout or "").strip()
        return {"success": False, "error": f"bridge 执行失败: {detail[:500]}"}
    try:
        parsed = json.loads((result.stdout or "").strip().splitlines()[-1])
    except Exception:  # noqa: BLE001
        return {"success": False, "error": f"bridge 输出解析失败: {(result.stdout or '')[:200]}"}
    if not isinstance(parsed, dict) or parsed.get("success") is not True:
        return {"success": False, "error": parsed.get("error", "未知错误")}
    return {"success": True, "data": parsed.get("data", {})}


# ---------------------------------------------------------------------------
# 生命周期
# ---------------------------------------------------------------------------
def install_project(
    project_dir: Optional[str] = None,
    engine: str = "codex",
    name: Optional[str] = None,
    user: Optional[str] = None,
    chat_language: str = "zh-cn",
    doc_language: str = "中文",
    output_folder: str = _DEFAULT_OUTPUT_FOLDER,
) -> Dict[str, Any]:
    """安装 Reversa 工作区到项目目录（绕过交互式 CLI 直连 installer 库）。

    参数:
        project_dir: 目标项目目录（必填）
        engine: 目标 engine（默认 codex，仅决定 skills 安装目录 .agents/skills）
        name: 项目名（默认取目录名）
        user: 用户名（默认 "user"）
        chat_language: 交互语言（默认 zh-cn）
        doc_language: 文档语言（默认 中文）
        output_folder: 规格输出目录（默认 _reversa_sdd）

    返回 {"success": True, "data": {...}}；失败 success=False。
    """
    project_dir, err = _resolve_project(project_dir)
    if err:
        return {"success": False, "error": err}
    engine = (engine or "codex").strip()
    args = [
        "install",
        "--project", project_dir,
        "--engine", engine,
        "--chat_language", chat_language or "zh-cn",
        "--doc_language", doc_language or "中文",
        "--output_folder", output_folder or _DEFAULT_OUTPUT_FOLDER,
    ]
    if name:
        args += ["--name", str(name)]
    if user:
        args += ["--user", str(user)]
    resp = _run_bridge(args, timeout=600)
    if not resp["success"]:
        return {"success": False, "error": resp["error"]}
    return {"success": True, "data": resp["data"]}


def get_status(project_dir: Optional[str] = None) -> Dict[str, Any]:
    """读取项目 .reversa/state.json，返回分析进度。

    返回 {"success": True, "data": {installed, phase, completed, pending, ...}}。
    未安装时 data.installed=False（success 仍为 True）。
    """
    project_dir, err = _resolve_project(project_dir)
    if err:
        return {"success": False, "error": err}
    resp = _run_bridge(["status", "--project", project_dir], timeout=120)
    if not resp["success"]:
        return {"success": False, "error": resp["error"]}
    return {"success": True, "data": resp["data"]}


def uninstall_project(
    project_dir: Optional[str] = None, keep_output: bool = True
) -> Dict[str, Any]:
    """卸载 Reversa 工作区。

    依据 .reversa/state.json 的 created_files 删除安装产物（跳过用户修改过的
    文件），删除 .reversa/；_reversa_sdd/ 产物默认保留（决策 10）。
    """
    project_dir, err = _resolve_project(project_dir)
    if err:
        return {"success": False, "error": err}
    args = ["uninstall", "--project", project_dir]
    if not keep_output:
        args += ["--keep_output", "false"]
    resp = _run_bridge(args, timeout=300)
    if not resp["success"]:
        return {"success": False, "error": resp["error"]}
    return {"success": True, "data": resp["data"]}


# ---------------------------------------------------------------------------
# 产物浏览
# ---------------------------------------------------------------------------
def _walk_output_dir(project_dir: str) -> List[Dict[str, Any]]:
    """递归列出 _reversa_sdd/ 下的文件树。

    返回 [{path, name, type: "file"|"dir", size, children?}]，按名称排序。
    目录不存在时返回空列表。
    """
    output_dir = os.path.join(project_dir, _DEFAULT_OUTPUT_FOLDER)
    if not os.path.isdir(output_dir):
        return []

    def _walk(directory: str) -> List[Dict[str, Any]]:
        entries = []
        try:
            names = sorted(os.listdir(directory))
        except Exception:  # noqa: BLE001
            return entries
        for name in names:
            full = os.path.join(directory, name)
            rel = os.path.relpath(full, output_dir).replace(os.sep, "/")
            if os.path.isdir(full):
                children = _walk(full)
                entries.append(
                    {
                        "path": rel,
                        "name": name,
                        "type": "dir",
                        "children": children,
                    }
                )
            else:
                try:
                    size = os.path.getsize(full)
                except Exception:  # noqa: BLE001
                    size = 0
                entries.append({"path": rel, "name": name, "type": "file", "size": size})
        return entries

    return _walk(output_dir)


def list_artifacts(project_dir: Optional[str] = None) -> Dict[str, Any]:
    """列出 _reversa_sdd/ 产物文件树。

    返回 {"success": True, "data": {output_folder, files: [...]}}。
    """
    project_dir, err = _resolve_project(project_dir)
    if err:
        return {"success": False, "error": err}
    files = _walk_output_dir(project_dir)
    return {
        "success": True,
        "data": {"output_folder": _DEFAULT_OUTPUT_FOLDER, "files": files},
    }


def read_artifact(
    project_dir: Optional[str] = None, path: Optional[str] = None
) -> Dict[str, Any]:
    """读取 _reversa_sdd/ 下单个产物文件内容。

    返回 {"success": True, "data": {path, content}}。
    """
    project_dir, err = _resolve_project(project_dir)
    if err:
        return {"success": False, "error": err}
    abs_path, err = _resolve_artifact_path(project_dir, path)
    if err:
        return {"success": False, "error": err}
    try:
        with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
    except Exception as e:  # noqa: BLE001
        return {"success": False, "error": f"读取产物失败: {e}"}
    rel_path = os.path.relpath(abs_path, os.path.join(project_dir, _DEFAULT_OUTPUT_FOLDER))
    return {
        "success": True,
        "data": {"path": rel_path.replace(os.sep, "/"), "content": content},
    }


def get_skills(project_dir: Optional[str] = None) -> Dict[str, Any]:
    """列出已安装的 Reversa skills（.agents/skills/<agent>/SKILL.md）。

    返回 {"success": True, "data": {skills: [{agent, path, exists}]}}。
    供前端/工具确认哪些 agent 已安装，可被 Jarvis Agent 加载执行。
    """
    project_dir, err = _resolve_project(project_dir)
    if err:
        return {"success": False, "error": err}
    skills_dir = os.path.join(project_dir, ".agents", "skills")
    skills = []
    if os.path.isdir(skills_dir):
        try:
            agents = sorted(os.listdir(skills_dir))
        except Exception:  # noqa: BLE001
            agents = []
        for agent in agents:
            skill_path = os.path.join(skills_dir, agent, "SKILL.md")
            skills.append(
                {
                    "agent": agent,
                    "path": os.path.relpath(skill_path, project_dir).replace(os.sep, "/"),
                    "exists": os.path.isfile(skill_path),
                }
            )
    return {"success": True, "data": {"skills": skills}}


# ---------------------------------------------------------------------------
# 项目依赖配置（多仓库依赖图数据源）
# ---------------------------------------------------------------------------
def _deps_file_path(project_dir: str) -> str:
    """返回项目依赖配置文件路径（<project>/.jarvis/reversa/deps.json）。"""
    return os.path.join(project_dir, _DEPS_FILE)


def get_dependencies(project_dir: Optional[str] = None) -> Dict[str, Any]:
    """读取项目依赖配置（.jarvis/reversa/deps.json）。

    返回 {"success": True, "data": {dependencies: [{path, name?, note?}]}}。
    文件不存在/损坏时返回空依赖列表（不报错，便于首次使用）。
    """
    project_dir, err = _resolve_project(project_dir)
    if err:
        return {"success": False, "error": err}
    deps_path = _deps_file_path(project_dir)
    dependencies: List[Dict[str, Any]] = []
    if os.path.isfile(deps_path):
        try:
            with open(deps_path, "r", encoding="utf-8") as f:
                parsed = json.load(f)
            raw = parsed.get("dependencies") if isinstance(parsed, dict) else None
            if isinstance(raw, list):
                dependencies = [
                    d
                    for d in raw
                    if isinstance(d, dict) and str(d.get("path") or "").strip()
                ]
        except Exception:  # noqa: BLE001
            # 损坏的 deps.json 视为空配置，不阻断使用
            dependencies = []
    return {"success": True, "data": {"dependencies": dependencies}}


def set_dependencies(
    project_dir: Optional[str] = None,
    dependencies: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """写入项目依赖配置（.jarvis/reversa/deps.json）。

    每个依赖项必须含 path（上游仓库绝对路径，需为已存在目录）；
    name/note 可选。原子写（先写临时文件再 rename），避免写坏配置。
    返回 {"success": True, "data": {dependencies: [...]}}。
    """
    project_dir, err = _resolve_project(project_dir)
    if err:
        return {"success": False, "error": err}
    deps = dependencies or []
    if not isinstance(deps, list):
        return {"success": False, "error": "dependencies 必须是数组"}
    cleaned: List[Dict[str, Any]] = []
    for item in deps:
        if not isinstance(item, dict):
            return {"success": False, "error": "依赖项必须是对象 {path, name?, note?}"}
        path = str(item.get("path") or "").strip()
        if not path:
            return {"success": False, "error": "依赖项缺少 path（上游仓库绝对路径）"}
        if not os.path.isdir(path):
            return {"success": False, "error": f"依赖路径不存在或不是目录: {path}"}
        entry: Dict[str, Any] = {"path": path}
        if str(item.get("name") or "").strip():
            entry["name"] = str(item["name"]).strip()
        if str(item.get("note") or "").strip():
            entry["note"] = str(item["note"]).strip()
        cleaned.append(entry)
    deps_path = _deps_file_path(project_dir)
    os.makedirs(os.path.dirname(deps_path), exist_ok=True)
    tmp_path = deps_path + ".tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump({"dependencies": cleaned}, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, deps_path)
    except Exception as e:  # noqa: BLE001
        return {"success": False, "error": f"写入依赖配置失败: {e}"}
    return {"success": True, "data": {"dependencies": cleaned}}


# ---------------------------------------------------------------------------
# 导出规则
# ---------------------------------------------------------------------------
def _detect_confidence(content: str) -> Optional[str]:
    """从产物内容中检测置信度标记。

    返回 "🟢CONFIRMED" / "🟡INFERRED" / "🔴GAP"；无标记返回 None。
    """
    if _CONFIDENCE_GAP in content:
        return _CONFIDENCE_GAP
    if _CONFIDENCE_CONFIRMED in content:
        return _CONFIDENCE_CONFIRMED
    if _CONFIDENCE_INFERRED in content:
        return _CONFIDENCE_INFERRED
    return None


def _sanitize_rule_name(path: str) -> str:
    """把产物相对路径转为 rule 文件名（去扩展名、斜杠转下划线）。"""
    stem = re.sub(r"\.md$", "", path)
    stem = re.sub(r"[^A-Za-z0-9_\-\u4e00-\u9fff]+", "_", stem)
    stem = stem.strip("_")
    return stem or "artifact"


def _export_one_rule(
    project_dir: str, rel_path: str, content: str, confidence: Optional[str]
) -> Dict[str, Any]:
    """把单个产物导出为 Jarvis rule 文件。

    写入 <project>/.jarvis/rules/reversa/artifacts/<name>.md，带 front matter：
    name/description + metadata（source/confidence/exported_at）。
    覆盖式更新（决策 7：每文件一 rule + 覆盖式更新 + metadata 溯源）。
    """
    rule_name = _sanitize_rule_name(rel_path)
    rule_dir = os.path.join(project_dir, _EXPORT_RULES_DIR)
    os.makedirs(rule_dir, exist_ok=True)
    rule_path = os.path.join(rule_dir, f"{rule_name}.md")
    # 提取首行标题作为 description（若有）
    first_line = ""
    for line in content.splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            first_line = line[:120]
            break
        if line.startswith("# "):
            first_line = line[2:].strip()[:120]
            break
    front_matter = (
        "---\n"
        f"name: reversa_{rule_name}\n"
        f"description: Reversa 逆向工程产物（{rel_path}）——{first_line or '规格文档'}\n"
        "metadata:\n"
        f"  source: reversa\n"
        f"  artifact: {rel_path}\n"
        f"  confidence: {confidence or 'unknown'}\n"
        "---\n"
    )
    body = content.strip()
    with open(rule_path, "w", encoding="utf-8") as f:
        f.write(front_matter + "\n" + body + "\n")
    return {"path": rel_path, "rule_file": f"{rule_name}.md", "confidence": confidence}


def export_rules(
    project_dir: Optional[str] = None,
    include_gap: bool = False,
    include_unknown: bool = True,
) -> Dict[str, Any]:
    """把 _reversa_sdd/ 产物按置信度导出为 Jarvis rule。

    决策 8：默认只导出 🟢CONFIRMED / 🟡INFERRED，🔴GAP 不导出（可配置）。
    决策 7：每文件一 rule + 覆盖式更新 + metadata 溯源。

    返回 {"success": True, "data": {exported: [...], skipped: [...], rule_dir}}。
    """
    project_dir, err = _resolve_project(project_dir)
    if err:
        return {"success": False, "error": err}
    output_dir = os.path.join(project_dir, _DEFAULT_OUTPUT_FOLDER)
    if not os.path.isdir(output_dir):
        return {"success": False, "error": f"未找到规格产物目录: {output_dir}（请先运行 Reversa 分析）"}

    allowed = set(_DEFAULT_EXPORT_CONFIDENCES)
    if include_gap:
        allowed.add(_CONFIDENCE_GAP)

    exported: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []
    for root, _dirs, files in os.walk(output_dir):
        for fname in sorted(files):
            if not fname.endswith(".md"):
                continue
            full = os.path.join(root, fname)
            rel = os.path.relpath(full, output_dir).replace(os.sep, "/")
            try:
                with open(full, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()
            except Exception:  # noqa: BLE001
                skipped.append({"path": rel, "reason": "读取失败"})
                continue
            confidence = _detect_confidence(content)
            if confidence == _CONFIDENCE_GAP and not include_gap:
                skipped.append({"path": rel, "reason": f"置信度 {_CONFIDENCE_GAP} 未导出（可开启 include_gap）"})
                continue
            if confidence is None and not include_unknown:
                skipped.append({"path": rel, "reason": "无置信度标记且 include_unknown=False"})
                continue
            exported.append(_export_one_rule(project_dir, rel, content, confidence))

    return {
        "success": True,
        "data": {
            "exported": exported,
            "skipped": skipped,
            "rule_dir": _EXPORT_RULES_DIR,
            "rule_dir_abs": os.path.join(project_dir, _EXPORT_RULES_DIR),
        },
    }


# ---------------------------------------------------------------------------
# 知识回流（sync）：文档与代码同步维护机制（issue #5）
# ---------------------------------------------------------------------------
def _sha256_file(path: str) -> str:
    """计算文件 sha256（分块读取，避免大文件占内存）。"""
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
    except Exception:  # noqa: BLE001
        return ""
    return h.hexdigest()


def _run_git(project_dir: str, args: List[str], timeout: int = 30) -> Optional[str]:
    """在项目目录运行只读 git 命令，返回 stdout（strip 后）；失败返回 None。"""
    try:
        result = subprocess.run(
            ["git", "-C", project_dir] + args,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except Exception:  # noqa: BLE001
        return None
    if result.returncode != 0:
        return None
    return (result.stdout or "").strip()


def _git_head_commit(project_dir: str) -> Optional[str]:
    """取当前 HEAD commit（短 12 位）。非 git 仓库返回 None。"""
    return _run_git(project_dir, ["rev-parse", "--short=12", "HEAD"])


def _git_head_msg(project_dir: str) -> str:
    """取当前 HEAD commit message 首行。"""
    msg = _run_git(project_dir, ["log", "-1", "--pretty=%s"])
    return msg or ""


def _sync_file_path(project_dir: str) -> str:
    """返回基线记录文件路径（<project>/_reversa_sdd/.reversa-sync.json）。"""
    return os.path.join(project_dir, _SYNC_FILE)


def _read_sync_meta(project_dir: str) -> Dict[str, Any]:
    """读取基线记录；不存在/损坏返回空 dict。"""
    sync_path = _sync_file_path(project_dir)
    if not os.path.isfile(sync_path):
        return {}
    try:
        with open(sync_path, "r", encoding="utf-8") as f:
            parsed = json.load(f)
        if isinstance(parsed, dict):
            return parsed
    except Exception:  # noqa: BLE001
        pass
    return {}


def _write_sync_meta(project_dir: str, meta: Dict[str, Any]) -> bool:
    """原子写基线记录（先写临时文件再 rename）。"""
    sync_path = _sync_file_path(project_dir)
    os.makedirs(os.path.dirname(sync_path), exist_ok=True)
    tmp_path = sync_path + ".tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, sync_path)
        return True
    except Exception:  # noqa: BLE001
        return False


def _walk_md_files(project_dir: str) -> List[str]:
    """列出 _reversa_sdd/ 下所有 .md 产物相对路径（排序）。"""
    output_dir = os.path.join(project_dir, _DEFAULT_OUTPUT_FOLDER)
    files: List[str] = []
    if not os.path.isdir(output_dir):
        return files
    for root, _dirs, names in os.walk(output_dir):
        for fname in sorted(names):
            if not fname.endswith(".md"):
                continue
            full = os.path.join(root, fname)
            rel = os.path.relpath(full, output_dir).replace(os.sep, "/")
            files.append(rel)
    return sorted(files)


def record_sync_baseline(
    project_dir: Optional[str] = None, commit: Optional[str] = None
) -> Dict[str, Any]:
    """记录知识回流基线：当前 commit + 每个产物的内容 hash。

    供分析完成（或首次同步）后调用，把当前状态固化为基线。
    commit 缺省取当前 HEAD；非 git 仓库可用 commit 显式指定（如 "none"）。

    返回 {"success": True, "data": {base_commit, artifacts: {...}}}。
    """
    project_dir, err = _resolve_project(project_dir)
    if err:
        return {"success": False, "error": err}
    head = commit or _git_head_commit(project_dir)
    if not head:
        return {"success": False, "error": "无法获取 git HEAD（非 git 仓库？）"}
    artifacts: Dict[str, Any] = {}
    for rel in _walk_md_files(project_dir):
        abs_path = os.path.join(project_dir, _DEFAULT_OUTPUT_FOLDER, rel)
        artifacts[rel] = {
            "commit": head,
            "hash": _sha256_file(abs_path),
        }
    meta = {
        "generated_at": _now_iso(),
        "base_commit": head,
        "base_commit_msg": _git_head_msg(project_dir),
        "artifacts": artifacts,
    }
    if not _write_sync_meta(project_dir, meta):
        return {"success": False, "error": "写入基线记录失败"}
    return {"success": True, "data": {"base_commit": head, "artifacts": artifacts}}


def get_sync_status(project_dir: Optional[str] = None) -> Dict[str, Any]:
    """查看知识回流同步状态。

    对比基线 base_commit 与当前 HEAD，检测：
    - 代码是否有新提交（stale=True 表示文档可能过期）
    - 产物是否被手工编辑（hash 与基线不一致）
    - 产物是否有新增/删除

    返回 {"success": True, "data": {has_baseline, base_commit, head_commit,
    stale, changed_artifacts: [...], added_artifacts: [...], removed_artifacts: [...]}}。
    """
    project_dir, err = _resolve_project(project_dir)
    if err:
        return {"success": False, "error": err}
    meta = _read_sync_meta(project_dir)
    if not meta or not meta.get("base_commit"):
        return {
            "success": True,
            "data": {
                "has_baseline": False,
                "base_commit": None,
                "head_commit": _git_head_commit(project_dir),
                "stale": False,
                "changed_artifacts": [],
                "added_artifacts": [],
                "removed_artifacts": [],
            },
        }
    base_commit = str(meta.get("base_commit") or "")
    head_commit = _git_head_commit(project_dir)
    baseline_artifacts = meta.get("artifacts") if isinstance(meta.get("artifacts"), dict) else {}

    current: Dict[str, str] = {}
    for rel in _walk_md_files(project_dir):
        abs_path = os.path.join(project_dir, _DEFAULT_OUTPUT_FOLDER, rel)
        current[rel] = _sha256_file(abs_path)

    changed: List[str] = []
    added: List[str] = []
    removed: List[str] = []
    for rel, h in current.items():
        if rel in baseline_artifacts:
            if baseline_artifacts[rel].get("hash") != h:
                changed.append(rel)
        else:
            added.append(rel)
    for rel in baseline_artifacts:
        if rel not in current:
            removed.append(rel)

    stale = bool(head_commit) and head_commit != base_commit
    return {
        "success": True,
        "data": {
            "has_baseline": True,
            "base_commit": base_commit,
            "base_commit_msg": meta.get("base_commit_msg") or "",
            "head_commit": head_commit,
            "stale": stale,
            "changed_artifacts": changed,
            "added_artifacts": added,
            "removed_artifacts": removed,
        },
    }


def analyze_sync_diff(project_dir: Optional[str] = None) -> Dict[str, Any]:
    """分析知识回流差异：对比基线 commit 与当前 HEAD 的代码变更。

    只读 git（rev-parse / diff --stat），不修改代码仓库（决策：幂等只读）。
    结合 traceability/code-spec-matrix.md 把变更代码文件映射到受影响产物。

    返回 {"success": True, "data": {base_commit, head_commit, changed_files: [...],
    affected_artifacts: [...], diff_stat: str}}。
    """
    project_dir, err = _resolve_project(project_dir)
    if err:
        return {"success": False, "error": err}
    meta = _read_sync_meta(project_dir)
    base_commit = str(meta.get("base_commit") or "") if meta else ""
    if not base_commit:
        return {"success": False, "error": "尚无基线记录，请先 record_sync_baseline"}
    head_commit = _git_head_commit(project_dir)
    if not head_commit:
        return {"success": False, "error": "无法获取 git HEAD（非 git 仓库？）"}
    if head_commit == base_commit:
        return {
            "success": True,
            "data": {
                "base_commit": base_commit,
                "head_commit": head_commit,
                "changed_files": [],
                "affected_artifacts": [],
                "diff_stat": "",
                "up_to_date": True,
            },
        }
    # 变更文件清单（含新增/修改/删除）
    changed_files_raw = _run_git(
        project_dir, ["diff", "--name-status", f"{base_commit}..HEAD"]
    )
    changed_files: List[Dict[str, str]] = []
    if changed_files_raw:
        for line in changed_files_raw.splitlines():
            parts = line.split("\t")
            if len(parts) >= 2:
                changed_files.append(
                    {"status": parts[0], "path": parts[1]}
                )
    # diff --stat 摘要（供 Agent 参考）
    diff_stat = _run_git(
        project_dir, ["diff", "--stat", f"{base_commit}..HEAD"]
    ) or ""
    # 用 traceability/code-spec-matrix.md 把代码文件映射到受影响产物
    affected_artifacts = _map_code_to_artifacts(project_dir, changed_files)
    return {
        "success": True,
        "data": {
            "base_commit": base_commit,
            "head_commit": head_commit,
            "changed_files": changed_files,
            "affected_artifacts": affected_artifacts,
            "diff_stat": diff_stat,
            "up_to_date": False,
        },
    }


def _map_code_to_artifacts(
    project_dir: str, changed_files: List[Dict[str, str]]
) -> List[str]:
    """把变更代码文件映射到受影响的规格产物。

    读取 traceability/code-spec-matrix.md（Legacy file → unit coverage matrix），
    若存在则按映射匹配；否则回退到「变更文件所属目录名匹配产物目录名」的启发式。
    返回受影响产物相对路径列表（去重、排序）。
    """
    affected: List[str] = []
    matrix_path = os.path.join(
        project_dir, _DEFAULT_OUTPUT_FOLDER, "traceability", "code-spec-matrix.md"
    )
    matrix_lines: List[str] = []
    if os.path.isfile(matrix_path):
        try:
            with open(matrix_path, "r", encoding="utf-8", errors="replace") as f:
                matrix_lines = f.read().splitlines()
        except Exception:  # noqa: BLE001
            matrix_lines = []

    # 收集矩阵中出现的产物路径（形如 sdd/xxx/requirements.md 或 unit 名）
    matrix_artifact_terms: List[str] = []
    for line in matrix_lines:
        for m in re.finditer(r"([A-Za-z0-9_\-/]+\.md)", line):
            matrix_artifact_terms.append(m.group(1))

    for cf in changed_files:
        code_path = cf.get("path") or ""
        if not code_path:
            continue
        # 1) 矩阵映射：代码文件路径出现在矩阵行 → 该行引用的产物
        for line in matrix_lines:
            if code_path in line:
                for m in re.finditer(r"([A-Za-z0-9_\-/]+\.md)", line):
                    affected.append(m.group(1))
        # 2) 启发式：代码文件所在目录名匹配产物目录名
        code_dir = os.path.dirname(code_path).replace(os.sep, "/")
        for term in matrix_artifact_terms:
            term_dir = os.path.dirname(term)
            if term_dir and code_dir and (term_dir in code_dir or code_dir in term_dir):
                affected.append(term)
    # 去重、去重名产物、排序
    seen = set()
    result: List[str] = []
    for a in affected:
        if a in seen:
            continue
        seen.add(a)
        result.append(a)
    return sorted(result)


def _now_iso() -> str:
    """当前时间的 ISO8601 字符串（本地时区）。"""
    from datetime import datetime

    return datetime.now().astimezone().isoformat(timespec="seconds")


# 可被 gateway 代理调用的函数白名单（防止任意函数被调用）
PUBLIC_FUNCTIONS: List[str] = [
    "install_project",
    "get_status",
    "uninstall_project",
    "list_artifacts",
    "read_artifact",
    "get_skills",
    "export_rules",
    "get_dependencies",
    "set_dependencies",
    "record_sync_baseline",
    "get_sync_status",
    "analyze_sync_diff",
]
