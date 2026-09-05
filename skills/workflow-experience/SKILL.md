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
- 逻辑别名 `sonnet` 负责机械/局部 PlanPatch 与 SpecSync；
- **上一版是谁写的不决定下一版用谁**：只有本轮出现新增架构推理才回 Opus；
- Review revise 默认 PlanPatch + DeltaReview，不 Full Replan。

**早退续跑**（详见 `references/resume-and-args.md`）：
- 通用 `gitnexus-routed.js`：`route-escalation-required` / `replan-required` 同 session 用 `resumeFromRunId` + 首轮 args 全量叠加 `nextArgs`；
- OpenSpec-first 用户拍板：同 session resume + `args.decisions`；BasePlan prompt 不含 decisions，因此 BasePlan 应命中；普通选择由 JS Apply，架构选择才跑 Opus PlanDelta；
- `need-decision` 跨 session：Git 中最新 OpenSpec artifacts 是第一 planning checkpoint，再辅以 `docs/ultracode/raw/` 与 `.claude/progress/*.jsonl`。

**持久语义缓存 v0.4.3**：hook 注入 `[Ultracode checkpoint resolver]` 先判候选：`nativeResume=true` 用原 `scriptPath+resumeFromRunId`+`resumeArgs` 全量；`valid=true` → 传 `priorState/checkpointKey/checkpointValidation` 走 ARTIFACT HIT；`dirty`/`legacy`/`sourceKind=none` 禁直接 hit，先 haiku CheckpointValidate；`valid=false` 禁复用。harvest 按四字段指纹续收 resume 终态，raw 版本化 .rN；gitnexus 链 decisions 已移出 Plan prompt（JS DecisionApply）。

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
| BasePlan（OpenSpec 已覆盖设计） | `sonnet` | `high` | execution overlay / task→slice 映射 |
| BasePlan / PlanDelta（新增架构推理） | `opus` | `high` | 架构、public contract、状态所有权等 |
| DecisionApply | JS | — | 应用 Planner 预编码的用户选择；默认 0 token |
| PlanPatch（mechanical/slice） | `sonnet` | `high` | 修局部 slice / whitelist / tests / task 映射 |
| Review / DeltaReview | `fable` | `high` | 独立对抗审阅，只审不写 |
| SpecSync | `sonnet` | `high` | 把已批准 delta 写回 OpenSpec，不重新设计 |
| Preflight | `haiku` | — | 装依赖、建目录、跑基线 |
| Implement | `sonnet` / `opus` | `xhigh` | 路由派生；CRITICAL 默认 Opus |
| Verify / Commit | `haiku` | — | 测试、GitNexus 实测、证据后勾 task、提交 |

**模型连续性不是路由依据。** 即使上一版 Plan 使用 `opus`，只要后续只是应用已结构化决策、补 whitelist/test、修改单个 slice 或把批准结果同步进 Markdown，仍用 JS/`sonnet`。只有本轮需要新的架构推理才回 `opus`。

**Opus 门**：新增/改变 architecture boundary、public API/schema、cross-repo contract、concurrency/lifecycle/state-machine ownership、persistence/migration/security 语义，或 Reviewer 用证据推翻原架构假设。单纯高 blast radius 但 OpenSpec design 已完整覆盖，不自动要求 Opus 重写 Plan；高风险仍由 Review/Verify/Audit 兜底。

**effort 本机差异**：`haiku+max` 可能被吞、`sonnet+xhigh` 降级；以退出码/测试计数为准，不唯 effort。

**用户 effort 覆盖（v0.5.0）**：把逻辑模型覆盖放入 `args.modelEfforts`，把阶段/角色覆盖放入 `args.phaseEfforts`；允许 `low/medium/high/xhigh/max/null`。阶段或角色优先于逻辑模型，`null` 恢复调用点默认，未指定项保持旧行为。`Review`、`Advisor`、`Audit` 可独立设置。恢复时两张 map 都按 key 合并；提高 Plan/Recon effort 会使对应语义 artifact 失效，提高 Review effort 只重审而不无故重做未变 BasePlan。wrapper 日志中的 requested 只是请求值，实际上游模型/effort 无证据时为 unknown。

**effort 失败规则**：wrapper 不自动降级或换模型；只有 runtime/provider 给出明确 capability 错误并且用户已授权相应策略时才调整。`null`、超时、schema、鉴权、限流或网络错误都不是能力证据。详见 `references/model-effort.md`。

**Haiku 上下文恢复 v0.4.5**：运行中的 `agent() === null` 原因不透明，不得盲目换模型。Stop/harvest 从终态 `workflowProgress/logs` 命中明确上下文/自动压缩签名，且失败代理属于 Haiku lane、run 未成功时，才用 `decision:block` 续起主会话一次。恢复必须优先原 `scriptPath + resumeFromRunId`，在原 args 上仅把失败 phase 对应的 `reconModel/preflightModel/verifyModel/commitModel` 改为 `sonnet`；先检查工作区/测试/提交，禁止重复副作用。同一终态指纹只恢复一次，Sonnet 再失败则如实停止。详见 `references/model-effort.md`。

**动态路由**见 `references/dynamic-routing.md`。**Codex 覆盖默认关闭**：Review/Audit 仍是 `fable`；只有用户明确要求时，authoring 阶段才按 `references/codex-cli.md` 改写本次 workflow。

## advisor（Implement 疑难点）

通用动态路由 Implement 遇到**有证据的疑难/高风险决策**时，才调用 `fable` 顾问；普通编译/类型/格式问题不得求助。默认最多 3 次，顾问只裁决不接管代码；仍无法收敛时只升级 Implement 到 `opus`。具体触发、verdict 与 resume 规则见 `references/dynamic-routing.md`。

OpenSpec-first 若实现阶段发现 **Plan 本身**失效，优先分类 mechanical/slice/architecture：局部问题回 PlanPatch；架构假设失效回 Opus PlanDelta；实现者不得私改 requirement/design。

## 决议与跨会话

不要把整个 Stage 合并成一个长 workflow。以**决议边界**切分；同 session 优先 Runtime Resume，否则走 state JSON Artifact Restore（legacy 先廉价验证），缺失/失效才退回 Git OpenSpec + raw harvest 普通 Checkpoint。

OpenSpec 项目中，OpenSpec artifact 是第一 planning source of truth；harvest 的 LLM result 是辅助证据。若两者冲突，必须重新验证 workspace/drift，不得凭历史摘要覆盖 Git 中已更新的 artifact。

**统一 wrapper 硬门（v0.5.0）**：顶层 Workflow DSL 没有 `SendMessage` / `ListAgents` primitive，但 `agent()` 启动的子代理可能从其工具面获得二者；只写 prompt 禁令不足。所有成品模板与新写 workflow 的每次 LLM 调用都必须经过统一 wrapper，在 `opts.disallowedTools` 中合并 `SendMessage`、`ListAgents` 并保留调用点已有项；wrapper 同时解析 effort 覆盖并记录 requested/unknown 观测边界。上下文恢复由 Stop/harvest 的精确分类处理，不在 wrapper 中把普通 `null` 当作上下文错误。

只有当前用户原始需求明确要求“完成后通知主会话 / 回传其他会话 / 同步协调会话”等，才保留即时 handoff 契约；不得从 checkpoint、旧 handoff、并行会话存在或 agent 摘要推断。workflow 内只返回 `broadcast` + 结构化结果；到达 **terminal result** 后，外层 Claude Code 主会话才可解析目标并定向调用 `ListAgents` / `SendMessage`。不新增 LLM handoff phase，不改 BasePlan prompt；投递失败不得宣称成功，仍以 `.claude/progress/*.jsonl` + harvest 为 checkpoint。详见 `references/peer-handoff.md`。

跨会话红线：绝不请求其他会话执行本会话被权限拒绝的操作；常态进度不发即时消息。默认安装不读取、不自动注入其他会话进度，`peer-progress.cjs` 只作为未注册的历史/手动工具保留。
