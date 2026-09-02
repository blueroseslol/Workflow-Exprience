# resume / cache 本机实测

`workflow-authoring` 已覆盖 args、determinism、nullable result 与 checkpoint 的通用 contract；本文件只记录本机 cache identity、same-session 限制、粘滞 miss 和 Resume/Checkpoint 分流。

## 缓存键怎么算

```
cacheKey = sha256(前序调用滚动链 ‖ prompt ‖ 归一化后的 opts)
```

**进哈希的 opts**（改动会导致该 agent 及其后全部重跑）：
`schema` `model` `effort` `isolation` `agentType` `disallowedTools` `bashCommandClamp`

**不进哈希**：
- `label` —— 改显示标签是安全的
- `phase` —— 同上
- **`args`** —— 通过独立通道注入，这是「拍板续跑」方案的基础

## 「粘滞 miss」语义

一旦某个 agent 未命中缓存，**它之后的所有 agent 都会重跑**，即使它们自己没变。因为滚动链把前序调用的结果并入了后续的键。

实际后果：
- 改第 2 个 agent 的一个字符 → 第 1 个命中，第 2、3、4… 全部重跑
- 切换 `advisorModel` → advisor 及其后全部重跑

**设计推论**：把易变的 agent（advisor、可能要调 prompt 的）放在调用链**尾部**，或拆成独立 workflow。

## resume 的真实限制 ⚠️

### 限制 1：same-session only

journal 路径含 sessionId：
```
~/.claude/projects/<项目>/<sessionId>/subagents/workflows/<runId>/journal.jsonl
```

`/clear`、崩溃、跨天重启 → sessionId 变化 → 读不到 journal → **返回空缓存且不报错** → 静默全量重跑。

**这正是「等用户拍板」最容易踩的坑** —— 拍板往往隔了一夜，会话早就换了。

### 限制 2：脚本一字节不能改

`scriptPath` 的官方说明是「可用 Write/Edit 编辑后重跑」，但编辑会改变脚本哈希，破坏缓存。

**这与「hook 自动优化脚本」的设想直接互斥** —— 那正是砍掉需求 2 后半部分的原因之一。

### 限制 3：规模警告线

| 指标 | 警告阈值 |
|---|---|
| agent 数 | 25 |
| token 数 | 1,500,000 |

历史数据：单 run token 中位数 302k、p90 1.06M。7 个里程碑 × 3-4 agent = 21-28 个 agent，**开跑即越线**。

## Resume vs Checkpoint：两级暂停

「暂停后续跑」是两个不同的机制，**按 session 边界分流**，不要混用：

| | Resume | Checkpoint |
|---|---|---|
| 保存什么 | 计算缓存（agent 结果） | 开发状态（plan / routing / 决议 / 进度） |
| 机制 | 同 scriptPath + `resumeFromRunId` + 新 args | 新脚本，上轮结论抄进 `COMMON` |
| 前提 | 同 session、脚本一字节未改 | 无 —— 跨 session 的唯一选择 |
| 成本 | 未变前缀全部 CACHE HIT | 重跑只读 recon（中位 ~10 万 token） |

**按早退状态分流：**

1. `route-escalation-required` / `replan-required` —— 主 agent 可自动处理、**不等用户拍板、必然同 session** → 首选 resume：

   ```
   Workflow({ scriptPath, resumeFromRunId, args: { ...首轮args, ...result.nextArgs } })
   ```

   两者都走 resume，但**推进机制不同，不能混为一谈**：
   - `route-escalation-required`：`nextArgs.minRoute` 经 JS 纯函数改变 route。跨模型档（LOW/MEDIUM ↔ HIGH/CRITICAL）时 `plannerModel` 变（`model` 进缓存键）；同档升级（LOW→MEDIUM、HIGH→CRITICAL）模型不变，但 Plan prompt 内嵌了变化后的 `routing.route`（prompt 进缓存键）—— 二者任一都使 Plan 起缓存 miss、Plan 及之后重跑；Recon 的 prompt/opts 未变 → **命中**。正是「只升级 Planner 及以后，不再花钱重读代码」。⚠️ 同档升级完全靠 prompt 里的 route 字段失效，维护模板时不得删它。
   - `replan-required`：`nextArgs.replanFeedback`（**累计**的 Review blockers+concerns）与 `nextArgs.replanAttempt`（轮次计数，每轮 +1）都被拼进 **Plan prompt** —— prompt 进缓存键 → Plan 必重跑且被要求逐条吸收修订意见；Recon 同样命中。attempt 递增保证即使 Review 逐字重复同一意见，prompt 也每轮不同，不可能无限重放；超过 `maxReplan`（默认 3）次仍 revise 则模板直接 `blocked` 转人工；revise 但反馈为空则 fail-closed 直接 `blocked`。**主 agent 续跑时必须原样带回整个 `nextArgs`，不得丢弃** —— 否则同一份输入会重放同一份 Plan/Review，形成不可推进的早退循环。

2. `need-decision` —— 必须等用户拍板：
   - 用户**同 session 立即回答** → resume + `args.decisions`（1..N-1 全命中）
   - **已跨 session**（隔夜、`/clear`、重启）→ journal 已失效，resume 会**静默全量重跑** —— 用 checkpoint：新脚本抄结论进 `COMMON`，并从 harvest 固化的 `docs/ultracode/raw/wf_*.json` 读上轮完整 result（plan / routing / decisions）作为输入；`.claude/progress/*.jsonl` 提供跨会话进度摘要

⚠️ **resume 的 args 是全量替换，不是合并**：首轮 args（`repo` / `task` / `milestone` / `ts`…）必须原样带上再叠加 `nextArgs` / `decisions`，否则脚本回退到 `<占位>` 默认值。

## v0.4：Semantic Artifact Cache（跨 run / 跨 session）

原生 resume 保存的是**计算缓存**，不能跨 session；`docs/ultracode/raw/` 保存的是**历史快照**，v0.3 以前没有读回执行路径。v0.4 新增：

```text
docs/ultracode/state/<checkpoint>.json
```

`harvest-workflow` 每次固化 raw 后同步构建最新 state。state 保存 `recon/basePlan/effectivePlan/review/decisions/routing/resumeArgs`，并为目标 OpenSpec change 全部 Markdown 与 Plan 依赖代码文件记录 SHA-256 fingerprint。

`workflow-intake` 在用户再次输入 `workflow ...` 时先按 tokenScore 排序、只对前 3 个候选重算 fingerprint（5 秒 hook 预算，同 changeDir/文件的 hash 会 memoize），只注入**路径与验证结果**，不把完整 Plan 塞进 hook context：

1. `nativeResume=true`：同 session + 原 scriptPath 仍存在 + script SHA1 相同 + **journal.jsonl 已核实存在** → **必须优先原生 resume**，不要重新 author；args 取 state 的 `resumeArgs` 全量叠加本轮新 args（全量替换非合并，缺失首轮 args 会回退占位默认值制造粘滞 miss）；
2. `valid=true` 但不能 native resume：Read state JSON，把完整对象传 `args.priorState`，同时传 `checkpointKey` 与 `checkpointValidation` → OpenSpec 模板允许 `ARTIFACT HIT`；
3. `dirty=true`（上轮实现未完成或 Verify 未绿）：fingerprint 是对着 partial workspace 算的所以仍可能 valid，但 Reviewer 从未审过这份代码 → **禁止直接 Plan/Review HIT**，与 legacy 一样先廉价 CheckpointValidate；
4. `legacy=true`：这是从 v0.3 raw 回填的历史结果，没有生成时刻 fingerprint，**禁止直接 artifact hit**。同 session 仍可 native resume；否则传 `legacyUnverified=true`，由廉价 Recon/Haiku 做一次 CheckpointValidate，定向重读当前 OpenSpec 与旧 Plan 涉及代码；验证通过才跳过昂贵 BasePlan/Review；
5. 普通 `valid=false`：OpenSpec 或 Plan 依赖代码已经变化 → 不得复用历史 Plan/Review。

Artifact Restore 额外 fail-safe：当前 route 若高于历史 route，不复用历史 BasePlan；历史 Review 只有在 decisions 未变、旧 verdict=approve、历史有效 route 不低于当前 route 时才命中。模板语义不兼容时 bump `cacheVersion` 统一失效。

v0.4.1 起 fingerprint 覆盖扩大：代码侧为 `whitelist + slices.files + mustNotTouch + evidenceDependencies`（Planner 显式输出的 caller/public contract/关键测试），source 侧追加 changeDir 之外由 `args.proposalDoc/designDoc/tasksDoc/planDoc` 显式指定的自定义文档（`fingerprint.sourceExtra`）。旧 v0.4.0 state 没有 `dirtyWorktree` 字段时，resolver 按终态 status 兜底推断（red/failed/escalate 等一律视为 dirty）。

**为什么 legacy 不能直接 hash 回填**：旧 raw 并没有保存“当时的文件 hash”。如果今天才对当前 workspace 求 hash，再把它写进旧 state，会把未知历史状态伪装成“验证通过”。因此旧记录必须 native resume 或先廉价语义验证；从 v0.4 开始的新 run 才有可信 fingerprint。

**插件重装/升级本身不再等于 Plan cache 全失效**——只要 native resume 不可用但可信 fingerprint 仍有效，就转 Semantic Artifact Cache；`cacheVersion` 变化则必须重算。

## 决议边界

不要把整个 Stage 合成一个 workflow。`need-decision` 只负责返回问题；主 agent 再按上面的 session 边界选择 Resume 或 Checkpoint。Workflow 中途交互、args 结构与 determinism 的通用规则直接查 `workflow-authoring`。

## 本机计数器陷阱

`agent()` 的通用 nullable/failure 语义直接查 `workflow-authoring`。本机有界 Advisor/重试循环只额外记住一条：**计数器必须在 `agent()` 调用前自增**，否则失败返回 `null` 时可能不计数并形成死循环。

```js
calls++
const r = await agent(...)
```
