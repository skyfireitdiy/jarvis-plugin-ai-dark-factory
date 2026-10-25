---
name: pipeline_invariants
description: AI Agent 黑灯工厂的开发流程不变量。当开启黑灯工厂工作流（完整流水线或简化版）时触发。这些约束对所有任务恒定成立，是流程的单一事实源——NLSpec 四要素先行、读取逆向文档、遵守规则集、在已有代码库工作、TDD 铁律、固定 spec 目录、知识回流、门禁人工审批、holdout 隔离纪律。
---

# 开发流程不变量（Pipeline Invariants）

本规则集中定义黑灯工厂开发流程中**对所有任务恒定成立**的约束。任何黑灯工厂工作流（完整多 agent 流水线或简化单 agent 版）都必须遵守，不因具体需求而改变。

这些不变量是流程的**单一事实源**：指令模板只需引用本规则，无需各自重复描述。

## 不变量清单

1. **NLSpec 四要素先行**：先确认/补全 NLSpec 的 Goal/Constraints/Interfaces/Non-goals 四要素；不齐或模糊时**先澄清再开工**（逐条向用户提问补齐），禁止没有 Spec 就开始实现。

2. **读取逆向文档**：开发前先检查项目根目录是否存在 `_reversa_sdd/`（Reversa 逆向规格产物）；若存在，先 `read_code` 读取相关逆向文档（`architecture.md` / `domain.md` / `inventory.md` 及改动涉及模块的 `requirements.md` / `design.md` / `tasks.md`）作为开发依据，把其中的约束/接口/边界条件提炼进 NLSpec 或编排文件 spec 字段；未做过逆向（无 `_reversa_sdd/`）则跳过，不报错、不阻塞。

3. **遵守规则集**：遵守 `spec_writing` / `tdd_iron_rule` / `orchestration` / `holdout_discipline` 规则。简化版不启用多 agent 编排时，`orchestration` 与 `holdout_discipline` 中与多 agent 相关部分可豁免，但隔离评估与人工审批精神仍适用。

4. **在已有代码库工作**：直接修改现有代码，不生成到独立目录。generator 的产物是代码库的改动（git diff 可查），不是独立目录。

5. **TDD 铁律**：先写测试（红）→ 写实现（绿）→ 重构，遵守 `tdd_iron_rule` 规则。无失败测试不写代码。

6. **固定 spec 目录**：NLSpec 落盘到项目固定目录 `.jarvis/.df/specs/<功能名>.md`（每功能一个 spec 文件），流水线先 `read_code` 读取该目录下对应 spec。

7. **知识回流**：开发完成后执行知识回流，保持 `_reversa_sdd/` 规格文档与代码同步。流程：`sync_diff`（分析基线到当前 HEAD 的代码变更，增量更新产物）→ `sync_baseline`（更新基线）→ `export_rules`（重新导出 rule 知识库）。仅当项目已做过 Reversa 逆向（存在 `_reversa_sdd/` 与基线）时有意义；无基线时自动跳过。

8. **门禁人工审批**：不自动放行/合并。完整流水线在门禁阶段停住，输出结构化审批报告交人工审批；简化版开发完成后向用户汇报（改动清单、测试结果、回流结果）交人工确认。

9. **holdout 隔离纪律**：holdout scenarios 只注入 validator，绝不注入 generator（隔离评估，train/test 分离防作弊）。编码 agent 全程不可见验收场景。

## 结构性不变量（固定路径/契约）

- NLSpec 固定目录：`.jarvis/.df/specs/<功能名>.md`
- 编排文件落盘路径：`.jarvis/.df/pipeline.yaml`
- 产物契约：`.jarvis/.df/{plan.md, holdout.json, report.json, regression.json, approval.md}`
- 编排参考模板：`orchestration/dark_factory_pipeline.yaml`

## 与其它规则的关系

- `spec_writing`：定义 NLSpec 怎么写（四要素细节、编写原则）。
- `tdd_iron_rule`：定义怎么写代码（红-绿-重构纪律）。
- `orchestration`：定义多 agent 怎么编排（sw-controller 只协调不执行、四层架构、门禁）。
- `holdout_discipline`：定义验收场景怎么隔离（train/test 分离、独立评估）。
- 本规则是**流程层**的约束汇总；上述规则是**方法层**的细节。指令模板引用本规则即可覆盖全流程不变量。
