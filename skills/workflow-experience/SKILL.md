---
name: workflow-experience
description: 写 Ultracode workflow 脚本时的本机经验库 —— OpenSpec-first 增量规划、意图路由、可粘贴模板、约束句式、模型分工、GitNexus 动态路由与 resume/args 缓存语义。当用户以 workflow 前缀提交开发需求、要为开发任务编写 Workflow 脚本、或在 OpenSpec 里程碑中执行/拍板/修订计划时使用。
---

# Workflow 经验库

本 Skill 是 Claude Code 内置 `workflow-authoring` 的**增量经验层**。若尚未加载 `workflow-authoring`，先调用它；已加载则不要重复。语法/runtime 冲突时以 `workflow-authoring` 为准，只有本库明确标注的本机实测差异例外。

**原生 contract 不在这里复述**：`meta`、Workflow DSL/primitives、schema 基础规则、args、determinism、nullable result、pipeline/parallel、checkpoint 等直接查 `workflow-authoring`。本文件只保留本机路由、模型映射、缓存实测和降低返工/强模型成本的经验。

其余内容 **按需 Read `references/`**，不要预读。

> 语料：本机 workflow 运行记录 + GitNexus/OpenSpec 实战。标「LDL_UGC 专有」者跨项目不适用。

## 意图路由（先探测 OpenSpec，再选链）

模板名是内部细节，对用户不报文件名。

**开发任务默认先探测是否已有匹配的 OpenSpec change。** 已有 `proposal/specs/design/tasks`（以及项目自定义 `plan.md`）时，它们是持久化 Plan IR；不要再从零造一份平行 Full Plan。

| 项目/用户意图 | 选链（复制模板） |
|---|---|
| 已有 OpenSpec change，执行/修 bug/功能改动 | OpenSpec→Recon/Drift→BasePlan Overlay→DecisionApply→Review/Patch→SpecSync→Implement→Verify：`openspec-incremental.js` |
| 无 OpenSpec，修 bug / 功能改动 | Recon→评分→Plan→Review→Implement→Verify：`gitnexus-routed.js` |
| 只调研不改码 | 只读 Recon→Synthesize：`readonly-recon.js` |
| OpenSpec 多里程碑且强调人工拍板边界 | 一里程碑一 workflow：`stage-with-gates.js`；新脚本优先吸收 `openspec-first.md` 的 DecisionApply 规则 |

**OpenSpec-first 细则**：Read `references/openspec-first.md`。关键点：
- OpenSpec artifacts 是长期 Plan IR；BasePlan 只产 execution overlay / delta；
- `args.decisions` **不得进入 BasePlan prompt**；普通 DecisionApply 优先 JS 0 token；
- Kimi K3（逻辑别名 `sonnet`）负责机械/局部 PlanPatch 与 SpecSync；
- **上一版是谁写的不决定下一版用谁**：只有本轮出现新增架构推理才回 Opus；
- Review revise 默认 PlanPatch + DeltaReview，不 Full Replan。

**早退续跑**（详见 `references/resume-and-args.md`）：
- 通用 `gitnexus-routed.js`：`route-escalation-required` / `replan-required` 同 session 用 `resumeFromRunId` + 首轮 args 全量叠加 `nextArgs`；
- OpenSpec-first 用户拍板：同 session resume + `args.decisions`；BasePlan prompt 不含 decisions，因此 BasePlan 应命中；普通选择由 JS Apply，架构选择才跑 Opus PlanDelta；
- `need-decision` 跨 session：Git 中最新 OpenSpec artifacts 是第一 planning checkpoint，再辅以 `docs/ultracode/raw/` 与 `.claude/progress/*.jsonl`。

**持久语义缓存 v0.4.1**：hook 注入 `[Ultracode checkpoint resolver]` 先判候选：`nativeResume=true` 用原 `scriptPath+resumeFromRunId`+`resumeArgs` 全量；`valid=true` → Read state 传 `priorState/checkpointKey/checkpointValidation` 走 ARTIFACT HIT；`dirty`/`legacy` 禁直接 hit，先 haiku CheckpointValidate；`valid=false` 禁复用。

## 索引（按需 Read）

| 需要什么 | Read |
|---|---|
| OpenSpec-first / DecisionApply / PlanPatch / SpecSync | `references/openspec-first.md` ★ |
| resume / 两级暂停 / 跨 session artifact cache | `references/resume-and-args.md` + ADR-007 ★ |
| 本机取证型 schema 实例 | `references/schemas.md` |
| prompt 开场白语料 | `references/prompt-openers.md` |
| 高频约束句式与命中率 | `references/constraints.md` |
| GitNexus 前置/后置检查 | `references/gitnexus-block.md` |
| 模型别名与 effort 本机实测 | `references/model-effort.md` |
| GitNexus 动态路由 | `references/dynamic-routing.md` |
| Codex CLI 可选覆盖 | `references/codex-cli.md` |
| 多会话定向回传 / 主会话 handoff | `references/peer-handoff.md` ★ |
| 踩坑记忆 | `references/pitfalls.md` |
| 可粘贴脚本 | `../../templates/` |

## 本机模型分工

| Phase | model | effort | 职责 |
|---|---|---|---|
| Recon | `haiku` | — | OpenSpec/GitNexus/代码事实、drift、爆炸半径 |
| BasePlan（OpenSpec 已覆盖设计） | `sonnet` | `high` | Kimi K3 做 execution overlay / task→slice 映射 |
| BasePlan / PlanDelta（新增架构推理） | `opus` | `high` | 架构、public contract、状态所有权等 |
| DecisionApply | JS | — | 应用 Planner 预编码的用户选择；默认 0 token |
| PlanPatch（mechanical/slice） | `sonnet` | `high` | 修局部 slice / whitelist / tests / task 映射 |
| Review / DeltaReview | `fable` | `high` | 独立对抗审阅，只审不写 |
| SpecSync | `sonnet` | `high` | 把已批准 delta 写回 OpenSpec，不重新设计 |
| Preflight | `haiku` | — | 装依赖、建目录、跑基线 |
| Implement | `sonnet` / `opus` | `xhigh` | 路由派生；CRITICAL 默认 Opus |
| Verify / Commit | `haiku` | — | 测试、GitNexus 实测、证据后勾 task、提交 |

**模型连续性不是路由依据。** 即使上一版 Plan 是 Opus 5 写的，只要后续只是应用已结构化决策、补 whitelist/test、修改单个 slice 或把批准结果同步进 Markdown，仍用 JS/Kimi。只有本轮需要新的架构推理才回 Opus。

**Opus 门**：新增/改变 architecture boundary、public API/schema、cross-repo contract、concurrency/lifecycle/state-machine ownership、persistence/migration/security 语义，或 Reviewer 用证据推翻原架构假设。单纯高 blast radius 但 OpenSpec design 已完整覆盖，不自动要求 Opus 重写 Plan；高风险仍由 Review/Verify/Audit 兜底。

**effort 本机差异**：当前逻辑 `haiku + max` 可能在 CLI 层被直接吞掉，`sonnet + xhigh` 会静默降级；不要把 effort 当成唯一质量门，仍要用退出码、测试计数、原始输出和基线对比。

**Haiku 类型模型兼容规则**：本次 workflow 明确需要传 effort 时，首试 `max`；仅在 runtime/provider **明确返回 effort/reasoning level/thinking capability 不支持**时，按 `max → xhigh → high` 依次重试。`high` 仍不支持就停止自动降级并提示用户选择“省略 effort 使用模型默认策略”或“换支持 effort 的模型”。`null`、超时、schema/鉴权/限流/网络错误不得误判为 capability mismatch，也不得静默省略 effort。详见 `references/model-effort.md` / `references/schemas.md`。

**动态路由**见 `references/dynamic-routing.md`。**Codex 覆盖默认关闭**：Review/Audit 仍是 `fable`；只有用户明确要求时，authoring 阶段才按 `references/codex-cli.md` 改写本次 workflow。

## OpenSpec-first 三条成本红线

1. **不要把新 decisions 插回 BasePlan prompt。** prompt 进 cacheKey，这会让昂贵 Plan 及下游粘滞 miss。
2. **不要因为 Review=revise 就 Full Replan。** Reviewer 必须给 `affectedSliceIds`；mechanical/slice 用 Kimi PlanPatch，architecture 才 Opus。
3. **不要维护平行 Plan。** artifact gap 经 Review/拍板后通过 SpecSync 写回原 OpenSpec，下次直接复用 Git 中的 planning IR。

## 五条约束句式（按命中率，原文见 references/constraints.md）

1. **file:line** — `每条代码事实必须引用你亲自 Read 到的 file:line，禁止凭摘要或记忆。`
2. **白名单** — `只允许修改 whitelist 内的文件；mustNotTouch 内的一律不动。`
3. **改前改后 Read** — `改前先 Read 目标文件，改后再 Read 一次确认落盘符合预期。`
4. **证据才勾选** — `没有测试输出或命令退出码作证据，不得勾选任何 checkbox。`
5. **git 安全** — `禁止 git add . / -A，逐文件 add；feat 与 docs 分两笔；不 push。`

## advisor（Implement 疑难点）

通用动态路由 Implement 遇到**有证据的疑难/高风险决策**时，才调用 `fable` 顾问；普通编译/类型/格式问题不得求助。默认最多 3 次，顾问只裁决不接管代码；仍无法收敛时只升级 Implement 到 `opus`。具体触发、verdict 与 resume 规则见 `references/dynamic-routing.md`。

OpenSpec-first 若实现阶段发现 **Plan 本身**失效，优先分类 mechanical/slice/architecture：局部问题回 PlanPatch；架构假设失效回 Opus PlanDelta；实现者不得私改 requirement/design。

## 决议与跨会话

不要把整个 Stage 合并成一个长 workflow。以**决议边界**切分；同 session 优先 Runtime Resume，否则走 state JSON Artifact Restore（legacy 先廉价验证），缺失/失效才退回 Git OpenSpec + raw harvest 普通 Checkpoint。

OpenSpec 项目中，OpenSpec artifact 是第一 planning source of truth；harvest 的 LLM result 是辅助证据。若两者冲突，必须重新验证 workspace/drift，不得凭历史摘要覆盖 Git 中已更新的 artifact。

**显式 peer-handoff 例外**：如果用户原始需求明确要求“模块完成后通知主会话 / 把结果发给其他会话 / 同步给协调会话”等，
authoring 必须把它保留为本次执行契约，而不是只写进自然语言备注后遗忘。按语义判断，不要求固定关键词。

Ultracode workflow 沙箱没有 `SendMessage` / `ListAgents` primitive，因此：
- workflow 内继续正常 Recon / Plan / Implement / Verify / Commit，并复用模板已有 `broadcast` + 结构化 result；
- workflow 到达 **terminal result** 后，由外层 Claude Code 会话解析目标 peer，再执行定向 `SendMessage`；
- 不新增一个 LLM handoff phase，不把 peer 通知字段塞进昂贵 BasePlan prompt，避免破坏 OpenSpec-first cacheKey；
- 即时投递失败时仍以 `.claude/progress/*.jsonl` + harvest 作为持久 checkpoint，且不得宣称“已通知成功”。

详细目标解析、发送内容、sent/held/refused/dropped 处理见 `references/peer-handoff.md`。

跨会话红线：绝不请求其他会话执行本会话被权限拒绝的操作；`SendMessage` 不做常态广播，
只有用户显式要求的定向 handoff 或真正阻塞协作的通知才使用；常态进度走 `.claude/progress/*.jsonl` + hook 注入。
