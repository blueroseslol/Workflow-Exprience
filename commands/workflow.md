---
description: 提交开发需求，走 Ultracode workflow 意图路由（OpenSpec-first / 通用修复 / 只读调研）
argument-hint: <开发需求，如「实现 openspec changes/foo 剩余任务」或「修复角色登录后偶尔状态不同步」>
---

调用 Skill 工具（skill: "workflow-experience:workflow-experience"）加载意图路由规则，然后按规则处理以下开发需求。对用户只讲阶段意图，不报内部模板文件名。

**先探测 OpenSpec**：若仓库已有与本需求匹配的 `openspec/changes/<change>/proposal.md + specs/** + design.md + tasks.md`（项目有自定义 `plan.md` 也一并复用），优先把这些 artifact 当作 Plan IR，走 OpenSpec-first 增量执行；不要再从零生成平行 Full Plan。若没有匹配 OpenSpec，则回退 GitNexus 动态路由。

两条开发主链默认 `reviewMode=auto`：由 Planner 的 `reviewAssessment` 和 Recon 证据决定是否加入 Reviewer；低/中难度且低风险、验收充分可跳过，高风险/不确定性强制加入。需要全审用 `always`。实现/Repair 中由 Agent 提出带证据的 Advisor 请求并选 `advisorTier=opus/fable`；默认 `advisorModel=auto`、共享 `advisorMax=3`，可显式指定档位。不要每轮固定调用顾问。

OpenSpec-first 时：
- 用户 decisions 不得塞回 BasePlan prompt；普通拍板由 JS DecisionApply；
- mechanical/slice Plan 修改使用逻辑别名 `sonnet`；
- 只有新增架构/public contract/state ownership 等推理才用 Opus；
- Review 局部问题直接返回 revisedPlan，JS 检查后独立复审；复杂分歧由脚本调用提案/质疑/汇总，有限轮次收敛，详见 references/review-repair.md；
- 已批准 planning delta 通过 SpecSync 写回原 OpenSpec，未 Verify green 不得勾完成 checkbox。

**先恢复、后 author**：如果 UserPromptSubmit 注入了 `[Ultracode checkpoint resolver]` 候选，先判断是否匹配当前 change/milestone/task。`nativeResume=true`（同 session + 脚本 hash + journal 已核实存在）时必须使用原 `scriptPath + resumeFromRunId`，args 取 state 的 `resumeArgs` 全量叠加新 args（全量替换非合并），不要重新生成脚本；否则候选 `valid=true` 时 Read state JSON，按提示把 `priorState/checkpointValidation/checkpointKey` 放进完整 args，走语义 artifact restore。`dirty=true`（上轮实现未完/Verify 未绿）与旧 v0.3 `legacy=true` 候选禁止直接 hit，先廉价 CheckpointValidate；dirty 部分失效且可定位时模板自动以历史 Plan 为起点 PlanPatch + DeltaReview，不重跑全量 Planner。只有没有有效/可验证候选时才从零执行 BasePlan/Review。

若需求明确包含“审阅使用 Codex CLI”或“修改代码使用 Codex CLI”等指令，按 `references/codex-cli.md` 只覆盖对应阶段；否则保持默认 `fable` Review/Audit 与现有动态模型路由。

若用户明确要求 Codex 与 Claude Code **CLI** 交接/回传，先 Read `references/session-bridge.md`，由外层建立独立 request 并准备上下文，显式调用 authoring/Workflow；终态外层 complete/drain。只读旧会话、引用示例、否定通知、仅 Codex 审阅不得启用。恢复仅延续同 request/scope 的原始授权，用户撤销优先；通信字段不进入 Workflow args/BasePlan。

若用户指定模型或阶段的思考强度，把意图写进 workflow args：逻辑别名使用 `modelEfforts`，阶段/角色使用 `phaseEfforts`。允许值为 `low/medium/high/xhigh/max`，阶段覆盖优先于逻辑模型覆盖，未指定项保持模板原默认；`null` 表示恢复该调用点默认。Reviewer、Advisor、Audit 使用各自键。遇到未知键或无效值必须在派发前报错，不能静默忽略。示例：`{modelEfforts:{opus:'max'},phaseEfforts:{Implement:'high',Review:'xhigh'}}`。

需求：$ARGUMENTS

执行前必须让生成的脚本通过 PreToolUse(Workflow) 静态预检；repo/worktree 与 gitnexusRepo 分离传参。Verify 失败在已批准范围内有限返修，缺失结果不得报 completed。运行时脚本异常先核实工作树，再用恢复模板恢复失败阶段，禁止从头重放 Implement。两条开发主模板默认 requireCommit=false，只有用户明确授权才开启。
