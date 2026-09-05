# ADR-006：OpenSpec-first Plan IR 与增量重规划

**日期**：2026-09-02
**状态**：已采纳
**关系**：补充 ADR-005；不替代无 OpenSpec 项目的 `gitnexus-routed.js`

## 背景

当前动态 workflow 已能通过 resume 让 Recon 命中缓存，但本机 cache 使用前序滚动链：一旦 Plan prompt/model 改变，Plan 及其后 Review/Preflight/Implement 全部形成粘滞 miss。

两个高频操作会主动制造 Plan miss：用户拍板后把 `args.decisions` 拼回 Plan prompt；Review=revise 后把 `replanFeedback + replanAttempt` 拼回 Plan prompt。这能保证推进，却让昂贵 Planner 重做大量已经存在的推理。

项目默认采用 OpenSpec，并已有 proposal / delta specs / design / tasks。这些 artifact 本身就是可版本控制的规划状态。如果 workflow 再生成一套独立 Full Plan，会同时产生 token 浪费和“两套 plan 漂移”。

## 决定

### 1. OpenSpec 项目默认使用 OpenSpec-first workflow

把 OpenSpec artifacts 定义为长期 **Plan IR**。Workflow Planner 只生成 execution overlay / delta。无 OpenSpec 项目继续使用原 `gitnexus-routed.js`。

### 2. DecisionApply 默认为纯 JS

BasePlan 预先结构化每个 decision option 对 slice/whitelist/tests 的影响。`args.decisions` 不进入 BasePlan prompt。

用户拍板后 BasePlan prompt/model 不变；普通分支由 JS 应用，0 token。只有 `requiresArchitect=true` 的决策才调用 Opus PlanDelta。

### 3. 模型由“当前推理难度”决定，不由“上一版是谁写的”决定

即使 BasePlan 是 Opus 产出，后续机械 DecisionApply / PlanPatch / SpecSync 仍用 JS 或逻辑别名 `sonnet`。

Opus 只用于新增架构推理：公共 API/schema、跨 repo contract、并发/状态机/生命周期 ownership、持久化/迁移、安全边界，或 Reviewer 用证据推翻原架构假设。

### 4. Review revise 改为局部 PlanPatch

Reviewer 输出 `scope / requiresArchitect / affectedSliceIds / requiredChanges`：

- mechanical/slice → Sonnet PlanPatch；
- architecture → Opus PlanPatch/PlanDelta；
- 后续只做 DeltaReview；
- 默认最多 2 轮，仍不收敛转人工。

### 5. 已批准 delta 写回 OpenSpec

新增 SpecSync：默认 Sonnet，只落地已经批准的 artifact edits，不重新设计；semantic edit 必须绑定已拍板 decision；任务 checkbox 只在 Verify green 后更新。

## 后果

正面：用户拍板不再天然触发 Opus Full Plan 重跑；局部 Review 意见不再触发 Full Plan + Full Review；已发现 gap 写回 Git，跨 session 可复用；强模型成本集中在新增架构不确定性。

代价：Planner schema 更结构化；Reviewer 必须准确分类 scope；SpecSync 必须严守“批准后落文字、不重新设计”的边界；OpenSpec 若陈旧，Recon 必须显式检查 drift。

## 不采用

- **所有 Plan 修改继续使用 Opus**：拒绝。模型连续性不是质量保证；机械 apply / 局部 patch 不值得重读全上下文。
- **完全跳过 Planner，直接照 tasks.md Implement**：拒绝。tasks.md 可能 drift、缺 caller/test、低估 blast radius。
- **OpenSpec 只当 prompt 附件、不写回**：拒绝。同一个 gap 下次还会重新发现，无法形成跨 session 持久规划状态。
