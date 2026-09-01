# ADR-004：不使用 TeamAgent，advisor 落在自定义 subagent

**日期**：2026-09-01
**状态**：已采纳

## 背景

用户要求"添加 TeamAgent 以及 advisor 说明，让 Sonnet 遇到问题时使用 advisor（次数可通过 ultracode 变量修改，默认最高 5 次）"。

## 决定

**不使用 agent-teams（teammate）。** advisor 实现为 `agent(prompt, {model, schema})` + 脚本内计数器。

## 理由

**不是因为 feature gate 关着** —— `~/.claude.json` 的 `cachedGrowthBookFeatures` 里 `tengu_amber_flint = true`，启用只差一个本地 env 或 `--agent-teams` flag。

真正的理由有三条：

### 1. workflow 脚本没有 spawn teammate 的 API（决定性）

沙箱注入的全局固定 11 个：`agent` / `parallel` / `pipeline` / `workflow` / `phase` / `log` / `args` / `budget` / `console` / `setTimeout` / `clearTimeout`。

成为 teammate 的唯一途径是主循环模型调 Teammate 工具 —— 那已经跳出 workflow 脚本的执行模型。你不可能在 `await agent(...)` 旁边写 `await teammate(...)`。

本项目的产物是 **workflow 脚本**，所以这一条就足以否决。

### 2. 语义与 advisor 的需求互斥

teammate 通信走 `~/.claude/teams/<team>/inboxes/<agent>.json` 文件邮箱 + 轮询。`SendMessage` **不返回对方的答复** —— 它是入队，对方下一轮工具循环才 drain。

而 advisor 需要的是：
```js
const v = await askAdvisor(...)
if (v.verdict === 'stop-and-ask') return { status: 'need-decision', ... }
```

要拿一个值来判分支。teammate 给不了这个语义。

顺带：上限 5 次在 teammate 模式下也形同虚设 —— 那会退化成"5 条 SendMessage"，而对方可以主动发第 6 条。

### 3. Windows 上失去唯一卖点

实测 `teammateMode` 在 Windows 只能落 `in-process`（tmux/iterm2 不可用，走 `"Couldn't open a teammate pane — running in-process instead."` 回退）。可视化没了，只剩额外的邮箱轮询开销。

## 后果

### advisor 的实现

```js
const ADVISOR_MODEL = args?.advisorModel ?? 'fable'   // 默认 fable，传 'opus' 切换
const ADVISOR_MAX = args?.advisorMax ?? 5
let advisorCalls = 0

async function askAdvisor(question, context) {
  if (advisorCalls >= ADVISOR_MAX) return null
  advisorCalls++            // ★ 调用前自增
  return await agent(..., { model: ADVISOR_MODEL, effort: 'high', schema: ADVISOR_SCHEMA })
}
```

两个要点：

**计数器必须在调用前自增。** 用户 skip 或 subagent 终端错误都返回 `null`。只在成功时 `++` 会导致 advisor 连续失败时死循环。

**advisor agent 必须放调用链尾部或拆成独立 workflow。** `model` 进缓存键，切换 `advisorModel` 会让它**及其后所有 agent** 重跑。

### 不写 team 定义

`teams/<slug>/config.json` 是**运行时产物** —— 代码里没有任何枚举 `teams/` 并把成员当可生成对象的逻辑（仅有的两处遍历是 GC）。手写一份放进仓库，只会让未来的读者以为它能用。

### 三层的定位

| | `agent()` | `.claude/agents/*.md` | teammate |
|---|---|---|---|
| 是什么 | **动词** —— 一次调用 | **名词** —— 一份人设 | **进程** —— 常驻协作者 |
| 返回 | `await` 得到值 | 不返回，被引用 | 无返回，异步推送 |
| 触发方 | workflow 脚本 | 被 `agentType` 引用 | 主循环调 Teammate 工具 |

前两者不是竞争关系 —— `.claude/agents/*.md` 是被 `agent()` 通过 `agentType` 引用的**参数**。

本项目目前不放 `agents/` 目录，因为：裸 skill 目录下的 `agents/` **不会被自动加载**（发现路径只有 `~/.claude/agents`、项目 `.claude/agents`、plugin 三档），而做成 plugin agent 又会丢失 `permissionMode` / `hooks` / `mcpServers` 三项。

用户已有 `D:/AI/Skill/fable-advisor`（完整 plugin），需要固化 advisor 人设时直接复用它。

## 与需求 8 的关系

**正交，不是替代。**

- teammate 是我 spawn 的下属，`name@team` 寻址，**层级**关系
- peer session 是用户自己开的另一个 Claude Code，独立进程与权限域，**对等**关系

需求 8 描述的"同项目多个会话互相提醒"明确是后者。已实测 `ListAgents` 在**无 agent-teams** 的情况下正常工作：

```
Peer sessions (2):
  ldl-ugc-10 [02591c] · interactive · idle · started 4h ago
  ldl-ugc-da [30d2cd] · interactive · busy · started 40m ago
```

**红线**：绝不请求 peer session 执行本会话被权限拒绝的操作 —— 权限决定是 per-session 的，那等于绕过用户的授权。
