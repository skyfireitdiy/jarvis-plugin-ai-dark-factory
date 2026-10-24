"""plugin/api.py 单元测试。

覆盖核心安全与业务逻辑（不依赖真实 Reversa 安装）：
- ACL：project_dir 必须存在、路径穿越拦截
- 产物浏览：list_artifacts / read_artifact（含越界拦截）
- 置信度过滤：默认不导出 🔴GAP，include_gap=True 时导出
- PUBLIC_FUNCTIONS 白名单完整性
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "plugin"))

import api  # noqa: E402


def _make_project(tmp_path):
    """构造一个带 _reversa_sdd/ 产物与 .agents/skills 的假项目。"""
    proj = tmp_path / "proj"
    output = proj / "_reversa_sdd"
    (output / "sdd").mkdir(parents=True)
    (output / "architecture.md").write_text(
        "# Architecture\n\n🟢CONFIRMED 架构已确认\n", encoding="utf-8"
    )
    (output / "sdd" / "domain.md").write_text(
        "# Domain\n\n🟡INFERRED 领域推断\n", encoding="utf-8"
    )
    (output / "sdd" / "gap.md").write_text(
        "# Gap\n\n🔴GAP 缺口未导出\n", encoding="utf-8"
    )
    skills = proj / ".agents" / "skills" / "reversa"
    skills.mkdir(parents=True)
    (skills / "SKILL.md").write_text(
        "---\nname: reversa\ndescription: Reversa orchestrator.\n---\n\nBody.\n",
        encoding="utf-8",
    )
    return str(proj)


def test_public_functions_whitelist():
    """PUBLIC_FUNCTIONS 白名单包含全部功能且均可调用。"""
    expected = {
        "check_project",
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
        "list_nlspecs",
        "get_nlspec",
    }
    assert set(api.PUBLIC_FUNCTIONS) == expected
    for fn in api.PUBLIC_FUNCTIONS:
        assert callable(getattr(api, fn, None))


def test_project_dir_required():
    """project_dir 缺失/不存在时返回错误。"""
    r = api.get_status(None)
    assert r["success"] is False
    assert "project_dir" in r["error"]

    r = api.get_status("/nonexistent/path/xyz")
    assert r["success"] is False
    assert "不存在" in r["error"]


def test_install_project_passes_language_args(tmp_path, monkeypatch):
    """install_project 把文档/交互语言透传给 bridge（默认中文）。"""
    proj = tmp_path / "proj"
    proj.mkdir()
    captured = {}

    def fake_run_bridge(args, timeout=300):
        captured["args"] = args
        return {"success": True, "data": {"version": "1.0.0", "agents": 6}}

    monkeypatch.setattr(api, "_run_bridge", fake_run_bridge)

    # 默认值：doc_language=中文、chat_language=zh-cn
    r = api.install_project(str(proj))
    assert r["success"] is True
    args = captured["args"]
    assert _arg_value(args, "--doc_language") == "中文"
    assert _arg_value(args, "--chat_language") == "zh-cn"

    # 显式传参覆盖默认值
    api.install_project(str(proj), doc_language="English", chat_language="en")
    args = captured["args"]
    assert _arg_value(args, "--doc_language") == "English"
    assert _arg_value(args, "--chat_language") == "en"


def _arg_value(args, flag):
    """取 `--flag value` 形式的参数值。"""
    idx = args.index(flag)
    return args[idx + 1]


def test_list_artifacts_tree(tmp_path):
    """list_artifacts 返回产物文件树。"""
    proj = _make_project(tmp_path)
    r = api.list_artifacts(proj)
    assert r["success"] is True
    files = r["data"]["files"]
    names = [f["name"] for f in files]
    assert "architecture.md" in names
    assert "sdd" in names


def test_list_artifacts_returns_abs_path(tmp_path):
    """list_artifacts 为每个节点返回宿主机绝对路径，供前端直接打开。"""
    proj = _make_project(tmp_path)
    r = api.list_artifacts(proj)
    assert r["success"] is True
    assert r["data"]["output_folder"] == "_reversa_sdd"
    assert r["data"]["output_dir"] == os.path.join(proj, "_reversa_sdd")
    arch = next(f for f in r["data"]["files"] if f["name"] == "architecture.md")
    assert arch["abs_path"] == os.path.join(proj, "_reversa_sdd", "architecture.md")
    assert os.path.isfile(arch["abs_path"])


def _write_state(proj, output_folder):
    """.reversa/state.json 记录安装时的 output_folder。"""
    state_dir = Path(proj) / ".reversa"
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "state.json").write_text(
        json.dumps({"output_folder": output_folder}), encoding="utf-8"
    )


def test_output_folder_follows_state_json(tmp_path):
    """产物目录以 state.json 的 output_folder 为准（安装时可自定义）。"""
    proj = _make_project(tmp_path)
    custom = os.path.join(proj, "docs", "spec")
    os.makedirs(custom)
    with open(os.path.join(custom, "custom.md"), "w", encoding="utf-8") as f:
        f.write("# Custom\n")
    _write_state(proj, "docs/spec")

    r = api.list_artifacts(proj)
    assert r["success"] is True
    assert r["data"]["output_folder"] == "docs/spec"
    assert r["data"]["output_dir"] == custom
    names = [f["name"] for f in r["data"]["files"]]
    assert names == ["custom.md"]

    r = api.read_artifact(proj, "custom.md")
    assert r["success"] is True
    assert r["data"]["abs_path"] == os.path.join(custom, "custom.md")


def test_output_folder_rejects_escape(tmp_path):
    """state.json 的 output_folder 为绝对路径/含 .. 时回退默认目录。"""
    proj = _make_project(tmp_path)
    for bad in ("/etc", "../outside"):
        _write_state(proj, bad)
        assert api._output_folder(proj) == "_reversa_sdd"


def test_read_artifact_and_path_traversal(tmp_path):
    """read_artifact 读取正常文件，拦截路径穿越。"""
    proj = _make_project(tmp_path)
    r = api.read_artifact(proj, "architecture.md")
    assert r["success"] is True
    assert "🟢CONFIRMED" in r["data"]["content"]

    r = api.read_artifact(proj, "../../etc/passwd")
    assert r["success"] is False
    assert "越界" in r["error"]

    r = api.read_artifact(proj, "sdd/domain.md")
    assert r["success"] is True
    assert "🟡INFERRED" in r["data"]["content"]


def test_export_rules_confidence_filter(tmp_path):
    """默认不导出 🔴GAP；include_gap=True 时导出。"""
    proj = _make_project(tmp_path)
    r = api.export_rules(proj)
    assert r["success"] is True
    exported = r["data"]["exported"]
    skipped = r["data"]["skipped"]
    # 3 个产物：architecture(CONFIRMED) + domain(INFERRED) 导出，gap(GAP) 跳过
    assert len(exported) == 2
    assert len(skipped) == 1
    assert skipped[0]["path"] == "sdd/gap.md"
    assert "🔴GAP" in skipped[0]["reason"]

    r2 = api.export_rules(proj, include_gap=True)
    assert len(r2["data"]["exported"]) == 3
    assert r2["data"]["skipped"] == []


def test_export_rules_writes_rule_files(tmp_path):
    """导出产物生成带 metadata 溯源的 rule 文件。"""
    proj = _make_project(tmp_path)
    r = api.export_rules(proj)
    assert r["success"] is True
    rule_dir = os.path.join(proj, ".jarvis", "rules", "reversa", "artifacts")
    assert os.path.isdir(rule_dir)
    # architecture.md -> architecture.md（文件名 = 产物名，front matter name 带 reversa_ 前缀）
    rule_file = os.path.join(rule_dir, "architecture.md")
    assert os.path.isfile(rule_file)
    content = open(rule_file, encoding="utf-8").read()
    assert "name: reversa_architecture" in content
    assert "source: reversa" in content
    assert "artifact: architecture.md" in content
    assert "confidence: 🟢CONFIRMED" in content


def test_get_skills(tmp_path):
    """get_skills 列出已安装 skills。"""
    proj = _make_project(tmp_path)
    r = api.get_skills(proj)
    assert r["success"] is True
    assert len(r["data"]["skills"]) == 1
    assert r["data"]["skills"][0]["agent"] == "reversa"
    assert r["data"]["skills"][0]["exists"] is True


def test_get_dependencies_empty(tmp_path):
    """未配置依赖时 get_dependencies 返回空列表（不报错）。"""
    proj = _make_project(tmp_path)
    r = api.get_dependencies(proj)
    assert r["success"] is True
    assert r["data"]["dependencies"] == []


def test_set_get_dependencies_roundtrip(tmp_path):
    """set_dependencies 写入后 get_dependencies 往返一致。"""
    proj = _make_project(tmp_path)
    upstream = tmp_path / "upstream"
    upstream.mkdir()
    deps = [
        {"path": str(upstream), "name": "上游库", "note": "提供 API 定义"},
    ]
    r = api.set_dependencies(proj, deps)
    assert r["success"] is True
    assert r["data"]["dependencies"] == [
        {"path": str(upstream), "name": "上游库", "note": "提供 API 定义"}
    ]
    # 写入位置：<project>/.jarvis/reversa/deps.json
    deps_file = os.path.join(proj, ".jarvis", "reversa", "deps.json")
    assert os.path.isfile(deps_file)
    r2 = api.get_dependencies(proj)
    assert r2["success"] is True
    assert r2["data"]["dependencies"] == [
        {"path": str(upstream), "name": "上游库", "note": "提供 API 定义"}
    ]


def test_set_dependencies_validates_path(tmp_path):
    """set_dependencies 校验依赖路径必须为已存在目录。"""
    proj = _make_project(tmp_path)
    r = api.set_dependencies(proj, [{"path": "/nonexistent/upstream"}])
    assert r["success"] is False
    assert "不存在" in r["error"]

    r2 = api.set_dependencies(proj, [{"path": ""}])
    assert r2["success"] is False
    assert "path" in r2["error"]

    r3 = api.set_dependencies(proj, "not-a-list")
    assert r3["success"] is False
    assert "数组" in r3["error"]


# ---------------------------------------------------------------------------
# 知识回流（sync）
# ---------------------------------------------------------------------------
def _make_git_project(tmp_path):
    """构造一个 git 仓库项目，含 _reversa_sdd/ 产物与 traceability 矩阵。"""
    import subprocess

    proj = tmp_path / "gitproj"
    proj.mkdir()
    # 初始化 git 仓库
    subprocess.run(["git", "init", "-q", str(proj)], check=True)
    subprocess.run(
        ["git", "-C", str(proj), "config", "user.email", "test@example.com"], check=True
    )
    subprocess.run(
        ["git", "-C", str(proj), "config", "user.name", "Test"], check=True
    )
    # 代码文件
    (proj / "src").mkdir()
    (proj / "src" / "auth.py").write_text("def login():\n    pass\n", encoding="utf-8")
    # 产物
    output = proj / "_reversa_sdd"
    (output / "traceability").mkdir(parents=True)
    (output / "architecture.md").write_text(
        "# Architecture\n\n🟢CONFIRMED 架构已确认\n", encoding="utf-8"
    )
    (output / "traceability" / "code-spec-matrix.md").write_text(
        "# Code-Spec Matrix\n\n| Legacy file | Unit |\n|---|---|\n"
        "| src/auth.py | sdd/auth/requirements.md |\n",
        encoding="utf-8",
    )
    # 首次提交
    subprocess.run(["git", "-C", str(proj), "add", "-A"], check=True)
    subprocess.run(
        ["git", "-C", str(proj), "commit", "-q", "-m", "init"], check=True
    )
    return str(proj)


def test_record_sync_baseline(tmp_path):
    """record_sync_baseline 记录当前 commit 与产物 hash。"""
    proj = _make_git_project(tmp_path)
    r = api.record_sync_baseline(proj)
    assert r["success"] is True
    assert r["data"]["base_commit"]
    assert "architecture.md" in r["data"]["artifacts"]
    # 基线文件写入 _reversa_sdd/.reversa-sync.json
    sync_file = os.path.join(proj, "_reversa_sdd", ".reversa-sync.json")
    assert os.path.isfile(sync_file)
    meta = json.load(open(sync_file, encoding="utf-8"))
    assert meta["base_commit"] == r["data"]["base_commit"]
    assert "traceability/code-spec-matrix.md" in meta["artifacts"]


def test_get_sync_status_no_baseline(tmp_path):
    """无基线时 get_sync_status 返回 has_baseline=False。"""
    proj = _make_git_project(tmp_path)
    r = api.get_sync_status(proj)
    assert r["success"] is True
    assert r["data"]["has_baseline"] is False
    assert r["data"]["head_commit"]


def test_get_sync_status_stale_and_changed(tmp_path):
    """基线后代码有新提交 → stale=True；产物被手工编辑 → changed_artifacts。"""
    import subprocess

    proj = _make_git_project(tmp_path)
    api.record_sync_baseline(proj)
    # 修改产物（手工编辑）
    arch = os.path.join(proj, "_reversa_sdd", "architecture.md")
    with open(arch, "a", encoding="utf-8") as f:
        f.write("\n手工补充\n")
    # 新增代码提交
    with open(os.path.join(proj, "src", "auth.py"), "a", encoding="utf-8") as f:
        f.write("def logout():\n    pass\n")
    subprocess.run(["git", "-C", proj, "add", "-A"], check=True)
    subprocess.run(["git", "-C", proj, "commit", "-q", "-m", "add logout"], check=True)

    r = api.get_sync_status(proj)
    assert r["success"] is True
    d = r["data"]
    assert d["has_baseline"] is True
    assert d["stale"] is True
    assert "architecture.md" in d["changed_artifacts"]


def test_analyze_sync_diff_maps_artifacts(tmp_path):
    """analyze_sync_diff 通过 traceability 矩阵把代码变更映射到受影响产物。"""
    import subprocess

    proj = _make_git_project(tmp_path)
    api.record_sync_baseline(proj)
    # 修改 src/auth.py（矩阵映射到 sdd/auth/requirements.md）
    with open(os.path.join(proj, "src", "auth.py"), "a", encoding="utf-8") as f:
        f.write("def reset():\n    pass\n")
    subprocess.run(["git", "-C", proj, "add", "-A"], check=True)
    subprocess.run(["git", "-C", proj, "commit", "-q", "-m", "add reset"], check=True)

    r = api.analyze_sync_diff(proj)
    assert r["success"] is True
    d = r["data"]
    assert d["up_to_date"] is False
    assert any(cf["path"] == "src/auth.py" for cf in d["changed_files"])
    assert "sdd/auth/requirements.md" in d["affected_artifacts"]


def test_analyze_sync_diff_up_to_date(tmp_path):
    """基线后无代码变更 → up_to_date=True。"""
    proj = _make_git_project(tmp_path)
    api.record_sync_baseline(proj)
    r = api.analyze_sync_diff(proj)
    assert r["success"] is True
    assert r["data"]["up_to_date"] is True
    assert r["data"]["changed_files"] == []


def test_get_sync_status_baseline_pending(tmp_path):
    """无基线但有产物且是 git 仓库 → baseline_pending=True（可自动补录）。"""
    proj = _make_git_project(tmp_path)
    r = api.get_sync_status(proj)
    assert r["success"] is True
    d = r["data"]
    assert d["has_baseline"] is False
    assert d["baseline_pending"] is True


def test_get_sync_status_baseline_pending_no_artifacts(tmp_path):
    """无基线且无产物 → baseline_pending=False（无需补录）。"""
    import subprocess

    proj = tmp_path / "emptyproj"
    proj.mkdir()
    subprocess.run(["git", "init", "-q", str(proj)], check=True)
    subprocess.run(
        ["git", "-C", str(proj), "config", "user.email", "test@example.com"], check=True
    )
    subprocess.run(
        ["git", "-C", str(proj), "config", "user.name", "Test"], check=True
    )
    (proj / "src").mkdir()
    (proj / "src" / "main.py").write_text("print(1)\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(proj), "add", "-A"], check=True)
    subprocess.run(
        ["git", "-C", str(proj), "commit", "-q", "-m", "init"], check=True
    )
    r = api.get_sync_status(str(proj))
    assert r["success"] is True
    d = r["data"]
    assert d["has_baseline"] is False
    assert d["baseline_pending"] is False


# ---------------------------------------------------------------------------
# NLSpec 管理（issue #14）：固定位置 .jarvis/.df/specs/
# ---------------------------------------------------------------------------
def _make_nlspec_project(tmp_path):
    """构造一个带 NLSpec 固定目录的项目。"""
    proj = tmp_path / "nlspecproj"
    specs = proj / ".jarvis" / ".df" / "specs"
    specs.mkdir(parents=True)
    (specs / "auth.md").write_text(
        "# 登录功能\n\n## Goal\n实现登录。\n\n## Constraints\nOAuth2。\n\n"
        "## Interfaces\nPOST /login。\n\n## Non-goals\n不做注册。\n",
        encoding="utf-8",
    )
    (specs / "report.md").write_text(
        "# 报表导出\n\n## Goal\n导出报表。\n", encoding="utf-8"
    )
    return str(proj)


def test_list_nlspecs_empty(tmp_path):
    """无 NLSpec 目录时 list_nlspecs 返回空列表（不报错）。"""
    proj = tmp_path / "emptyproj"
    proj.mkdir()
    r = api.list_nlspecs(str(proj))
    assert r["success"] is True
    assert r["data"]["specs"] == []


def test_list_nlspecs_lists_specs(tmp_path):
    """list_nlspecs 列出固定目录下 .md spec，含标题与更新时间。"""
    proj = _make_nlspec_project(tmp_path)
    r = api.list_nlspecs(proj)
    assert r["success"] is True
    specs = r["data"]["specs"]
    names = [s["name"] for s in specs]
    assert names == ["auth.md", "report.md"]  # 排序
    auth = next(s for s in specs if s["name"] == "auth.md")
    assert auth["title"] == "登录功能"
    assert auth["size"] > 0
    assert auth["updated_at"] > 0
    # 非 .md 文件被忽略
    notes = os.path.join(proj, ".jarvis", ".df", "specs", "notes.txt")
    with open(notes, "w", encoding="utf-8") as f:
        f.write("x")
    r2 = api.list_nlspecs(proj)
    assert [s["name"] for s in r2["data"]["specs"]] == ["auth.md", "report.md"]


def test_get_nlspec_reads_content(tmp_path):
    """get_nlspec 读取单个 spec 内容与标题。"""
    proj = _make_nlspec_project(tmp_path)
    r = api.get_nlspec(proj, "auth.md")
    assert r["success"] is True
    d = r["data"]
    assert d["exists"] is True
    assert d["name"] == "auth.md"
    assert d["title"] == "登录功能"
    assert "## Goal" in d["content"]
    assert "## Non-goals" in d["content"]


def test_get_nlspec_not_found(tmp_path):
    """get_nlspec 读取不存在的 spec 返回 exists=False（不报错）。"""
    proj = _make_nlspec_project(tmp_path)
    r = api.get_nlspec(proj, "missing.md")
    assert r["success"] is True
    assert r["data"]["exists"] is False
    assert r["data"]["content"] == ""


def test_get_nlspec_path_traversal_blocked(tmp_path):
    """get_nlspec 拦截路径穿越：绝对路径 / 父目录 / 分隔符。"""
    proj = _make_nlspec_project(tmp_path)
    for bad in ["../../etc/passwd", "/etc/passwd", "a/b.md", "..\\evil.md"]:
        r = api.get_nlspec(proj, bad)
        assert r["success"] is False, f"应拦截: {bad}"
        assert "非法" in r["error"] or "未指定" in r["error"]


def test_get_nlspec_requires_name(tmp_path):
    """get_nlspec 缺 name 时报错。"""
    proj = _make_nlspec_project(tmp_path)
    r = api.get_nlspec(proj, None)
    assert r["success"] is False
    assert "name" in r["error"]


def test_check_project_flags(tmp_path):
    """check_project 返回目录存在性、git 仓库、reversa 状态等前置标记。"""
    proj = tmp_path / "proj"
    proj.mkdir()
    r = api.check_project(str(proj))
    assert r["success"] is True
    d = r["data"]
    assert d["exists"] is True
    assert d["is_dir"] is True
    assert d["is_git"] is False
    assert d["has_reversa_state"] is False
    assert d["has_output"] is False

    (proj / ".git").mkdir()
    (proj / ".reversa").mkdir()
    (proj / ".reversa" / "state.json").write_text("{}", encoding="utf-8")
    (proj / "_reversa_sdd").mkdir()
    d = api.check_project(str(proj))["data"]
    assert d["is_git"] is True
    assert d["has_reversa_state"] is True
    assert d["has_output"] is True


def test_check_project_missing_dir_not_error(tmp_path):
    """目录不存在时 success 仍为 True，用 exists=False 表达（供前端提示）。"""
    missing = str(tmp_path / "nope")
    r = api.check_project(missing)
    assert r["success"] is True
    assert r["data"]["exists"] is False
    assert r["data"]["is_git"] is False


def test_check_project_requires_project_dir():
    """check_project 缺 project_dir 时报错。"""
    r = api.check_project(None)
    assert r["success"] is False
    assert "project_dir" in r["error"]
