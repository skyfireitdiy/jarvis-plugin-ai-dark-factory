# ai-dark-factory — AI Agent 黑灯工厂

> Jarvis 外部插件：**Specs 进，可工作的软件出**。
> 多 Agent 自主写码 / 测试 / 评估，人类审 pass/fail 报告。
> 融合 Reversa 规格逆向工程，形成 **逆向分析 → 正向开发 → 知识回流** 闭环。

## 功能特性

| 功能 | 说明 |
| --- | --- |
| 🏭 黑灯工厂流水线 | `dark-factory-pipeline` 编排模板：Specs → 可工作的软件，六阶段（规划 → 生成隐藏场景 → 生成（TDD）→ 验证 → 回归 → 门禁） |
| 🔄 知识回流 | 正向流水线 `dark-factory-pipeline` 末尾内置 `sync` 阶段：门禁通过后把代码变更增量回流到 `_reversa_sdd/` 规格，文档与代码同步 |
| 🔍 规格逆向工程 | 对遗留项目执行 Reversa 逆向分析，生成 `_reversa_sdd/` 结构化规格（inventory / domain / architecture / sdd / traceability，带置信度标记 🟢CONFIRMED / 🟡INFERRED / 🔴GAP） |
| 📚 Rule 知识库导出 | 把逆向产物导出为 Jarvis rule（每产物一 rule、覆盖式更新、metadata 溯源），供后续开发直接引用 |
| 🔁 知识回流 sync | 基线记录 + git diff 差异分析 + traceability 矩阵映射受影响产物（矩阵缺失/未命中时回退代码路径关键词匹配），文档与代码同步维护；侧边栏「回流」按钮一键创建 Agent 增量更新文档 |
| 📐 规则集 | `rules/` 提供 spec_writing / tdd_iron_rule / orchestration / holdout_discipline 四条铁律 |
| 🛠️ 工具集 | `tools/` 提供 holdout_generator（隐藏验收场景）、gate_calculator（门禁指标）、reversa（逆向分析生命周期） |
| ⚙️ 编排引擎 | 通过 `orchestration` 扩展点注册两条流水线模板，配合 `pipeline_runner` 驱动多 Agent 流水线 |
| ⌨️ 指令模板 | `replace_map` 提供 `<dark-factory/clarify>`（需求澄清）/ `<dark-factory/run>` / `<dark-factory/issue>` / `<dark-factory/pr>` 四种工作流模板 |
| 🖥️ 前端视图 | 侧边栏 Reversa 逆向工程视图：生命周期管理、产物浏览、依赖图、知识回流手动触发 |
| 📂 现存资料库 | 为项目添加文档/网页/目录参考资料，反构时注入任务提示词作补充输入（仅进提示词，不落盘到项目） |
| 📝 NLSpec 管理 | 侧边栏扫描 `.jarvis/.df/specs/` 固定目录的 NLSpec，客观校验 Goal/Constraints/Interfaces/Non-goals 四要素缺口，新建/编辑走 LLM 澄清，一键开启黑灯工厂流水线 |

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

### 2. 遗留项目逆向分析（手动触发）
对遗留项目做规格逆向分析，生成 `_reversa_sdd/` 结构化规格：

1. **逆向分析**：在侧边栏项目目录上右键，选择「创建 Agent 执行规格逆向分析」（或「在当前 Agent 中执行」），对目标项目执行 Reversa 逆向分析，生成 `_reversa_sdd/` 结构化规格；逆向是一次性的，无需每次开发都跑；
2. **正向开发**：让 Agent 使用 `pipeline_runner` 工具，配合 `orchestration/dark_factory_pipeline.yaml` 模板动态生成编排文件执行——NLSpec 中直接引用逆向产物路径（如 `_reversa_sdd/architecture.md`），Agent 自行读取；
3. **知识回流**：正向流水线末尾内置 `sync` 阶段（门禁通过后执行，无基线时自动跳过），记录基线、分析代码变更对产物的影响并增量更新，保持文档与代码同步。基线在逆向分析产生产物后由侧边栏自动记录（无需手动点击），手动「记录基线」按钮仅作兜底/重置。受影响产物清单由 traceability 矩阵映射；矩阵缺失或未命中时回退「代码路径关键词匹配实际产物」推断（带 🟡INFERRED 标记）。侧边栏「回流」按钮可一键创建 Agent 执行文档增量更新：先跑差异分析，再对候选产物逐个确认后更新（清单为启发式候选，不机械全量更新）。

### 3. 直接驱动编排
让 Agent 使用 `pipeline_runner` 工具，配合插件自带的 `orchestration/dark_factory_pipeline.yaml`（六阶段 + 末尾 sync 回流）模板动态生成编排文件执行。

### 4. 侧边栏视图
安装后侧边栏出现「Reversa 逆向工程」视图，可管理逆向生命周期、浏览产物、查看依赖图、手动触发知识回流。
在「现存资料库」区块可为当前项目添加文档/网页/目录参考资料（仅存于浏览器 localStorage，按节点+项目隔离），反构时这些资料会注入任务提示词供 Agent 参考。
在「NLSpec 管理」区块可扫描当前项目 `.jarvis/.df/specs/` 固定目录下的 NLSpec（每功能一个 `<功能名>.md`），客观校验四要素（Goal/Constraints/Interfaces/Non-goals）小节标题是否齐全并提示缺口；「打开」在宿主编译器中打开该 spec 文件，「新建/编辑」会创建 Agent 跑 `<dark-factory/clarify>` 澄清流程（编辑以现有 spec 为输入补齐缺口），「开启」会创建 Agent 基于该 spec 跑 `<dark-factory/run>` 黑灯工厂流水线。

按钮按前置条件自动禁用（灰色，悬停显示原因）：未安装 Reversa 时「开始逆向」不可用；项目目录不存在时安装/新建等操作不可用；无产物时「导出 Rules」不可用；非 git 仓库或无基线时「记录基线/分析差异」不可用；NLSpec 四要素不齐时「开启」不可用。基线在逆向分析完成后自动记录（无需手动点击），「记录基线」按钮仅作兜底/重置。前置条件由后端 `check_project`（目录存在性、是否 git 仓库）与 `get_status`/`list_artifacts` 共同判定。

## 插件结构
```
ai-dark-factory/
├── config.yaml          # 插件配置：logo、rules_load_dirs、tool_load_dirs、orchestration、replace_map、frontend
├── README.md
├── assets/
│   └── ai-dark-factory-icon.svg   # 插件图标
├── orchestration/
│   └── dark_factory_pipeline.yaml         # 六阶段流水线模板（末尾含 sync 知识回流）
├── plugin/
│   ├── api.py            # 后端功能层（PUBLIC_FUNCTIONS 白名单：reversa 生命周期 + sync 知识回流）
│   └── reversa_bridge.mjs # 绕过交互式 CLI 直连 Reversa installer 库
├── frontend/
│   ├── sidebar_view.js   # Reversa 逆向工程侧边栏视图（window.Vue 单文件自包含）
│   └── icon.svg
├── rules/
│   ├── holdout_discipline.md
│   ├── orchestration.md
│   ├── spec_writing.md
│   └── tdd_iron_rule.md
├── tools/
│   ├── gate_calculator.py
│   ├── holdout_generator.py
│   └── reversa.py
└── test/
    └── test_api.py
```

## 环境要求
- Jarvis（支持外部插件）
- `pipeline_runner` 内置编排引擎
- Node.js / npm（Reversa 逆向分析依赖 `npx reversa`）

## 许可证
MIT
