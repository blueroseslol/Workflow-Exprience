# Claude 活跃会话 Channel 与接收回执

> 0.5.4 起功能暂时停用，以下为历史接入文档。当前版本不注册 MCP/Channel，写操作默认返回 bridge-disabled；请使用普通 Workflow 在当前会话交付。

本地链路：Codex `dispatch` → 工作区持久队列 → 目标 Claude 的 MCP Channel → 目标 `bridge_ack` → Codex `status`。转发不新建 Claude CLI，不调用转发模型，不开放 HTTP 端口。原来的 `worker` 和显式 `relay` 保留兼容；既有 request 的 transport 不可更改，新建 request 选择 `channel`。

## 一次接入目标会话

1. 确认更新后的插件包含 `.mcp.json`、`bridge/channel-server.cjs`、`bridge/vendor/mcp-sdk.cjs` 与 SessionStart/SessionEnd hooks。开发构建用 `npm ci`、`npm run build:channel-sdk`；分发包含 bundle，无需在安装目录安装依赖。
2. 在目标 CLI 完成当前任务后退出，使用**明确原 session ID**恢复，不与原进程并行恢复，不使用 `--continue` 或省略 ID 的 `--resume`。本机已安装插件 ID 为 `workflow-experience@workflow-experience`，启动命令如下：

   ```powershell
   claude --resume <原Claude会话ID> --dangerously-load-development-channels plugin:workflow-experience@workflow-experience
   ```

   在 Claude 的开发 Channel 提示中确认本地开发接入。此参数只选择本插件的开发通道，工具权限及组织策略照常生效。若插件来自其他 marketplace，替换成 `claude plugin list --json` 返回的精确 ID。不能用临时 relay 来代替这个目标端接入步骤。
3. 在目标 Claude 输入：**“请接入 Workflow Bridge，调用 bridge_connect，并返回 sessionId 和 cwd。”** 返回值来自 Claude 创建 MCP 子进程时的环境及 SessionStart 登记，不接受外部消息指定身份。
4. 用返回的 sessionId/cwd 建立 Codex request。每次 MCP 重连需要重新调用 `bridge_connect`。普通会话只加载 MCP 时不消费队列；`/clear` 或交互切换会话会使旧连接失效，需明确 ID 重启恢复。

Channels 属于研究预览，需使用支持该能力的 Claude 认证与组织策略。看到 MCP online 或 `connected` 不代表入站通知已启用；只有任务 ACK 证明目标收到。当前自动验收是本地真实 MCP 子进程和模拟 Claude 客户端，尚未证明用户真实会话的认证、预览确认和模型工具调用。

## Codex 请求和查询

### 会话目录与 Git 工作区分离（0.5.3）

`worker.cwd` 始终保持 `bridge_connect` 返回的会话目录；`workspace.worktreeRoot` 声明实际 Git 工作区。Channel 允许工作区为会话目录下的子目录；跨到外部目录或链接解析后越界仍拒绝。Git 基线、allowedPaths、上下文文件哈希、changedFiles 和工作区内 Workflow 脚本都以 worktreeRoot 为基准。CLI `--cwd` 与 store 仍位于会话目录，确保原 Channel 能发现请求；不要把 --cwd 改成子仓库。

本例配置：

```json
{
  "worker": {"provider":"claude","hostId":"local","sessionId":"4a69baa0-7a34-4e18-a898-640adecf306b","cwd":"D:/AI/Website/LDL_UGC"},
  "workspace": {
    "repoRoot":"D:/AI/Website/LDL_UGC/backend",
    "worktreeRoot":"D:/AI/Website/LDL_UGC/backend",
    "allowedPaths":["src","openspec"]
  }
}
```

此处为字段示例，baselineHead/dirtySnapshot 需从 backend 读取，allowedPaths 应按实际任务授权声明，其余必填字段沿用完整契约。已绑定请求不可更改 workspace；旧错误绑定需取消并新建。更新安装后须重载目标 MCP 并重新 bridge_connect，旧进程仍使用旧验证代码。

沿用 [主控请求结构](codex-controller.md)，设置：

```json
{
  "worker": {"provider":"claude","hostId":"local","sessionId":"bridge_connect 返回值","cwd":"返回的绝对工作区"},
  "control": {
    "mode":"supervised","maxRevisionRounds":2,
    "workerTransport":"channel","allowCreateWorker":false,
    "receiptTimeoutMs":120000,"requestExpiry":"实际未来 ISO 时间"
  }
}
```

以上是替换字段，其他 workspace/work/intent/notify 必填项照常保留。依次执行 `bind`、`export-context`、`dispatch --dry-run`、`dispatch`、`status`。共同参数为 `--cwd <目标工作区> --request-id <id>`。默认 `.workflow-bridge` store；自定义 store 时目标 MCP 环境 `WORKFLOW_BRIDGE_STORE_ROOT` 必须与 CLI `--store-root` 一致，不能靠消息扩大读取目录。

| 查询字段 | 含义 |
|---|---|
| `dispatchStatus: queued` | 已持久入队，尚未向目标发布 |
| `dispatchStatus: awaiting-receipt` | 已记录发布意图，可能已送达，尚无目标回执 |
| `dispatchStatus: receipt-timeout` | 入队或发布后超过等待期限，仍未确认；不是发送失败或执行失败 |
| `dispatchStatus: received`、`receiptConfirmed:true` | 目标已调用 ACK；`workerReceipt` 含消息哈希、目标 ID、连接 ID、接收时间 |
| `dispatchStatus: refused` | 目标明确拒收，`workerRejection` 保存原因 |
| `dispatchPhase` | 原始持久投递阶段，区别于超时等查询派生状态 |
| `channelOnline` | 接入连接最近心跳及进程存活，不能证明通知被 Claude 接收 |
| `channelErrorCode` | 当前连接最近错误，例如基线漂移；成功轮询后清除 |
| `workStatus: received / running / completed / blocked / failed` | 已收件 / 已绑定 run / 通过原有结果验证的业务终态 |
| `deliveryStatus / controllerStatus` | 保留原来 Claude 结果返回 Codex 的投递与验收状态，与请求收件状态分开 |

等待超过 `receiptTimeoutMs` 不自动丢弃消息；请求过期前目标接入后仍可收到并 ACK。`status` 是只读查询，不恢复执行、不重发；Codex 可周期调用，无需开新的 Claude 进程。

## 目标执行协议

1. 读取 Channel 的 requestId/messageId/sha256，调用 `bridge_ack`。只在 `execute:true` 时执行新任务；`execute:false` 是重复确认，禁止重跑。
2. 核对 request、context，按 [session-bridge](../skills/workflow-experience/references/session-bridge.md) 显式加载 Workflow skill 并运行。`attach-run` 在 Channel 模式要求已有 ACK。
3. 外层用 `bridge_attach_run(requestId,runId)` 绑定真实 Workflow，等待终态后把 Result v1 写到 request 同目录 `candidate-result.json`，调用 `bridge_complete(requestId)`。插件验证后自动经 Codex CLI 发送，并返回 `deliveryStatus` 和失败诊断。MCP 后台也会收集该候选文件并执行相同验证/回传，防止模型只写文件而遗漏发送。只有 Markdown 报告时会显示 `needs-result-evidence`，不伪造完成证据。
4. 失败只调用 `bridge_drain(requestId)` 补通知；仅明确发生在提交前的失败，可用 `retryPreflight:true` 重置后再发。`delivery-unknown` 必须先对账。原 CLI complete/drain 保留兼容；不能让 Workflow Report 子代理直接 `spawnSync('codex', ...)`。ACK 不能代替工作完成、测试证据或主控验收。

队列在同一目标会话内串行：ACK 后也不放行下一个任务，直到前一个存在经快照验证的结果。后续 request 应在前序结果之后导出当前代码基线；若提前排队后基线发生变化，会阻塞发布，需重新核对并建立新 request。

## 故障与恢复

- **离线**：消息保存在 store，接入后发布。
- **发送中崩溃、断线或超时**：不自动重复注入。目标调用 `bridge_pending` 核对原消息；未接收的有效任务可 ACK，已经 ACK 的任务先查原 Workflow，不自动重启。
- **目标拒绝未启动任务**：`bridge_reject(requestId,messageId,sha256,reason)`。只能拒绝尚未 ACK/绑定 run 的消息，可用于明确关闭已取消、已过期的未启动消息并释放队列；拒收不是业务完成。
- **取消已可能送达的任务**：只表示 `stop-requested`。已 ACK 的任务需核对并终结实际 Workflow；取消、超时或断线均不能证明执行已停止。
- **身份变化**：缺少环境 ID、SessionEnd、epoch 改变、cwd 不一致、第二个连接抢占均拒绝；不按最近会话或名称猜目标。MCP 环境在进程内不会随 `/clear` 更新，因此同时校验生命周期 hook。
- **信任边界**：这是同一操作系统用户下的协作协议，不是隔离恶意本机进程的沙箱。目标身份来自绑定的 MCP 连接，回执内容哈希用于防止误路由与状态漂移。

## 验收

`node tools/verify-channel.mjs` 覆盖持久化、身份、ACK、超时、断线、取消、去重、串行、生命周期以及真实 stdio 子进程往返；`node tools/verify-all.mjs` 运行全部离线回归。两者均不调用模型。

真实会话接入后仍需验证：空闲收到并 ACK；忙碌时收到并 ACK；重复 dispatch 不重复执行；目标断线后显示未确认；Workflow 终态能回传原 Codex 并验收。不能把离线协议测试当成上述真实端到端验收。

官方依据：[Channels](https://code.claude.com/docs/en/channels)、[Channel 协议](https://code.claude.com/docs/en/channels-reference)、[会话环境变量](https://code.claude.com/docs/en/env-vars)。

## 2026-09-15 Windows 回传故障修复

实际旧任务在 Workflow Report 子代理内直接运行 `spawnSync('codex', args)`，并将 `status=null` 映射成 1，遗漏 `p.error`；之前还出现 `python: command not found`。因此原报告的“codex queue exit 1”不能证明 Codex 已启动或拒绝消息。该旧任务只写 Markdown，没有本桥 request/result 账本，不能据此重建已验收终态，也不自动重发它。

本机只读复现：在移除原生 codex.exe、保留 npm shim 的子进程 PATH 中，直接 spawn 返回 `status:null,error:ENOENT`。旧解析器匹配 npm shim 首个 `%dp0%\\node.exe` 后跳过整个 shim；已改为匹配 `node_modules` 内真实 CLI 入口，并固定预检与发送使用同一 executable。修复后 npm Codex 0.153.0 的版本、queue help 和原主控 thread/read 均通过，未向真实任务发送测试消息。

新回传会保存 `deliveryErrorCode`、`deliveryDiagnostic`（phase、退出码、signal、脱敏 stderr/stdout）、实际 executable。启动失败与进程非零退出分开；只有证明未提交的失败允许重置，防止通知恢复触发重复开发。
