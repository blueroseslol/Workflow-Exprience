# OpenSpec 里程碑 Review

默认 `reviewTiming='milestone'`。已有完整且未漂移的 OpenSpec 设计时：

```text
Recon / execution overlay → Implement（可并行）→ Verify（含有界 Repair）
  → 里程碑未完：pending，继续后续任务
  → 里程碑完成：一次独立 Review（Audit 阶段）
```

普通切片、机械 PlanPatch、局部 Repair、单次顾问求助不单独触发计划 Review。难度高或涉及已有设计覆盖的公共契约，不自动重审已有设计。

提前计划 Review 的例外：OpenSpec 缺设计或覆盖不完整、已漂移、新增架构/需求语义、新架构决议、关键未知项/取证不完整。Verify 发现实际影响超计划（routeMiss）也触发例外 Audit。Review 否决、顾问失败、replan 不得继续宣称完成。

Recon 从 tasks.md 列出目标 milestone 的全部 task IDs、已有完成项和证据。Verify 再读整个里程碑，独立返回任务全集，并仅将亲自验证、有真实完成证据的任务写入 completedTaskIds。JS 对比两次全集，合并先前完成项与本次已验证项：

- 有剩余任务：`milestoneReview.status='pending'`，不调用 Reviewer。
- 范围/证据缺失或两次范围不同：`unconfirmed`，不能报告里程碑完成。
- 全部完成：调用最终 Review；通过为 `accepted`，否决为 `needs-rework`，无返回则失败。检查整个里程碑源码与 requirements，不能只看最后一个切片的 diff。

`green` 仅表示本次 Verify 通过；里程碑交付还须 `milestoneReview.status='accepted'`。旧 checkpoint 缺里程碑证据时先重新取证。计划 Review 缓存使用 milestone-v3，与旧策略隔离。

主会话尽量一次提交一个完整里程碑，内部切片并行。多个 Workflow 共同实现同一里程碑时，由一个集成 Workflow 做最终 Verify/Review，子任务的 green 仅是切片结果；不能给每个子任务伪造独立的完整里程碑。

`reviewTiming='plan'` 恢复原风险驱动计划 Review；`reviewMode='always'` 或 `alwaysReview=true` 强制计划 Review，最终里程碑 Review 仍保留。无 OpenSpec 的通用链保持 adaptive-v2。里程碑 Review 使用现有 Audit 阶段与 `phaseEfforts.Audit`，不自动修改主模型/effort。
