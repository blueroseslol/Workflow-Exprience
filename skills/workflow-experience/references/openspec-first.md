# OpenSpec-first：把 planning artifacts 当作长期 Plan IR

本页定义 Ultracode 在 **有 OpenSpec 项目**中的默认规划策略。无 OpenSpec 时回退 `gitnexus-routed.js`，不要为了兼容而伪造 proposal/design/tasks。

## 核心结论

OpenSpec 的 `proposal.md` / delta `specs/**` / `design.md` / `tasks.md`（以及项目自定义 `plan.md`）已经承担“为什么 / 做什么 / 怎么做 / 实现清单”的规划职责。Ultracode 不应每个 workflow 再让 Opus 从零复述，而应把这些文件视为 **持久化、可版本控制的 Plan IR**：

```text
OpenSpec artifacts
  ↓
Recon：验证 artifact ↔ code 是否漂移
  ↓
BasePlan：只生成 execution overlay / delta
  ↓
DecisionApply：纯 JS 应用用户选择
  ↓
Review：只审 overlay
  ↓ revise
PlanPatch：只修 affected slices
  ↓
DeltaReview：只复审 changed slices
  ↓
SpecSync：把已批准 delta 写回 OpenSpec
```

收益不是“少读文档”，而是避免昂贵模型反复重新**创造**已经存在的规划。

## 1. 两种项目模式

### OpenSpec 项目（默认）

主 agent 在 authoring 前探测 `openspec/changes/<change>/` 下的 proposal/specs/design/tasks；项目有自定义 plan 文件也一并使用。找到目标 change 后使用 `templates/openspec-incremental.js`，把路径显式放进 args，不要让 Workflow JS 猜目录。

### 无 OpenSpec 项目

继续使用 `templates/gitnexus-routed.js`：

```text
Recon → Route → Full Plan → Review → Implement → Verify
```

不要因为默认偏好 OpenSpec 就临时生成一套 artifact 再执行；“创建 OpenSpec change”应是用户明确要求的 planning 工作。

## 2. BasePlan 不再等于 Full Plan

OpenSpec 模式下 BasePlan 只负责：

1. 把相关 task IDs 映射到稳定 slice IDs；
2. 给每个 slice 定位 files / callers / tests；
3. 验证 design/spec 与当前代码是否 drift；
4. 输出最小 `openspecEdits`；
5. 输出结构化 `decisionPoints`；
6. 预估 blast radius。

禁止长篇复述 proposal/design/tasks。`executionBasis` 只写“现有 OpenSpec 到实际代码之间还缺什么”。

建议 slice：

```json
{
  "id": "S2",
  "sourceTaskIds": ["2.3", "2.4"],
  "files": ["src/foo.ts", "src/foo.test.ts"],
  "rationale": "design §X → code file:line"
}
```

稳定 ID 是后续 PlanPatch / DeltaReview 的索引。

## 3. 模型分工：谁写过 Plan ≠ 谁必须继续改 Plan

| 工作 | 模型 | 原因 |
|---|---|---|
| Recon / Verify | `haiku` | 事实搜集、机械验证 |
| OpenSpec 已完整且设计已覆盖的 BasePlan | `sonnet` | 只是 execution overlay / 校验，不创造架构 |
| DecisionApply | **纯 JS** | 用户只是在选择 Planner 预先编码好的分支 |
| 机械/局部 PlanPatch | `sonnet` | 修 whitelist、tests、单 slice、task 映射 |
| 架构 PlanDelta / Architecture Patch | `opus` | 需要新的架构推理 |
| Review / DeltaReview | `fable` | 独立对抗审阅 |
| SpecSync | `sonnet` | 把已批准 delta 落到 Markdown，不重新设计 |
| Implement | 路由派生 | CRITICAL 才默认 Opus |

**Opus 产出的 BasePlan 并不要求后续继续用 Opus。** 模型升级依据是“本轮是否需要新的架构推理”，不是“上一轮是谁写的”。

`requiresArchitect=true` 只用于：

- architecture boundary 改变；
- public API / schema 语义改变；
- concurrency / lifecycle / state machine ownership 改变；
- persistence / migration / security 边界改变；
- cross-repo contract 改变；
- Reviewer 已用证据推翻原架构假设。

这些不属于 `requiresArchitect`：whitelist 漏文件、少测试、file:line/task 映射不完整、单 slice 局部修复、OpenSpec Markdown 机械同步、用户只是在 A/B 中选择 Planner 已完整描述的分支。

## 4. DecisionApply：优先 0 token

BasePlan 的 `decisionPoints[].options[]` 预先给：

- `activateSlices` / `disableSlices`
- `whitelistAdd` / `mustNotTouchAdd`
- `testCommandsAdd`
- `requiresArchitect`

用户拍板后 JS `applyDecisionOptions()` 直接生成 EffectivePlan。

**BasePlan prompt 禁止插入 `args.decisions`。** 本机 cacheKey 包含 prompt；插回去会让最贵 Plan cache miss，并导致下游粘滞 miss。

只有被选 option 的 `requiresArchitect=true` 时才运行 Opus `PlanDelta`，且只处理受影响部分。

## 5. Review revise：PlanPatch，不 Full Replan

Reviewer 输出：

```json
{
  "verdict": "revise",
  "scope": "mechanical | slice | architecture",
  "requiresArchitect": false,
  "affectedSliceIds": ["S3"],
  "requiredChanges": ["..."]
}
```

路由：

```text
mechanical/slice → Sonnet PlanPatch → DeltaReview(changed slices only)
architecture    → Opus PlanPatch → DeltaReview(changed slices only)
```

默认最多 2 轮；仍 revise 则 blocked / 转人工，避免无限烧 token。

## 6. SpecSync：让本次推理成为下次缓存

批准后的 artifact delta 用 Sonnet `SpecSync` 写回原 OpenSpec：proposal/specs/design/tasks/plan。

红线：

- SpecSync 不重新做架构设计；
- semantic edit 必须绑定已拍板的 decision id；
- 未经用户拍板，不得新增/改变 requirement、scenario、public contract 或架构语义；
- SpecSync 禁止把 `[ ]` 改 `[x]`；
- 只有 Verify green 后 Commit 层才能按 `completedTaskIds` 勾选任务。

因此 OpenSpec 既是输入缓存，也是输出 checkpoint：下次直接复用更新后的 planning IR。

## 7. OpenSpec 完整度影响 Planner，而不是直接决定安全

Recon 输出 `coverage / drift / architectureGap / semanticSpecChange / relevantTaskIds`。

推荐模型门：

```js
needsStrongPlan =
  architectureGap
  || semanticSpecChange
  || (coverage !== 'complete' && route >= HIGH)

plannerModel = needsStrongPlan ? opus : sonnet
```

**高 blast radius 不自动等于需要 Opus 重写 Plan。** 若 design/spec/tasks 已经完整覆盖架构，Sonnet 可以做 execution overlay；风险仍由 Review / Verify / Final Audit 兜底。

## 8. 跨 session

Resume 仍只适合 same-session cache。跨 session 时：

1. 读取 Git 中最新 OpenSpec artifacts；
2. 读取 harvest 上轮 result 作为辅助证据；
3. Recon 检查 artifact ↔ workspace drift；
4. artifact 没变且依赖没变时，避免重新做架构规划；
5. 只对变化 slice 重新取证。

OpenSpec 文件比 session journal 更稳定，是第一 planning checkpoint。

## 9. Token 预期

不承诺固定百分比；收益取决于 Plan/Review 输入长度与拍板次数。但成本结构从：

```text
Opus Full Plan
→ 用户拍板 → Opus Full Plan again
→ Full Review → revise → Opus Full Plan again → Full Review again
```

变成：

```text
Sonnet/Opus Base Overlay once
→ JS DecisionApply
→ Review
→ Sonnet local PlanPatch
→ DeltaReview
→ Sonnet SpecSync
```

强模型 token 只在“新增架构不确定性”出现时支付。
