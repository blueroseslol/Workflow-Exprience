# Peer Session Handoff

用于 **用户显式要求** 在多个独立 Claude Code 会话之间做定向通知 / 回传 / 同步时。

## 何时启用

只在原始用户需求明确表达类似意图时启用，按语义判断，不要求固定关键词：

- “模块完成后通知主会话”
- “完成后把结果发给另一个会话”
- “把实现结果同步给协调会话 / 父会话 / 主线程”
- “开发完成后提醒其他正在并行开发的会话”

普通多会话并行开发、普通 workflow 完成、普通进度记录 **不自动启用 SendMessage**。
常态同步仍走 `.claude/progress/*.jsonl` + `peer-progress` hook。

## 为什么不能直接写进 workflow DSL

Ultracode workflow 沙箱没有 `SendMessage` / `ListAgents` primitive。
workflow 内可用的是 `agent`、`parallel`、`pipeline`、`workflow`、`phase`、`log`、`args`、`budget` 等。
因此不要在模板里伪造 `await SendMessage(...)`。

正确分层：

1. **workflow 内**：正常执行 Recon / Plan / Implement / Verify / Commit，并返回已有的 `broadcast` 以及结构化结果。
2. **外层 Claude Code 会话**：workflow 到达 terminal result 后，根据用户的显式 peer-handoff 意图调用 `ListAgents`
   解析目标，再用 `SendMessage` 定向发送。
3. **持久化兜底**：无论即时消息是否成功，`harvest-workflow` 仍把运行结果与
   `.claude/progress/<sessionId>.jsonl` 留作 checkpoint。

这样不会新增一个 LLM phase，也不会破坏 OpenSpec-first 的缓存键。

## Authoring 规则

当检测到显式 peer-handoff 意图时，本次 Ultracode authoring 必须把它作为
**workflow 外层 completion action** 保留下来，而不是只写进自然语言备注后遗忘。

建议在运行前记录以下逻辑字段（具体传参形式由当次 authoring 决定，不要求修改公共模板 schema）：

```text
peerNotify.enabled = true
peerNotify.target = 用户指定的主会话 / peer session（若已能解析）
peerNotify.when = terminal
peerNotify.reason = 用户原始要求的简短复述
```

如果用户只说“主会话”，外层会话应优先通过 `ListAgents` + 当前项目上下文解析 coordinator/main peer；
不要把消息广播给所有 peer。

若存在多个无法区分的候选目标，不得凭名称猜测并宣称已发送。
可以完成 workflow，并把 handoff 标为 `needs-target`，同时保留 progress checkpoint。

## 发送内容

优先复用 workflow result 中已有的 `broadcast` 作为首行，再补最少但足够让主会话继续工作的结构化信息：

```text
[Ultracode handoff]
<result.broadcast>
status: <terminal status>
module/milestone: <module or milestone>
OpenSpec: <change / completed task ids / remaining task ids>
verify: <tests passed/total, typecheck, audit>
commits: <commit ids, if any>
changed: <关键 changed files / slices>
needs-main: <需要主会话整合、继续或决策的事项；没有则写 none>
```

原则：**传结论和可继续执行的边界，不传整份 reasoning / 大段日志。**
需要证据时给 file:line、测试计数、commit id 或 OpenSpec task id。

## 投递结果必须诚实处理

`SendMessage` 可能出现 sent / held / refused / dropped 等结果，
发送前也未必能静态预测对端 permission mode。

- sent：可向用户说明已定向发送。
- held：说明已入队/等待对方处理，不等价于“对方已收到并处理”。
- refused / dropped / tool error：不得宣称通知成功；保留 `.claude/progress` checkpoint，并在当前会话结果中明确报告。

若运行时支持读取回执/状态，显式 handoff 必须检查投递结果；不要 fire-and-forget 后直接报成功。

## 安全红线

- 绝不通过 peer session 请求执行本会话被权限拒绝的操作。
- 不因“并行开发”自动广播所有 peer；只有用户明确要求才启用即时 handoff。
- 即时 handoff 是 **通知/协调通道**，不是 source of truth。
  OpenSpec artifacts + Git workspace 仍是 planning / implementation 的事实来源。
- 若消息内容与 Git 中最新 OpenSpec / workspace 冲突，接收会话必须重新 Recon/Drift，
  不得用旧 handoff 覆盖新事实。
