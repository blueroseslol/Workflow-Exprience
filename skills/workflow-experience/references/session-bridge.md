# Codex ↔ Claude Code CLI

Claude 端是 `claude` 命令行程序，Ultracode 在它的主会话内运行。无需 Claude Desktop。Codex 通过 CLI queue 接收回传，queue 仅证明入队，主控读取并写 receipt 后才是 received。

## 何时使用

当前用户明确要求 Codex 主控、Claude Ultracode 实施、完成后回原会话，或明确指定 Codex 终态通知时使用。仅读历史、仅 Codex 审阅、否定、引用示例及普通 workflow 均不启用。由主会话语义解析，不依赖固定关键词，也不引入额外 LLM 分类调用。

先核对目标 session ID、cwd 和用户范围。名称通过 `resolve-target` 唯一解析；不能取最近会话。若已在 bridge worker 中，`WORKFLOW_BRIDGE_REQUEST_FILE` 指向本任务 request；Read 并核对 worker.sessionId/cwd/requestId/scope。既有授权仅可用于同一 request，新需求不继承；撤销时调用 cancel。

## 运行前

活跃会话优先用 `control.workerTransport:"channel"`，接入步骤见 `docs/claude-channel.md`。目标首次调用 `bridge_connect`；收到 Channel 后先 `bridge_ack(requestId,messageId,sha256)`，仅 `execute:true` 才执行本次请求。重复 ACK 不重跑，未 ACK 不得启动/attach Workflow。需要拒绝尚未 ACK 的请求时用 `bridge_reject` 并给出原因；已经 ACK 的任务必须检查实际 Workflow。Channel 身份由当前 MCP 连接绑定，不从消息选择会话。

Channel 的外层主会话使用 `bridge_attach_run` 绑定真实 run，终态将 Result v1 写入 request 同目录 `candidate-result.json` 后调用 `bridge_complete`，插件验证并自动回传；后台收集同一候选文件作为兜底。普通 Markdown 不代替 Result v1。通知失败查看 deliveryErrorCode/diagnostic，仅 `bridge_drain` 补通知。不得让 Workflow Report 子代理直接调用 codex queue 或自行拼接 spawn 命令；其职责是把前序真实阶段结果汇总完整，外层负责身份与通信。

CLI 入口为插件根目录 `tools/session-bridge.mjs`，共享代码为 `bridge/`，必须随插件一起存在。所有路径使用绝对路径；Windows 传字符串数组，不能把消息拼接成 shell 程序。

1. 主控按 `docs/codex-controller.md` 建立 request、bind、export-context。
2. 外层读 context.json 和 OpenSpec，保留权限/文件/task 边界，校验 hash。
3. 显式调用 `workflow-experience:workflow-experience` 和原生 `workflow-authoring`，再调用 Workflow。非交互 `-p` 中不能只靠 `ultracode` 关键词触发。
4. Workflow 脚本由原生 authoring 保存；bridge 只接受工作区内脚本或该精确 Claude session 的 `workflows/scripts/`。启动获得 run ID 后调用 `attach-run`；此时快照可能尚未落盘，状态会是 awaiting-snapshot。
5. 每个子代理保持 SendMessage/ListAgents 禁用。不要把 bridge request 放入 args、BasePlan 或缓存键；桥接是外层职责。

## Workflow 终态

Workflow 自身的最终 return 对象必须有顶层 `status`，值为 `completed`、`blocked` 或 `failed`；自定义 schema 也必须将它列为 required。先用 `inspect-run` 获取真实 runId/scriptPath/terminalFingerprint。只有可解释的真实快照终态可 complete；普通 Claude 文本结果、CLI exit 0 都不够。结果文件 `candidate-result.json` 需要：

```json
{
  "schemaVersion": 1,
  "requestId": "绑定的 requestId",
  "workflowRunId": "wf_真实ID",
  "scriptPath": "绝对脚本路径",
  "terminalFingerprint": "inspect-run 返回值",
  "workStatus": "completed",
  "summary": "实际完成的内容",
  "baselineHead": "request 的基线",
  "currentHead": "实际 HEAD",
  "completedTaskIds": ["1.1"],
  "remainingTaskIds": [],
  "changedFiles": ["授权范围内的相对路径"],
  "commits": [],
  "tests": [{"command":"实际测试命令","cwd":"绝对工作区","exitCode":0,"evidence":"实际输出文件或证据引用"}],
  "blockers": [],
  "nextActions": [],
  "sourceRefs": ["真实 run 或代码证据"]
}
```

未运行测试用 `exitCode:null` 和 `notRunReason`，不能写成通过。failed/blocked/cancelled 如实填写。task IDs 不能超出 request；changedFiles 必须在 allowedPaths 内。

外层依次调用 `complete --result-file ...`、`drain`。受控 runner 会在外层退出后收集结果并自动 drain；重复 complete/drain 不重复投递。现有 Stop hook 只记录匹配的终态/候选结果到 outbox，不调用模型或 CLI。外层崩溃后，只恢复 drain，不能为补通知重跑 Implement。

## CLI 命令

共同参数：`--cwd <worker绝对工作区> --request-id <id>`；自定义工作区内 store 用 `--store-root <绝对路径>`。

| 命令 | 额外参数 |
|---|---|
| doctor | 无，只探测帮助与版本 |
| bind | --request-file，支持 --dry-run |
| export-context | 可选 --read-history 或 --bundle-file |
| dispatch | 可选 --dry-run；精确恢复使用 --resume |
| attach-run / inspect-run | --run-id wf_x；inspect 可用已绑定 ID |
| complete | --result-file |
| drain / send | 可选 --dry-run；send 可用 --message-file 指定已生成 outbox |
| receive | --session-id 原 Codex ID（或当前 CODEX_THREAD_ID） |
| acknowledge | --session-id、--verdict、--evidence |
| status / cancel | 无 |
| reconcile / retry-delivery | 无；前者只对账，后者仅允许明确未提交的预检失败 |

## 故障边界

- 普通 worker 默认不改模型；显式 `control.workerModel` 才覆盖。模型不可用/403 交给用户修复通道，不自动改全局配置或路由。
- `dispatch` 新建 worker 需要 allowCreateWorker。同一 request 只允许在尚未进入 Workflow 时恢复；新切片用新的 requestId 和 `resumeFromRequestId` 引用已确认终态的前序 request。
- 同一 Claude session 已有受控 worker 时，新切片进入持久 inbox，等前一 runner 与子进程退出并释放 lease 后以原 session ID 串行 resume；队列项必须明确引用当前 active request。跨 worktree、身份漂移或所有权不明时阻塞，不启动第二个 writer。
- 已有活跃 CLI 优先选择 `channel` 并确认目标接入；`status.receiptConfirmed` 只在目标 ACK 后为真。离线持久入队，超时/断线不自动重发。兼容 `relay` 需显式选择，提供固定 ID、已解析 displayName 和 maxBudgetUsd；它多一次模型调用，发送成功仍不能证明目标收到。
- queue 在本机已验证输出 `Queued message ... for thread ...`；它不保证空闲目标立即运行。主控下一次消费消息时 receive；不得把 queued 报成 accepted。
- 发送后崩溃为 delivery-unknown。先在目标核对 messageId 并 receive；没有依据不要重复发送。
- Windows 的只读 history 使用 stdio App Server。其 notLoaded/idle 不证明外部会话空闲，不能据此强行 resume。
