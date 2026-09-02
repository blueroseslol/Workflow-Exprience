---
description: 提交开发需求，走 Ultracode workflow 意图路由（OpenSpec-first / 通用修复 / 只读调研）
argument-hint: <开发需求，如「实现 openspec changes/foo 剩余任务」或「修复角色登录后偶尔状态不同步」>
---

调用 Skill 工具（skill: "workflow-experience:workflow-experience"）加载意图路由规则，然后按规则处理以下开发需求。对用户只讲阶段意图，不报内部模板文件名。

**先探测 OpenSpec**：若仓库已有与本需求匹配的 `openspec/changes/<change>/proposal.md + specs/** + design.md + tasks.md`（项目有自定义 `plan.md` 也一并复用），优先把这些 artifact 当作 Plan IR，走 OpenSpec-first 增量执行；不要再从零生成平行 Full Plan。若没有匹配 OpenSpec，则回退 GitNexus 动态路由。

OpenSpec-first 时：
- 用户 decisions 不得塞回 BasePlan prompt；普通拍板由 JS DecisionApply；
- mechanical/slice Plan 修改用 Kimi K3（`sonnet`）；
- 只有新增架构/public contract/state ownership 等推理才用 Opus；
- Review revise 优先 PlanPatch + DeltaReview；
- 已批准 planning delta 通过 SpecSync 写回原 OpenSpec，未 Verify green 不得勾完成 checkbox。

**先恢复、后 author**：如果 UserPromptSubmit 注入了 `[Ultracode checkpoint resolver]` 候选，先判断是否匹配当前 change/milestone/task。`nativeResume=true`（同 session + 脚本 hash + journal 已核实存在）时必须使用原 `scriptPath + resumeFromRunId`，args 取 state 的 `resumeArgs` 全量叠加新 args（全量替换非合并），不要重新生成脚本；否则候选 `valid=true` 时 Read state JSON，按提示把 `priorState/checkpointValidation/checkpointKey` 放进完整 args，走语义 artifact restore。`dirty=true`（上轮实现未完/Verify 未绿）与旧 v0.3 `legacy=true` 候选禁止直接 hit，先廉价 CheckpointValidate；dirty 部分失效且可定位时模板自动以历史 Plan 为起点 PlanPatch + DeltaReview，不重跑全量 Planner。只有没有有效/可验证候选时才从零执行 BasePlan/Review。

若需求明确包含“审阅使用 Codex CLI”或“修改代码使用 Codex CLI”等指令，按 `references/codex-cli.md` 只覆盖对应阶段；否则保持默认 `fable` Review/Audit 与现有动态模型路由。

需求：$ARGUMENTS
