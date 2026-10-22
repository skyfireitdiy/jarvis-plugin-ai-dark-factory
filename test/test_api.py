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


def test_list_artifacts_tree(tmp_path):
    """list_artifacts 返回产物文件树。"""
    proj = _make_project(tmp_path)
    r = api.list_artifacts(proj)
    assert r["success"] is True
    files = r["data"]["files"]
    names = [f["name"] for f in files]
    assert "architecture.md" in names
    assert "sdd" in names


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
