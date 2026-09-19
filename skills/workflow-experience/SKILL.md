---
name: workflow-experience
description: 为 Claude Code Ultracode 编写和恢复开发 Workflow：复用 OpenSpec、按依赖并行实现、里程碑审查与证据验收。用户用 workflow 前缀提交开发需求，或要求编写、执行、恢复 Workflow 时使用。
---

# Workflow 经验库

这是内置 `workflow-authoring` 的增量层；未加载时先调用，已加载不重复。原生 DSL/schema/args/resume 契约以它为准。本页负责选链与执行边界；仅在触发对应情况时读 reference，不预读整套资料。

## 先恢复，再选链

先核对当前 repo/worktree、任务和 OpenSpec change。启动/等待时遵守 [任务身份](references/task-identity.md)：args 必须是对象，显式填写 changeDir/task/milestone，记录 taskId/runId/scriptPath；running、idle、消息通知都不代表完成。

有 checkpoint 候选时先核实任务身份及脚本/源码指纹；匹配且有效才复用。原生恢复用原脚本与 resumeFromRunId，args 是首轮完整参数叠加新值；decisions/modelEfforts/phaseEfforts 按 key 合并。dirty、legacy、来源缺失不能直接命中；恢复时读 [resume-and-args](references/resume-and-args.md)。脚本异常或实现部分落盘时先查 git diff，按 [失败恢复](references/review-repair.md) 只补失败部分，不盲目重放 Implement。

| 当前需求 | 模板（复制并配置） |
|---|---|
| 已有匹配 OpenSpec change，执行/修复任务 | `../../templates/openspec-incremental.js` |
| 无匹配 OpenSpec，修 bug/功能改动 | `../../templates/gitnexus-routed.js` |
| 纯调研 | `../../templates/readonly-recon.js` |
| 需要在阶段间由用户拍板 | 按决议边界分 Workflow，参考 `../../templates/stage-with-gates.js` |

OpenSpec 的 proposal/specs/design/tasks（及项目 plan.md）是持久计划；只生成执行 overlay，不再重写 Full Plan。用户 decisions 不进入 BasePlan prompt；普通选择用 JS 应用。只有新增架构/公共契约/状态所有权等设计推理才升级规划角色，机械修订仍用常规角色。涉及 DecisionApply/PlanPatch/SpecSync 时读 [OpenSpec-first](references/openspec-first.md)。

## 并行与 Review

同一需求优先一个 Workflow：共享 Recon/Plan，脚本按依赖调度独立实现切片，最后统一 Verify。两条开发模板默认 `parallelMode=auto`、`maxParallel=2`；旧计划或证据不足自动串行。新计划为切片填写 execution（依赖、文件读取、共享资源、验收）；有可并行切片时读 [并行执行](references/parallel-execution.md)。不能只按前端/后端名称推断独立性，也不为小任务增加 Agent。

独立交付单元可由外层启动多个 Workflow；各自使用稳定 workflowSliceId、独立工作区/文件归属和 checkpoint。外层分配总并发预算，不能每个 Workflow 都用满预算；同一 tasks.md、共享生成目录、集成验证与提交只由一个收口者处理。跨 Workflow 锁与自动合并尚未实现，边界不清时用一个 Workflow。

**OpenSpec 默认 `reviewTiming=milestone`：普通切片和局部 Repair 不做计划 Review，里程碑完成后一次独立 Review（Audit 阶段）。** Verify 每次保留。Recon 与 Verify 核对整个里程碑 task 全集和完成证据；未完成标 pending，证据不足标 unconfirmed，不能将当前切片完成冒充里程碑完成。设计缺失/漂移、新增需求或架构语义、关键未知项才提前审计划；实际影响超计划触发例外 Audit。具体见 [里程碑审查](references/milestone-review.md)。

无 OpenSpec 保留风险驱动 `reviewMode=auto`；`reviewTiming=plan` 可恢复 OpenSpec 原策略，`reviewMode=always` 显式全审。跳过必须标 skipped，不能伪造 approve。Implement/Repair 遇到有证据的疑难才请求 fable/opus 顾问，每 run 共享默认 3 次预算；普通编译/格式错误自行解决。详见 [动态路由](references/dynamic-routing.md)。

## 主 Agent 与 Token

Astra low 适合按明确规则选链、填参、派发、检查结果；medium 适合依赖拆分、契约边界和重规划。这是分工建议，不自动修改用户模型/effort。保留逻辑别名及用户覆盖；参考 [模型与 effort](references/model-effort.md)。

复用已核实模板，仅修改必要参数/任务差异，避免整段重写。每个实现 Agent 只收到本切片、相关契约、前置结果与验收；完整日志留 artifact，返回状态/证据位置/阻塞即可。调度、冲突检查、计数用 JS；已经通过且未变化的检查不重复跑。并行主要节约耗时，总 Token/费用须用相同任务实测，不能按 Agent 数或文档长度推算。

## 执行边界

- 每次 LLM 调用经过统一 wrapper，保留调用点已有 disallowedTools 并禁用 SendMessage/ListAgents；并行叶子还禁用 Agent/Task/Workflow，避免嵌套扩大预算。
- repo/worktree 与 gitnexusRepo 分开传；生成脚本先经 PreToolUse 静态预检。改 symbol 前做 GitNexus impact；HIGH/CRITICAL 报风险，UNKNOWN/partial/truncated 不当作无影响。
- Verify 必须有真实命令/退出码及完成证据；缺失结果不报完成。requireCommit 默认 false，用户授权才开启；不可顺带 push/deploy/写数据库。
- Bridge 暂停，不建立 request、不接 Channel、不回传 Bridge。其他跨会话动作仅按用户显式指令由外层执行，参考 [peer-handoff](references/peer-handoff.md)；不得从历史通知推断新授权，也不能借另一会话执行被拒操作。

其他按需参考：[schema](references/schemas.md)、[GitNexus](references/gitnexus-block.md)、[约束句式](references/constraints.md)、[prompt](references/prompt-openers.md)、[踩坑](references/pitfalls.md)。仅用户指定 Codex CLI 覆盖阶段时读 [codex-cli](references/codex-cli.md)。
