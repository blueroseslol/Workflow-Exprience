# 按需 Reviewer 与实现 Adviser

适用于 `gitnexus-routed.js`、`openspec-incremental.js`。其他历史模板保持原行为。

默认参数：

```js
{ reviewMode: 'auto', advisorModel: 'auto', advisorMax: 3 }
```

Planner 亲自读码输出 `reviewAssessment`（difficulty、risk、uncertainty、evidence、unknowns、validationAdequate），不新增专门评分 Agent。JS 综合 Recon 和 Planner 结果：只有 LOW/MEDIUM 难度、LOW 风险、LOW 不确定性、无未知项且验证充分才可跳过独立 Reviewer。高路由等级、公共 API/schema、跨仓契约、架构、安全、迁移、并发、状态/持久化语义以及不完整 Recon 证据强制审查。架构决议和恢复修订仍需 Review。

`reviewMode='always'` 强制全审；兼容 `alwaysReview=true`。不支持关闭硬风险审查的 never 模式。旧 Plan 缺少 assessment 时保守审查。`reviewDecision` 保存判断及原因，跳过记录 `review.status/verdict='skipped'`，不伪装 approve，不能成为批准缓存。审查输入策略版本更新为 adaptive-v2，旧 Review 不直接命中。Verify 始终保留。

实现 Agent 在 Implement 或 Repair 中遇到有证据的难题，返回 `done=false`、`needsAdvisor=true`、具体 `advisorQuestion`、`blockingEvidence` 和 `advisorTier`。局部诊断/方案裁决选择 fable，架构/公共契约/并发状态所有权推理选择 opus。显式 `advisorModel=opus/fable` 覆盖 Agent 选择；Advisor 使用独立 effort 角色。

外层脚本调用顾问并传回意见，实现 Agent 读取当前 git diff、核实建议后继续。实现和 Repair 共享每 run 的顾问次数，默认 3，允许整数 0–5。调用前计数；null 失败退出，不静默切换模型。普通编译、类型、格式问题应自行解决。顾问调用或反复 Repair 会触发最终独立 Audit；发现超预期影响仍沿用 routeMiss Audit。

顾问禁止 Edit/Write；Bash 禁止写入仍是 prompt 约束，并非硬只读沙箱。顾问只能建议，不能扩大 whitelist、改变 requirement/design 或替用户做新决定。

通用链保留 replanFeedback / dirtyWorktree 和有界实现升级路径。OpenSpec 链计划失效返回 replan-required 与 dirtyWorktree，外层读取顾问证据，走已有 PlanPatch/PlanDelta 恢复；预算耗尽返回 needs-rework。恢复应核实当前源码和落盘修改，不能原样重放实现。

离线验收：`node tools/verify-all.mjs`。路由、顾问档位、上下文回传、预算、失败和 Repair 接线通过模拟 Workflow runtime 验证；不将离线通过声明为真实模型或 Provider 验收。
