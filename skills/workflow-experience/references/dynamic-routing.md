# 动态模型路由（GitNexus 复杂度评分）

把固定模型链（Opus Plan → Sol Review → Haiku Preflight → Kimi Implement → Haiku Verify）升级为**按证据路由**：便宜模型发现事实，JS 纯函数算风险，强模型只在真正需要时介入。

> 第一目标：降低 killed / failed / abort / 返工。省 token 是第二目标。
> 配套模板：`../../templates/gitnexus-routed.js`（实验性，与 `four-phase.js` baseline 并存）

---

## 一、模型别名映射（本机）

`~/.claude/settings.json` 的 env 段把逻辑别名指向第三方模型。**模板里只写别名，不写全 ID**——换 provider 时只改 settings，不改脚本。

| 别名 | 实际模型 | 路由里的角色 |
|---|---|---|
| `haiku` | DeepSeek V4 Flash | Scout（Recon / Verify 机械核对） |
| `sonnet` | Kimi K3 | Default Engineer（默认 Plan / Implement） |
| `opus` | Claude Opus 5 | Escalation Architect（HIGH+ Plan / CRITICAL Implement） |
| `fable` | GPT-5.6 Sol | Independent Judge（对抗 Review / Final Audit） |

约束模型行为**不要**依赖 `effort: max/xhigh` 一定发送（`haiku+max` 是空操作、`sonnet+xhigh` 会降级，见 `model-effort.md`）。要靠 schema、evidence、file:line、exit code、raw output、GitNexus graph evidence 施压。

---

## 二、核心原则：Recon 只出事实，JS 算分

**不要让 Recon 模型自己输出 `complexityScore: 78` 然后直接信它。** DeepSeek 只负责输出原始指标（深度计数、流程数、布尔标记），评分由 Workflow JS 用确定性算法算。

理由：
1. **确定性** —— 同一份 Recon facts + 同一套阈值 + 同一组 args = 同一个 route，resume 才能命中缓存。
2. **诚实** —— 便宜模型没有动机夸大了难度（那会换来更强模型替它干活），但也没有能力准确自评；把评分从它手里拿走，双方都不用猜。

Recon 返回 `partial / truncated / lower-bound / ambiguous / stale` 时，对应 `uncertainty` 标记置 true —— **不确定性只升不降**。

---

## 三、ComplexityScore 算法（0~100，纯 JS）

六项相加，全部确定性数学，禁 `Date.now()` / `Math.random()`。

| 维度 | 分值 | 算法 |
|---|---|---|
| A. Blast Radius | 0~30 | `min(30, depth1*4 + depth2*2 + depth3)` —— upstream 按深度加权，近处权重大 |
| B. Execution Flow | 0~15 | `min(15, executionFlows*3)` —— 一个 symbol 进大量业务流程就该升级 |
| C. Module/Repo Reach | 0~15 | crossRepo→15 · crossModule→10 · 文件数≥2→5 · 否则→1 |
| D. API/Contract | 0~15 | publicApi+5 · schemaChange+5 · consumerCount（封顶+3) · shapeMismatch>0→+2，封顶 15 |
| E. Behavioral Risk | 0~10 | 每个行为标记 +2（concurrency/stateMachine/security/persistence/migration/reflectionOrGeneratedCode），封顶 10 |
| F. Uncertainty | 0~15 | 每个不确定标记 +2（indexStale/lowerBound/partial/truncated/ambiguous/gitnexusUnavailable）+ unknowns 每条 +1（封顶+3），总封顶 15 |

### 阈值（args 可调，非魔法常量）

```js
const ROUTE_LOW_MAX    = args?.routeLowMax    ?? 24
const ROUTE_MEDIUM_MAX = args?.routeMediumMax ?? 49
const ROUTE_HIGH_MAX   = args?.routeHighMax   ?? 74
// 0-24 LOW · 25-49 MEDIUM · 50-74 HIGH · 75-100 CRITICAL
```

**未来应据真实 corpus 校准这三个数**（见第七节遥测），不要永远信人工设定。

---

## 四、Hard Escalation 规则（只升不降）

即使 score 偏低，命中下列任一条件即抬升路由：

```js
esc(recon.uncertainty.gitnexusUnavailable,      'MEDIUM',    'GitNexus 不可用')
esc(recon.contracts.shapeMismatchCount > 0,     'MEDIUM',    'shape mismatch')
esc(recon.contracts.publicApi,                  'MEDIUM',    'publicApi')
esc(recon.riskFlags.stateMachine,               'MEDIUM',    'stateMachine')
esc(recon.riskFlags.concurrency,                'MEDIUM',    'concurrency')
esc(recon.riskFlags.persistence,                'MEDIUM',    'persistence')
esc(recon.modules.crossRepo,                    'HIGH',      'crossRepo')
esc(recon.riskFlags.security,                   'HIGH',      'security')
esc(recon.riskFlags.migration,                  'HIGH',      'migration')
esc((partial || truncated) && publicApi,        'CRITICAL',  'partial/truncated + publicApi')
```

此外的 fail-safe（见第六节）：**Recon agent 返回 null / GitNexus 无法读取 / symbol 无法绑定 → 直接 HIGH**，不进入打分。

> GitNexus 找不到关系**不能**自动视为安全。`partial/truncated + 公共 API 修改` 直接 CRITICAL。

---

## 五、路由 → 模型链

```js
const plannerModel        = (route==='HIGH'||route==='CRITICAL') ? 'opus' : 'sonnet'
const implementationModel = route==='CRITICAL' ? 'opus' : 'sonnet'
const reviewModel         = 'fable'
const needsReview         = ALWAYS_REVIEW || route !== 'LOW'
```

| 路由 | Recon | Plan | Review | Implement | Verify | Final Audit |
|---|---|---|---|---|---|---|
| **LOW** | haiku | sonnet | （跳过，除非 alwaysReview） | sonnet | haiku（只验证） | routeMiss 时触发 fable |
| **MEDIUM** | haiku | sonnet | fable | sonnet | haiku（只验证） | routeMiss 时触发 fable |
| **HIGH** | haiku | opus | fable | sonnet | haiku（只验证） | routeMiss 时触发 fable |
| **CRITICAL** | haiku | opus | fable（对抗） | opus | haiku（只验证） | fable（必跑） |

> 所有等级的 Verify 都只验证、不提交；提交统一由 Commit 层在 Commit Gate 放行后执行（见下节）。
> Final Audit 触发条件：`route === 'CRITICAL' || routeMiss`——**LOW 的 routeMiss 比 HIGH 更值得审计**，因为它意味着前面的 Recon + Planner 都低估了爆炸范围。

LOW 默认跳过 Sol Review 是**可配置策略**，不是硬编码：
```js
const ALWAYS_REVIEW = args?.alwaysReview ?? false   // true → LOW 也过 Review
```

---

## 五·补、控制流闸门（纯 JS，不进 agent）

Recon 预判只是第一次估计。完整链路要有**三层纠偏**，且闸门都是 JS 纯函数（不耗 token、不进缓存键）：

```
第一次：DeepSeek Recon + GitNexus 预判 → computeRouting() 冻结 route
第二次：Kimi/Opus Planner 亲自读码纠偏 → Plan Risk Gate
第三次：实现后 GitNexus detect_changes 实测 → routeMiss → Final Audit
```

修正版执行链（v3，所有等级统一拆开 Verify/Commit，routeMiss 一律在提交前计算）：

```
Recon → Route → Plan → Plan Risk Gate → Review → Preflight → Implement → Verify → routeMiss → Audit → Commit Gate → Commit
```

| 闸门 | 位置 | 行为 |
|---|---|---|
| **Plan Risk Gate** | Plan 后 | `plan.predictedImpact.risk` 高于冻结 route → 早退 `route-escalation-required` 并带 `nextArgs.minRoute=<更高等级>`。主 agent **同 session 直接 resume**（`resumeFromRunId` + 首轮 args 全量叠加 nextArgs）：Recon 命中缓存，minRoute 给路由兜底使**升级粘滞、不会在 Recon 处回落**（否则 Recon 重判 LOW → Plan 再判 HIGH → 死循环）；缓存失效两条腿——跨档（LOW/MEDIUM↔HIGH/CRITICAL）时 plannerModel 变（model 进缓存键），同档（LOW→MEDIUM、HIGH→CRITICAL）时靠 Plan prompt 内嵌的 route 等级变化（prompt 进缓存键），任一都使 Plan 及之后重跑。已跨 session 才开新 workflow（checkpoint）。不因风险评分在当前 run 中途换模型；终态 Haiku 上下文故障由 Stop/harvest 精确分类后续起一次 Sonnet 恢复，不改变冻结 route。 |
| **Review 门** | Review 后 | `revise` → 早退 `replan-required`（实现者被旧 whitelist 锁死，无法合法吸收 reviewer 发现的过窄问题）；`block` → `blocked` |
| **Preflight 门** | Preflight 后 | **fail-closed**：`!pre`（agent 未返回）也算失败 → `failed`；`!pre.ready` → `blocked`。不再静默放行 |
| **Implement 门** | Implement 后 | `!impl \|\| !impl.done` → 早退 `escalate`，避免「没实现完但旧测试全绿被提交」 |
| **Commit Gate** | Audit 后 | 仅 `verify green 且 (无 audit 或 audit=accept) 且 requireCommit` 才放行提交。该提交却没提交成（commitResult.committed=false）→ `status='commit-failed'`，不落 green。最终 status 吸收 audit verdict |

两个关键分离：

- **Verify / Commit 全程分离**：所有等级的 Verify 都只验证不提交；`routeMiss` 在提交前算，`needsAudit = CRITICAL || routeMiss`。这样即使 LOW/MEDIUM 也能在提交前被 routeMiss 拦住、升级 Sol Audit 再决定提交与否——堵住「先提交后才发现低估」的洞。代价只是 LOW/MEDIUM 多一个很便宜的 haiku Commit agent。
- **Preflight 必须保留**：动态路由改变的是模型选择，**不是牺牲基线核对**。haiku Preflight 建测试基线，Verify 据此判「回退」，这是反假绿的地基。

> 早退的 `route-escalation-required` / `replan-required` 与 `need-decision` 一样，是把控制权交回主 agent / 用户的既定模式，不是失败。

---

## 五·再补、Implement Advisor Escalation

默认实现仍由路由派生模型负责；**HIGH 也不是自动问顾问**。只有实现者已经亲自读码/取证，并遇到无法安全继续的高风险疑难点时，才允许调用 `fable` 只读顾问。

推荐链：

```text
Kimi/Sonnet Implement
  → 普通问题自己解决
  → 有证据的疑难点 → Fable Advisor
  → continue/change-approach → Kimi 继续
  → replan → 复用 replanFeedback/replanAttempt
  → stop-and-ask → need-decision
  → 多次仍不收敛 / escalate-implementation → 仅 Implement 升级 Opus
```

**Advisor replan ≠ Review replan（脏工作区）**：Review=revise 的 replan 发生在 Implement 之前，工作区是干净的；Advisor 判 replan 时 Implement 已把部分实现落盘，工作区带着上一版方案的 provisional implementation。后者早退的 result 与 `nextArgs` 会带 `dirtyWorktree: true`（Review 路径只透传、不新置），下一轮 Plan prompt 会因此注入残留裁决段：Planner 必须先亲自审阅 `git status` / `git diff`，把残留当作【待裁决的旧方案】而非现状基线——对每个 hunk 明确决定 **retain**（与新计划一致 → 吸收进对应切片，rationale 写明「继承上轮残留 + file:line」）或 **replace**（基于旧假设/与新计划冲突 → 切片中要求实现者先还原或覆盖，附 file:line 证据）。禁止自动继承残留，也禁止无视它导致新旧两套实现混杂。

触发条件包括：合理修复后测试仍失败且根因不明、Plan 关键假设与源码冲突、需要越出 whitelist、新发现跨模块/API/schema/concurrency/lifecycle/state machine/persistence/serialization 风险、GitNexus 与 Plan 冲突、存在多个明显不同风险的实现方案。

禁止用顾问处理普通编译/类型/格式问题。顾问默认：

```js
const ADVISOR_MODEL = args?.advisorModel ?? 'fable'
const ADVISOR_MAX = args?.advisorMax ?? 3
```

顾问只输出 `continue / change-approach / replan / stop-and-ask / escalate-implementation`，代码 ownership 始终属于 Kimi/Opus。模板用 `disallowedTools: ['Edit', 'Write']` 禁掉直接编辑；**Bash 仍可执行，因此“Bash 不得写文件”目前是 prompt 约束，不要描述成完全的硬只读沙箱**。

`advisorModel` 进缓存键：一次 run 中途切换它会让 Advisor 及其后所有 agent 重跑——预算内选定就不要中途换。

顾问达到上限仍不收敛时，不继续烧 token：若当前是 Kimi，则早退 `implementation-escalation-required`，通过：

```js
nextArgs: {
  implementationModelOverride: 'opus',
  implementationEscalationReason: '...'
}
```

同 session 用原 `scriptPath + resumeFromRunId` 续跑。因为模型/prompt 只在 Implement 开始发生变化，目标是让 Recon / Plan / Review / Preflight 尽量命中缓存，只重跑 Implement 及之后。已经是 Opus 仍无法收敛则转人工/用户拍板。

---

## 六、Fail-safe：故障偏向质量

Router 出问题时**绝不 fallback 到 LOW**：

| 故障 | 处理 |
|---|---|
| Recon 返回 null | 直接 HIGH，Planner 全程自侦察；**不编造 score**——标 `score: null, failsafe: true`（写成 75 会落进 CRITICAL 区间却标 HIGH，污染 scan-corpus 的平均分统计） |
| GitNexus 不可用 | ≥MEDIUM |
| 索引严重落后 / impact truncated | uncertainty 加分 + 对应硬升级 |
| 入口 symbol 无法绑定 | uncertainty.ambiguous → 加分 |

原因：错误的降级比浪费 token 贵得多——一次 killed 烧掉的 token 远超一次过度规划。

---

## 七、GitNexus 预估 vs 实测 + routeMiss（遥测）

Plan 阶段必须填 `predictedImpact`（affectedSymbols / affectedModules / processes / risk）。Verify 阶段用 `detect_changes(scope=all, repo, worktree)` + `context/impact` 实测填 `actualImpact`。JS 对**三个维度**分别对比，任一显著超预估（>50% 且绝对值 >3）即 routeMiss：

```js
significant = (a, p) => a > p * 1.5 && (a - p) > 3
routeMiss = significant(a.symbols, p.symbols) || significant(a.modules, p.modules) || significant(a.processes, p.processes)
```

`routeMiss=true` 必须写进 `scanFindings`；**任意 route 出现 routeMiss 都触发 fable Final Audit**（`needsAudit = CRITICAL || routeMiss`）。LOW 的 routeMiss 反而比 HIGH 更值得审计——它意味着前面的 Recon + Planner 都低估了爆炸范围。

> linked worktree 场景必须显式传 `worktree` 给 detect_changes，否则可能对错 checkout diff，出现假 0 changed symbols。

### 遥测字段（进 workflow result，由 harvest 固化）

```js
routing: {
  score, route, plannerModel, implementationModel, reviewModel,
  reasons, forcedEscalations, uncertaintyScore,
  predictedImpact, actualImpact, blastRadiusDelta, routeMiss,
}
```

`harvest-workflow.cjs` 已把整个 run（含 `result`）复制到 `docs/ultracode/raw/`，**无需新增 hook**。`tools/scan-corpus.mjs` 负责聚合：

- route 分布
- route → completed / killed 率
- 模型组合 → completed 率
- 平均 complexity score
- routeMiss 率
- forced escalation 率
- Implement Advisor：调用率、平均 calls、调用后 completed 率、**请求升级强实现模型比例**（`implementationAdvisor.escalationRequested`）

> ⚠️ Advisor 升级统计口径：`escalationRequested` 记在【发出请求的首次 run】（`implementation-escalation-required` 早退时写入），该 run `calls>0` 一定落在 `advised` 集合内。不能用 `escalatedToStrong` 当升级率——它是【续跑生效后】的状态：首次 run `calls>0` 但 `escalatedToStrong=false`，带 override 的续跑 `escalatedToStrong=true` 却可能一次 Advisor 都不调用（`calls=0`）被 `advised = calls>0` 过滤，两头都漏 → 「已升级」统计系统性偏低甚至恒 0。

跑 `node tools/scan-corpus.mjs` 即可看到「路由遥测」段（语料里还没有 routing 字段时自动跳过）。

---

## 八、Resume / Cache 安全

模型选择进 agent 缓存键（见 `resume-and-args.md`）。本设计因此强制：

1. **评分是 JS 纯函数** —— 不消耗 agent、不进缓存键、结果确定。
2. **route 一次冻结** —— Recon 之后算一次，本轮不变。不在实现中途因 LLM 主观判断从 sonnet 切 opus。
3. **确定性输入** —— 同 Recon facts + 同阈值 + 同 args = 同 route。路由逻辑禁 `Date.now()` / `Math.random()`。
4. **风险路由需要升级时**：不在同一 run 里换模型（破缓存确定性），早退 `route-escalation-required` 交回控制权。续跑**同 session 首选 resume**（`resumeFromRunId` + 首轮 args 全量叠加 `nextArgs`：Recon 命中缓存、仅升级段重跑）；已跨 session 才开新 workflow 抄结论进 `COMMON`（checkpoint）。分流细则见 `resume-and-args.md`「两级暂停」与 ADR-005。
5. **终端故障恢复例外**：运行中的普通 `null` 不换模型。终态日志明确命中 Haiku context/compaction 错误且 run 未成功时，Stop/harvest 才用 `decision:block` 续起主会话一次，并要求原 `scriptPath + resumeFromRunId`、失败 phase 的模型 override=`sonnet`。它不重新评分、不改变 route；Sonnet 必须先核对已有副作用。

> ⚠️ 注意「粘滞 miss」：route 决定 plannerModel，一旦某次运行 route 变了（例如改了阈值 args），Plan 及其后所有 agent 因缓存键变化全部重跑。这是预期行为——阈值调参属于"换一套实验"，本就该全量重跑。

---

## 九、不要重复昂贵阅读

token 优势应来自：**DeepSeek 大范围 Recon → 强模型只重读关键文件**。

而不是四个模型各自读完整仓库。Recon 的 Evidence Map（entrySymbols + file:line + impact 计数）帮助 Planner **精确定位**关键代码；但 Planner 必须保留亲自重读入口/caller/callee/public interface/tests/lifecycle 的权利。

> 目标：减少**无价值**重复阅读 ≠ 用摘要替代源码证据。

---

## 十、与既有设计的关系

- `templates/four-phase.js` 仍是**稳定 baseline**，不动。
- `templates/gitnexus-routed.js` 是实验模板，等 corpus 证明它降低 killed/failed/routeMiss/返工后再考虑替换默认。
- 评价指标优先级：`completed rate ↑ · killed ↓ · failed ↓ · routeMiss ↓ · 返工 ↓`，token/API cost 次之。
