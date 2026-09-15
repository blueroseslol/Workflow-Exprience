---
name: workflow-bridge-controller
description: 在 Codex 中通过 Workflow-Experience Bridge 向用户指定的 Claude Code 会话派发任务、检查 Channel 接收回执、接收并验收结果，以及排查或恢复失败通知。适用于 Codex 主控与 Claude Code 协作；普通代码开发或仅提及 Claude 不触发发送。
---

# Workflow Bridge 主控

本 Skill 供 Codex 使用；Claude 端执行仍由 workflow-experience 插件负责。使用已有用户授权及其模型、任务和费用边界；加载 Skill 本身不授权向其他会话发送消息。用户仅要求查询/诊断时只读检查，不派发、取消或补发。用户已明确要求向指定会话继续开发时，按当前授权直接准备并派发，不重复请求相同授权。

## 找到已安装运行时

运行本 Skill 目录下 `scripts/locate-runtime.cjs`，例如用 argv 调用 `node <Skill绝对目录>/scripts/locate-runtime.cjs`。它只读查询本机 Claude 插件安装记录，返回 `cli`、`controllerGuide`、`channelGuide`、`resultContract` 的绝对路径与版本。

优先使用此运行时，避免拿当前项目的相对 `tools/` 路径或固定缓存版本猜位置。若用户明确指定运行时，可通过 `WORKFLOW_BRIDGE_PLUGIN_ROOT` 传入其绝对目录。缺失安装或多个安装候选时报告具体情况；安装 Skill 不会自动安装 Claude 插件或启用 Channel。

首次派发阅读返回的 `controllerGuide` 和 `channelGuide`。普通查状态只需 `cli status`；收到结果或排查结果结构时再阅读 `resultContract`。文档中示例模型、会话、目录和版本不覆盖当前用户选择。调用 `node <cli> doctor` 可检查 CLI 帮助/版本，不能据此声称真实通信成功。

## 绑定正确身份和目录

- `origin.sessionId/cwd` 是当前原主控 Codex 的实际身份，`replyTo` 与其一致。当前 `CODEX_THREAD_ID` 或产品任务信息可作证据，不能从目标结果或任意历史请求猜原主控。
- 用户已给出目标 ID/cwd 且本次已有核验证据时复用。仅有会话名时通过 `resolve-target --name <名称> --cwd <会话目录>` 唯一解析；若在线列表缺失，可核对明确历史记录，但离线状态不能伪装成已接入。
- 活跃目标使用 `control.workerTransport: "channel"`、`allowCreateWorker:false`；目标需启用开发 Channel 并调用 `bridge_connect`。其 `connected` 只证明接入，不证明某条任务收到。没有指定时不要切到 relay、恢复另一副本或新建 worker。
- `worker.cwd` 和所有 Bridge CLI 的 `--cwd` 是 Claude **会话目录**，store 默认位于该目录的 `.workflow-bridge`。`workspace.worktreeRoot` 是实际 **Git 工作区**，`repoRoot` 按真实仓库填写。Channel 允许 worktreeRoot 是会话目录内显式声明的子目录。
- 在 worktreeRoot 收集 HEAD 和 `git status --porcelain=v1 --untracked-files=all`；`allowedPaths`、上下文文件与结果 `changedFiles` 相对此工作区，不能为了通过校验把整个父目录纳入授权。origin 与 worker 的 cwd 不同，还需按契约声明 `workspace.worktreeMapping`。

不硬编码用户的 backend 会话 ID。保留原需求的 task IDs、验收项、停止条件、已批准路径和费用次数。发到正在运行的目标只代表协调，不意味着可以并发修改其文件。

## 派发与接收确认

依照运行时完整契约准备输入 JSON：origin/worker/workspace/work/intent/notify/control。Channel 请求要求明确已有 sessionId；设置合理的 requestExpiry、通知 deadlineAt 和 receiptTimeoutMs，不使用已过期示例。scopeHash 由 `bind` 计算，不手工伪造。输入文件放在忽略目录或工作区之外，避免自身改变 Git 基线。

通过 Node CLI 顺序执行（路径和文本作为 argv 参数）：

```text
bind --request-file <输入JSON> --cwd <会话目录>
export-context --request-id <返回ID> --cwd <会话目录>
dispatch --request-id <ID> --cwd <会话目录> --dry-run
dispatch --request-id <ID> --cwd <会话目录>
status --request-id <ID> --cwd <会话目录>
```

有 `--store-root` 时每一步保持一致，并核对目标 Channel 使用同一个 store。已绑定 request 不修改身份或工作区；新任务新建 request。仅查状态时使用已有 request，不用重复 dispatch 探测完成情况。

派发后按用户要求等待/查询状态，若只发出便要交接，也明确说明是否有 ACK：

| 证据 | 可以报告的结论 |
|---|---|
| `dispatchStatus:queued` | 已入队 |
| `awaiting-receipt`、`receipt-timeout` 或 `channelOnline:true` | 目标是否收到仍待确认 |
| `receiptConfirmed:true` 与匹配的 `workerReceipt` | 指定消息已被目标确认接收 |
| `workStatus:completed` 与验证结果 | 执行端声明完成，待主控验收 |
| `deliveryStatus:queued` | 结果通知已进 Codex 队列，尚不能声称主控已验收 |
| `controllerStatus:accepted` | 主控已记录验收 |

旧 held peer 消息与 Channel 消息独立。切换通道前对旧消息明确处理，避免之后批准旧消息造成重复执行。不要替目标修改全局 crossSessionInbound。

## 结果验收与仅补通知

Claude 外层用 `bridge_attach_run` 绑定实际 Workflow；写 request 同目录 `candidate-result.json` 后由 `bridge_complete` 或收集器验证并回传。Codex 不代替 Claude 生成 worker ACK，也不让 Report 子代理直接拼接 `spawnSync('codex')`。Markdown 报告或 Workflow 弹出 completed 均不代替合格结果。

主控收到结果后使用 `receive --request-id <ID> --cwd <会话目录> --session-id <当前原Codex ID>` 校验身份与哈希。再检查真实代码差异、task 状态、测试退出码/日志及未验证范围。确认通过才 `acknowledge --verdict accepted --evidence <实际验收证据>`；有缺陷用 `needs-rework`，需要用户决策用 `needs-decision`。不得把旧日志写成新测试。

通知失败先读 `status`、`deliveryErrorCode`、`deliveryDiagnostic` 和对应 outbox。只有记录证明提交前失败，才 `retry-delivery` 后 `drain`。`delivery-unknown` 先在原主控按 messageId 对账，不能盲目重发。业务已完成时只恢复通知，不重跑 Implement；cancel 的 stop-requested 也不证明实际执行已停。

接入、身份、范围或基线有阻塞时，保留准备好的请求和具体证据，说明需要修复哪一项；不伪造回执。后续返工仍使用当前用户授权内的新 request，并遵守本次返工上限与预算。
