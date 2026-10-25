# -*- coding: utf-8 -*-
"""AI 黑灯工厂插件（ai-dark-factory）测试。

覆盖：
1. 2 个工具（holdout_generator / gate_calculator）的正常、边界、异常场景；
2. 编排模板 dark_factory_pipeline.yaml 的格式（agents 列表、flow 字段、四要素齐全）；
3. config.yaml 的可解析性与声明完整性（含 clarify 指令模板）。

本测试从插件仓库根目录直接加载源码（plugin_dir fixture 指向仓库根），
不依赖外部 clone 或 Jarvis 主仓库环境。
"""

import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest
import yaml

PLUGIN_DIR = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="session")
def plugin_dir():
    """返回 ai-dark-factory 插件源码目录（仓库根）。"""
    assert (PLUGIN_DIR / "config.yaml").is_file(), f"插件目录无效: {PLUGIN_DIR}"
    return PLUGIN_DIR


def _load_tool_class(plugin_dir: Path, module_name: str, filename: str):
    """用 importlib 加载插件工具文件，返回其中的 Tool 类。"""
    file_path = plugin_dir / "tools" / filename
    assert file_path.is_file(), f"工具文件不存在: {file_path}"
    spec = importlib.util.spec_from_file_location(module_name, str(file_path))
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = mod
    spec.loader.exec_module(mod)
    for attr in dir(mod):
        if attr.endswith("Tool"):
            cls = getattr(mod, attr)
            if isinstance(cls, type):
                return cls
    raise AssertionError(f"{filename} 中未找到 Tool 类")


@pytest.fixture(scope="module")
def holdout_generator(plugin_dir):
    return _load_tool_class(plugin_dir, "df_holdout_generator", "holdout_generator.py")()


@pytest.fixture(scope="module")
def gate_calculator(plugin_dir):
    return _load_tool_class(plugin_dir, "df_gate_calculator", "gate_calculator.py")()


@pytest.fixture(scope="module")
def set_nlspec_status_tool(plugin_dir):
    return _load_tool_class(plugin_dir, "df_set_nlspec_status", "set_nlspec_status.py")()


class TestToolInterface:
    """工具接口完备性（name/description/parameters/check/execute）。"""

    @pytest.mark.parametrize(
        "tool_name,filename",
        [
            ("holdout_generator", "holdout_generator.py"),
            ("gate_calculator", "gate_calculator.py"),
            ("set_nlspec_status", "set_nlspec_status.py"),
        ],
    )
    def test_interface_complete(self, plugin_dir, tool_name, filename):
        cls = _load_tool_class(plugin_dir, f"iface_{tool_name}", filename)
        tool = cls()
        assert tool.name == tool_name, f"{tool_name} name 不匹配"
        assert tool.description
        assert isinstance(tool.parameters, dict)
        assert callable(tool.check)
        assert callable(tool.execute)
        assert tool.check() is True


class TestHoldoutGenerator:
    """holdout scenarios 生成工具。"""

    def test_generate_default_count(self, holdout_generator):
        r = holdout_generator.execute({"feature": "计算器"})
        assert r["success"] is True
        out = json.loads(r["stdout"])
        assert out["count"] == 5
        assert len(out["scenarios"]) == 5
        # 每个场景必须标记 hidden（编码侧不可见）
        assert all(s["hidden"] is True for s in out["scenarios"])

    def test_generate_specific_count(self, holdout_generator):
        r = holdout_generator.execute({"feature": "计算器", "count": 3})
        out = json.loads(r["stdout"])
        assert out["count"] == 3
        assert len(out["scenarios"]) == 3

    def test_count_clamped_upper(self, holdout_generator):
        r = holdout_generator.execute({"feature": "x", "count": 999})
        out = json.loads(r["stdout"])
        assert out["count"] == 20

    def test_count_clamped_lower(self, holdout_generator):
        r = holdout_generator.execute({"feature": "x", "count": 0})
        out = json.loads(r["stdout"])
        assert out["count"] == 1

    def test_missing_feature(self, holdout_generator):
        r = holdout_generator.execute({})
        assert r["success"] is False


class TestGateCalculator:
    """门禁指标计算工具。"""

    def test_pass_rate_above_threshold(self, gate_calculator):
        r = gate_calculator.execute(
            {"results": [{"id": 1, "pass": True}, {"id": 2, "pass": True}, {"id": 3, "pass": True}]}
        )
        out = json.loads(r["stdout"])
        assert out["pass_rate"] == 1.0
        assert out["meets_threshold"] is True
        assert "建议通过" in out["decision"]

    def test_pass_rate_below_threshold(self, gate_calculator):
        r = gate_calculator.execute(
            {"results": [{"id": 1, "pass": True}, {"id": 2, "pass": True}, {"id": 3, "pass": False}]}
        )
        out = json.loads(r["stdout"])
        # 工具将 pass_rate 四舍五入到 4 位小数
        assert out["pass_rate"] == pytest.approx(2 / 3, abs=0.0001)
        assert out["meets_threshold"] is False

    def test_caution_high_false_positive(self, gate_calculator):
        r = gate_calculator.execute(
            {
                "results": [{"id": 1, "pass": True}, {"id": 2, "pass": True}],
                "false_positives": 2,
            }
        )
        out = json.loads(r["stdout"])
        assert out["caution"] is True

    def test_empty_results(self, gate_calculator):
        r = gate_calculator.execute({"results": []})
        assert r["success"] is False

    def test_missing_results(self, gate_calculator):
        r = gate_calculator.execute({})
        assert r["success"] is False


class TestSetNlspecStatusTool:
    """set_nlspec_status agent 工具（自动标记 NLSpec 完成状态）。"""

    def _make_proj(self, tmp_path):
        proj = tmp_path / "nlspecproj"
        specs = proj / ".jarvis" / ".df" / "specs"
        specs.mkdir(parents=True)
        (specs / "auth.md").write_text(
            "# 登录功能\n\n## Goal\n实现登录。\n", encoding="utf-8"
        )
        return str(proj)

    def test_mark_completed_by_agent(self, set_nlspec_status_tool, tmp_path):
        """agent 调用标记 completed，by=agent，写入 history。"""
        proj = self._make_proj(tmp_path)
        r = set_nlspec_status_tool.execute(
            {"project_dir": proj, "name": "auth.md", "status": "completed"}
        )
        assert r["success"] is True
        out = json.loads(r["stdout"])
        assert out["success"] is True
        assert out["data"] == {"name": "auth.md", "status": "completed"}
        text = open(
            os.path.join(proj, ".jarvis", ".df", "specs", "auth.md"), encoding="utf-8"
        ).read()
        assert "history:" in text
        assert "by: agent" in text

    def test_mark_completed_by_explicit(self, set_nlspec_status_tool, tmp_path):
        """显式传 by=manual 时透传。"""
        proj = self._make_proj(tmp_path)
        r = set_nlspec_status_tool.execute(
            {"project_dir": proj, "name": "auth.md", "status": "completed", "by": "manual"}
        )
        assert r["success"] is True
        text = open(
            os.path.join(proj, ".jarvis", ".df", "specs", "auth.md"), encoding="utf-8"
        ).read()
        assert "by: manual" in text

    def test_missing_args(self, set_nlspec_status_tool):
        """缺必填参数报错。"""
        r = set_nlspec_status_tool.execute({})
        assert r["success"] is False
        assert "project_dir" in r["stderr"] or "name" in r["stderr"] or "status" in r["stderr"]

    def test_invalid_status(self, set_nlspec_status_tool, tmp_path):
        """非法状态报错（透传 api 错误语义）。"""
        proj = self._make_proj(tmp_path)
        r = set_nlspec_status_tool.execute(
            {"project_dir": proj, "name": "auth.md", "status": "bogus"}
        )
        assert r["success"] is False
        assert "状态" in r["stderr"]

    def test_missing_file(self, set_nlspec_status_tool, tmp_path):
        """文件不存在报错。"""
        proj = self._make_proj(tmp_path)
        r = set_nlspec_status_tool.execute(
            {"project_dir": proj, "name": "missing.md", "status": "completed"}
        )
        assert r["success"] is False
        assert "不存在" in r["stderr"]


class TestOrchestrationTemplate:
    """预置编排模板 dark_factory_pipeline.yaml 格式。"""

    def _load(self, plugin_dir):
        path = plugin_dir / "orchestration" / "dark_factory_pipeline.yaml"
        assert path.is_file(), "编排模板不存在"
        with open(path, encoding="utf-8") as f:
            return yaml.safe_load(f)

    def test_has_all_layer_agents(self, plugin_dir):
        data = self._load(plugin_dir)
        assert "agents" in data
        agents = data["agents"]
        assert len(agents) == 7
        names = [a["name"] for a in agents]
        # 架构：planner / holdout / generator / validator / regression / orchestrator / sync
        assert "df_planner" in names
        assert "df_holdout" in names
        assert "df_generator" in names
        assert "df_validator" in names
        assert "df_regression" in names
        assert "df_orchestrator" in names
        assert "df_sync" in names

    def test_each_agent_has_required_fields(self, plugin_dir):
        """每个 agent 必须声明 name / working_dir / task（不含 type）。

        编排系统忽略阶段 type 字段，阶段 Agent 一律按 type: agent → jvs 创建，
        因此模板 agent 无需声明 type。
        """
        data = self._load(plugin_dir)
        for a in data["agents"]:
            assert a.get("name"), "agent 缺 name"
            assert a.get("working_dir"), "agent 缺 working_dir"
            assert a.get("task"), "agent 缺 task"

    def test_orchestrator_not_auto_merge(self, plugin_dir):
        """编排器（orchestrator）应强调人工审批，不自动合并（不完全无人值守）。"""
        data = self._load(plugin_dir)
        orch = next(a for a in data["agents"] if a["name"] == "df_orchestrator")
        task = orch["task"]
        assert "人工审批" in task or "不自动合并" in task or "审批" in task

    def test_has_flow_field(self, plugin_dir):
        """编排模板声明 flow（供 pipeline_runner 驱动）。"""
        data = self._load(plugin_dir)
        assert "flow" in data, "编排模板缺 flow 字段"
        assert isinstance(data["flow"], list) and data["flow"]
        stages = [s["stage"] for s in data["flow"]]
        # 按序：planner → holdout → generator → validator → regression → orchestrator → sync
        assert stages == [
            "planner",
            "holdout",
            "generator",
            "validator",
            "regression",
            "orchestrator",
            "sync",
        ]

    def test_flow_agents_referenced(self, plugin_dir):
        """flow 每个 stage 引用的 agent 必须存在于 agents 中。"""
        data = self._load(plugin_dir)
        names = {a["name"] for a in data["agents"]}
        for s in data["flow"]:
            assert s.get("agent") in names, f"flow 引用未定义 agent: {s.get('agent')}"

    def test_orchestrator_is_gate(self, plugin_dir):
        """orchestrator 阶段应为门禁（gate: true），停住等人工审批。"""
        data = self._load(plugin_dir)
        orch_stage = next(s for s in data["flow"] if s["stage"] == "orchestrator")
        assert orch_stage.get("gate") is True

    def test_generator_no_isolated_output(self, plugin_dir):
        """generator 阶段应无独立代码目录产物（在已有代码库中直接修改）。"""
        data = self._load(plugin_dir)
        gen_stage = next(s for s in data["flow"] if s["stage"] == "generator")
        assert "output" not in gen_stage, "generator 不应有独立 output 目录"
        assert gen_stage.get("input") == ".jarvis/.df/plan.md"

    def test_holdout_stage_exists(self, plugin_dir):
        """holdout 阶段生成隐藏验收场景，产物 .jarvis/.df/holdout.json。"""
        data = self._load(plugin_dir)
        ho = next(s for s in data["flow"] if s["stage"] == "holdout")
        assert ho.get("output") == ".jarvis/.df/holdout.json"
        assert ho.get("agent") == "df_holdout"

    def test_holdout_isolated_from_generator(self, plugin_dir):
        """holdout 产物只传 validator，绝不注入 generator（隔离纪律）。"""
        data = self._load(plugin_dir)
        gen_stage = next(s for s in data["flow"] if s["stage"] == "generator")
        gen_inputs = gen_stage.get("input")
        gen_inputs = gen_inputs if isinstance(gen_inputs, list) else [gen_inputs]
        assert ".jarvis/.df/holdout.json" not in gen_inputs, "holdout 不得注入 generator"
        val_stage = next(s for s in data["flow"] if s["stage"] == "validator")
        val_inputs = val_stage.get("input")
        val_inputs = val_inputs if isinstance(val_inputs, list) else [val_inputs]
        assert ".jarvis/.df/holdout.json" in val_inputs, "validator 应消费 holdout 场景"

    def test_regression_stage_exists(self, plugin_dir):
        """regression 阶段跑既有测试防回归，失败即中止。"""
        data = self._load(plugin_dir)
        reg = next(s for s in data["flow"] if s["stage"] == "regression")
        assert reg.get("agent") == "df_regression"
        assert reg.get("output") == ".jarvis/.df/regression.json"
        assert reg.get("on_error") == "abort"

    def test_sync_stage_exists(self, plugin_dir):
        """sync 阶段在门禁后回流知识，失败不阻断流水线。"""
        data = self._load(plugin_dir)
        sync = next(s for s in data["flow"] if s["stage"] == "sync")
        assert sync.get("agent") == "df_sync"
        assert sync.get("on_error") == "continue"


class TestPluginConfig:
    """插件 config.yaml 声明完整性。"""

    def _load(self, plugin_dir):
        path = plugin_dir / "config.yaml"
        assert path.is_file(), "config.yaml 不存在"
        with open(path, encoding="utf-8") as f:
            return yaml.safe_load(f)

    def test_metadata_complete(self, plugin_dir):
        cfg = self._load(plugin_dir)
        # 方案 B：id 为唯一标识（=目录名），name 为展示名
        assert cfg.get("id") == "ai-dark-factory"
        assert cfg.get("name") == "AI Agent 黑灯工厂"
        assert cfg.get("description")
        assert cfg.get("version")
        # 独立仓库插件不再声明 builtin（内置标记已随迁移移除）
        assert cfg.get("builtin") is None or cfg.get("builtin") is False

    def test_declares_rules_and_tools_dirs(self, plugin_dir):
        cfg = self._load(plugin_dir)
        assert cfg.get("rules_load_dirs"), "缺 rules_load_dirs"
        assert cfg.get("tool_load_dirs"), "缺 tool_load_dirs"

    def test_declares_orchestration(self, plugin_dir):
        cfg = self._load(plugin_dir)
        orch = cfg.get("orchestration")
        assert isinstance(orch, list) and orch
        entry = orch[0]
        assert entry.get("name") == "dark-factory-pipeline"
        assert entry.get("file")

    def test_declares_replace_map(self, plugin_dir):
        cfg = self._load(plugin_dir)
        rm = cfg.get("replace_map")
        assert isinstance(rm, dict)
        assert "dark-factory/clarify" in rm
        assert "dark-factory/run" in rm
        assert "dark-factory/issue" in rm
        assert "dark-factory/pr" in rm

    def test_clarify_template_mentions_llm_questioning(self, plugin_dir):
        """clarify 模板应引导 LLM 逐条提问澄清，而非启发式工具。"""
        cfg = self._load(plugin_dir)
        tmpl = cfg["replace_map"]["dark-factory/clarify"]["template"]
        assert "提问" in tmpl
        assert "spec_validator" not in tmpl

    def test_templates_reference_fixed_spec_dir(self, plugin_dir):
        """四模板均应把 NLSpec 落盘/读取到固定目录 .jarvis/.df/specs/。"""
        cfg = self._load(plugin_dir)
        for key in ["dark-factory/clarify", "dark-factory/run", "dark-factory/issue", "dark-factory/pr"]:
            tmpl = cfg["replace_map"][key]["template"]
            assert ".jarvis/.df/specs/" in tmpl, f"{key} 模板未引用固定 spec 目录"
            assert "spec_validator" not in tmpl, f"{key} 模板不应依赖 spec_validator"

    def test_run_templates_read_fixed_spec(self, plugin_dir):
        """run/issue/pr 模板应引导先 read_code 读取固定 NLSpec 文件再写入编排 spec。"""
        cfg = self._load(plugin_dir)
        for key in ["dark-factory/run", "dark-factory/issue", "dark-factory/pr"]:
            tmpl = cfg["replace_map"][key]["template"]
            assert "read_code" in tmpl, f"{key} 模板未引导读取固定 spec"
            assert ".jarvis/.df/specs/" in tmpl, f"{key} 模板未引用固定 spec 目录"

    def test_quick_template_marks_completed(self, plugin_dir):
        """quick 模板末尾追加 set_nlspec_status 标记 completed 步骤。"""
        cfg = self._load(plugin_dir)
        tmpl = cfg["replace_map"]["dark-factory/quick"]["template"]
        assert "set_nlspec_status" in tmpl, "quick 模板应引导调用 set_nlspec_status 工具"
        assert "completed" in tmpl, "quick 模板应标记为 completed"
        assert "by=agent" in tmpl, "quick 模板应传 by=agent"

    def test_run_template_marks_completed_after_approval(self, plugin_dir):
        """run 模板在人工审批通过后追加标记 completed 步骤。"""
        cfg = self._load(plugin_dir)
        tmpl = cfg["replace_map"]["dark-factory/run"]["template"]
        assert "set_nlspec_status" in tmpl, "run 模板应引导调用 set_nlspec_status 工具"
        assert "by=agent" in tmpl, "run 模板应传 by=agent"

    def test_issue_pr_templates_mark_completed_after_approval(self, plugin_dir):
        """issue/pr 模板在人工审批通过后追加标记 completed 步骤。"""
        cfg = self._load(plugin_dir)
        for key in ["dark-factory/issue", "dark-factory/pr"]:
            tmpl = cfg["replace_map"][key]["template"]
            assert "set_nlspec_status" in tmpl, f"{key} 模板应引导调用 set_nlspec_status 工具"
            assert "by=agent" in tmpl, f"{key} 模板应传 by=agent"

    def test_clarify_template_does_not_mark_completed(self, plugin_dir):
        """clarify 模板不追加标记 completed 指令（澄清阶段只产出 spec）。"""
        cfg = self._load(plugin_dir)
        tmpl = cfg["replace_map"]["dark-factory/clarify"]["template"]
        assert "set_nlspec_status" not in tmpl, "clarify 模板不应引导标记 completed"

    # ---- NLSpec: inject-reversa-context（开发前读取逆向文档）----

    _ALL_TEMPLATES = [
        "dark-factory/clarify",
        "dark-factory/run",
        "dark-factory/quick",
        "dark-factory/issue",
        "dark-factory/pr",
    ]

    @staticmethod
    def _operation_steps(tmpl):
        """提取「你必须执行的操作」之后的步骤编号列表。"""
        import re

        marker = "你必须执行的操作"
        idx = tmpl.find(marker)
        assert idx != -1, "模板缺少「你必须执行的操作」"
        body = tmpl[idx:]
        steps = []
        for line in body.splitlines():
            m = re.match(r"^\s*(\d+)\.\s", line)
            if m:
                steps.append(int(m.group(1)))
        return steps

    def test_all_templates_have_reversa_read_step(self, plugin_dir):
        """5 个模板的操作步骤均含「读取逆向文档」且引用 _reversa_sdd/。"""
        cfg = self._load(plugin_dir)
        for key in self._ALL_TEMPLATES:
            tmpl = cfg["replace_map"][key]["template"]
            assert "读取逆向文档" in tmpl, f"{key} 模板缺少「读取逆向文档」步骤"
            assert "_reversa_sdd/" in tmpl, f"{key} 模板未引用 _reversa_sdd/"

    def test_all_templates_have_reversa_rule(self, plugin_dir):
        """5 个模板的规则部分均含「开发前先检查项目根目录是否存在 _reversa_sdd/」约束。"""
        cfg = self._load(plugin_dir)
        for key in self._ALL_TEMPLATES:
            tmpl = cfg["replace_map"][key]["template"]
            assert "开发前先检查项目根目录是否存在 _reversa_sdd/" in tmpl, (
                f"{key} 模板缺少 _reversa_sdd/ 检查约束"
            )

    def test_all_templates_steps_numbering_continuous(self, plugin_dir):
        """5 个模板的操作步骤编号连续无重复。"""
        cfg = self._load(plugin_dir)
        for key in self._ALL_TEMPLATES:
            tmpl = cfg["replace_map"][key]["template"]
            steps = self._operation_steps(tmpl)
            assert steps, f"{key} 模板没有操作步骤"
            assert steps == list(range(1, len(steps) + 1)), (
                f"{key} 模板步骤编号不连续: {steps}"
            )

    def test_pipeline_invariants_mentions_reversa_read(self, plugin_dir):
        """pipeline_invariants.md 不变量清单含「读取逆向文档」条目，YAML 头 description 提及。"""
        path = plugin_dir / "rules" / "pipeline_invariants.md"
        assert path.is_file(), "pipeline_invariants.md 不存在"
        text = path.read_text(encoding="utf-8")
        assert "读取逆向文档" in text, "不变量清单缺少「读取逆向文档」条目"
        # YAML 头 description 提及该不变量
        assert "读取逆向文档" in text.split("---")[1], "YAML 头 description 未提及读取逆向文档"
