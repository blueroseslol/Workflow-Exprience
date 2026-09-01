# resume / args / 缓存键语义

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

## 因此：拍板边界用「一个决议一个 workflow」

**不要**把整个 Stage 合成一个 workflow 靠 resume 续跑。**要**这样做：

```js
// 里程碑 5.4 的脚本
const DECIDED = args?.decisions ?? {}

// ... Plan 阶段产出 openQuestionsForUser
if (plan.openQuestionsForUser.length && !DECIDED['5.4']) {
  return {                          // 早退不消耗 agent、不触发 miss
    status: 'need-decision',
    milestone: '5.4',
    questions: plan.openQuestionsForUser,
    plan,
  }
}
```

主 agent 拿到 `status: 'need-decision'` 后用 **AskUserQuestion** 问用户（脚本内无任何交互 API），拿到答复后按 session 边界分流（见上「两级暂停」）：

- **同 session**（用户立即回答）：同 scriptPath + `resumeFromRunId` + 新 `args.decisions`。因为 args 不进缓存键，把决议拼进里程碑 N 的 prompt 后，1..N-1 全部命中、N 及之后重跑 —— 正是想要的语义。
- **已跨 session**：写一个新脚本，把上一轮结论抄进 `COMMON` 常量（checkpoint）。重跑只读 recon 在此时不是代价而是唯一路径 —— journal 本来就随旧 session 失效了。上轮 plan / routing / decisions 从 `docs/ultracode/raw/wf_*.json` 恢复。

## args 的正确用法

```js
const TS = args?.ts ?? 'unknown-ts'                  // ✅ 时间戳外部注入
const ADVISOR_MODEL = args?.advisorModel ?? 'fable'  // ✅ 可切换参数
const DECIDED = args?.decisions ?? {}                // ✅ 拍板结论
```

**传参注意**：数组/对象要传真实 JSON 值，不要传 JSON 字符串。
```js
// ✅ Workflow({scriptPath, args: {files: ['a.ts','b.ts']}})
// ❌ Workflow({scriptPath, args: '{"files":["a.ts"]}'})   // args.files.map 会 throw
```

## 为什么脚本里不能有 Date.now()

`Date.now()` / `new Date()`（无参） / `Math.random()` 在沙箱里**会 throw**。

原因：resume 依赖脚本的确定性。如果脚本每次执行都产生不同的值，缓存就无法复用。

替代：
- 时间戳 → 通过 `args.ts` 注入，或在 workflow 返回后由主 agent 打戳
- 随机性 → 用索引变化 prompt/label（`agent(p, {label: \`probe:${i}\`})`）

## 早退 vs agent 失败

| 情形 | 返回 | 消耗 agent |
|---|---|---|
| 脚本 `return` | 你的返回值 | 否 |
| 用户 skip 该 agent | `null` | 是（计数） |
| subagent 终端错误 | `null` | 是（计数） |
| stage 抛异常（pipeline 内） | 该 item 变 `null`，跳过剩余 stage | 是 |

**所以任何计数器必须放在 `agent()` 调用之前自增**，否则失败不计数 → 死循环。

```js
// ❌ 死循环风险
const r = await agent(...); if (r) calls++

// ✅
calls++; const r = await agent(...)
```
