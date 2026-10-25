"""
NLSpec 状态设置工具（Agent 侧）。

薄封装插件私有功能层 plugin/api.py 的 set_nlspec_status，让 Jarvis Agent
能在黑灯工厂流水线开发完成后自动把对应 NLSpec 标记为 completed（by=agent），
并记录状态历史（at/from/to/by，只追加不覆盖）。

用法:
- project_dir (str): 目标项目目录（必填）
- name (str): NLSpec 文件名（.md 结尾，必填）
- status (str): active|completed|deprecated（必填）
- by (str): 来源标记（可选，默认 "agent"）

返回 {"success": bool, "stdout": JSON, "stderr": str}。
"""
import importlib.util
import json
import os
import sys
from typing import Any
from typing import Dict

_VALID_STATUSES = ("active", "completed", "deprecated")


def _load_api():
    """用 importlib 按路径加载插件私有功能层 plugin/api.py。

    plugin/ 不在 sys.path，故按文件路径加载；模块名固定以便复用缓存。
    """
    # tools/set_nlspec_status.py -> 插件根目录 -> plugin/api.py
    plugin_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    api_path = os.path.join(plugin_root, "plugin", "api.py")
    if not os.path.isfile(api_path):
        raise FileNotFoundError(f"未找到插件私有功能层: {api_path}")
    mod_name = "set_nlspec_status_plugin_api"
    if mod_name in sys.modules:
        return sys.modules[mod_name]
    spec = importlib.util.spec_from_file_location(mod_name, api_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"无法加载模块: {api_path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = mod
    spec.loader.exec_module(mod)
    return mod


class SetNlspecStatusTool:
    # 文件名必须与工具名一致，便于注册表自动加载
    name = "set_nlspec_status"
    description = (
        "设置 NLSpec 状态（active/completed/deprecated），并记录状态历史。"
        "供黑灯工厂流水线开发完成后自动标记 completed 使用：quick 模式单 agent "
        "完成「TDD 实现 → 跑测试 → 知识回流」全部步骤后标记；full 模式在人工审批"
        "通过后标记。每次成功变更会在 spec frontmatter 追加一条 history 记录"
        "（at/from/to/by，只追加不覆盖），随文件走、git 可追踪。"
        "人工仍可通过前端「重新激活」把状态翻转回 active。"
    )
    parameters = {
        "type": "object",
        "properties": {
            "project_dir": {
                "type": "string",
                "description": "目标项目目录（必填）",
            },
            "name": {
                "type": "string",
                "description": "NLSpec 文件名（.md 结尾，必填）",
            },
            "status": {
                "type": "string",
                "enum": ["active", "completed", "deprecated"],
                "description": "要设置的状态（必填）",
            },
            "by": {
                "type": "string",
                "enum": ["agent", "manual"],
                "description": "来源标记（可选，默认 agent）",
            },
        },
        "required": ["project_dir", "name", "status"],
    }

    @staticmethod
    def check() -> bool:
        """工具始终可用（api 层运行时校验参数）。"""
        return True

    def execute(self, args: Dict[str, Any]) -> Dict[str, Any]:
        try:
            project_dir = args.get("project_dir")
            project_dir = str(project_dir).strip() if project_dir else ""
            name = args.get("name")
            name = str(name).strip() if name else ""
            status = args.get("status")
            status = str(status).strip() if status else ""
            if not project_dir:
                return self._err("参数错误：project_dir 不能为空")
            if not name:
                return self._err("参数错误：name 不能为空")
            if not status:
                return self._err("参数错误：status 不能为空")
            if status not in _VALID_STATUSES:
                return self._err(
                    f"参数错误：非法状态 {status}（仅支持 active/completed/deprecated）"
                )
            by = args.get("by")
            by = str(by).strip() if by else "agent"
            api = _load_api()
            result = api.set_nlspec_status(
                project_dir=project_dir,
                name=name,
                status=status,
                by=by,
            )
            return self._ok(result)
        except Exception as e:
            return self._err(f"set_nlspec_status 执行异常: {e}")

    @staticmethod
    def _ok(result: Dict[str, Any]) -> Dict[str, Any]:
        """把 api 返回统一包装成工具返回格式。"""
        success = bool(result.get("success"))
        return {
            "success": success,
            "stdout": json.dumps(result, ensure_ascii=False, indent=2),
            "stderr": "" if success else str(result.get("error") or "操作失败"),
        }

    @staticmethod
    def _err(message: str) -> Dict[str, Any]:
        return {"success": False, "stdout": "", "stderr": message}
