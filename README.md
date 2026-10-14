# ai-dark-factory — AI Agent 黑灯工厂
> Jarvis 外部插件：**Specs 进，可工作的软件出**。
> 多 Agent 自主写码 / 测试 / 评估，人类审 pass/fail 报告。

## 功能特性

| 功能 | 说明 |
| --- | --- |
| 🏭 黑灯工厂流水线 | `dark-factory-pipeline` 编排模板：Specs → 可工作的软件，六阶段（规划 → 生成隐藏场景 → 生成（TDD）→ 验证 → 回归 → 门禁） |
| 📐 规则集 | `rules/` 提供 spec_writing / tdd_iron_rule / orchestration / holdout_discipline 四条铁律 |
| 🛠️ 工具集 | `tools/` 提供 spec_validator（NLSpec 校验）、holdout_generator（隐藏验收场景）、gate_calculator（门禁指标） |
| ⚙️ 编排引擎 | 通过 `orchestration` 扩展点注册 dark-factory-pipeline，配合 `pipeline_runner` 驱动多 Agent 流水线 |
| ⌨️ 指令模板 | `replace_map` 提供 `<dark-factory/run>` / `<dark-factory/issue>` / `<dark-factory/pr>` 三种工作流模板 |

## 安装

### 从插件市场安装（推荐）
在 Jarvis 插件管理面板的「市场」页签搜索 `ai-dark-factory`，一键安装。

### 命令行安装
```bash
# 从源码仓库安装
jarvis --install-plugin https://github.com/skyfireitdiy/jarvis-plugin-ai-dark-factory
# 或从本地目录安装
jarvis --install-plugin /path/to/ai-dark-factory
```

安装后重启 Jarvis 使插件注册生效：
```bash
jarvis --list-plugins   # 确认 ai-dark-factory 插件已注册
```

## 使用
### 1. 指令模板（推荐）
在输入框输入：
- **`<dark-factory/run>`**：用黑灯工厂流水线完成一个开发任务
- **`<dark-factory/issue>`**：用黑灯工厂工作流开发 GitHub Issue 需求
- **`<dark-factory/pr>`**：用黑灯工厂工作流处理 GitHub Pull Request

### 2. 直接驱动编排
让 Agent 使用 `pipeline_runner` 工具，配合插件自带的 `orchestration/dark_factory_pipeline.yaml` 模板动态生成编排文件执行。

## 插件结构
```
ai-dark-factory/
├── config.yaml          # 插件配置：logo、rules_load_dirs、tool_load_dirs、orchestration、replace_map
├── README.md
├── assets/
│   └── ai-dark-factory-icon.svg   # 插件图标
├── orchestration/
│   └── dark_factory_pipeline.yaml # 六阶段流水线模板
├── rules/
│   ├── holdout_discipline.md
│   ├── orchestration.md
│   ├── spec_writing.md
│   └── tdd_iron_rule.md
└── tools/
    ├── gate_calculator.py
    ├── holdout_generator.py
    └── spec_validator.py
```

## 环境要求
- Jarvis（支持外部插件）
- `pipeline_runner` 内置编排引擎

## 许可证
MIT
