# Astra 主控：Claude Code CLI 开发与回传

本机桥接入口是 `node tools/session-bridge.mjs`。Claude Code 是命令行执行器；先 doctor 检查实际 executable 和版本。保持当前 Astra Low；它与 Claude 的 opus/sonnet 等逻辑角色分开配置。

## 创建任务

在目标工作区收集 `git rev-parse HEAD` 与 `git status --porcelain=v1 --untracked-files=all`。使用 all 是为了只排除 bridge/Workflow 自身的明确状态文件，不能把整个 `.claude/` 或 `docs/` 目录当成无关变化。新建 request 输入 JSON，替换下列占位值；不要把凭证写入文件。origin.sessionId 必须是原 Codex 会话 ID，不能用随机测试 ID代替实际返回目标。

```json
{
  "origin": {"provider":"codex","sessionId":"原Codex会话ID","cwd":"目标工作区绝对路径"},
  "worker": {"provider":"claude","displayName":"本次开发任务名称","cwd":"目标工作区绝对路径"},
  "workspace": {
    "repoRoot":"仓库绝对路径",
    "worktreeRoot":"目标工作区绝对路径",
    "baselineHead":"实际HEAD",
    "dirtySnapshot":"实际porcelain输出（干净时为空）",
    "allowedPaths":["src/被授权文件.js","test/对应测试.js"]
  },
  "work": {
    "requirement":"实际开发需求",
    "openspecChangeDir":"实际change绝对路径（没有时删除此字段）",
    "taskIds":["1.1"],
    "acceptance":["具体测试与功能验收条件"],
    "stopConditions":["发现设计失效或超出范围时返回blocked"]
  },
  "intent": {
    "enabled":true,
    "source":"user-explicit",
    "userInstruction":"用户明确要求Claude Code CLI开发并回传原Codex会话的原话",
    "requestedActions":["read-context","dispatch-work","notify-terminal"]
  },
  "notify": {"when":"terminal","required":true,"transport":"queue","deadlineAt":"实际未来ISO时间"},
  "control": {"mode":"supervised","maxRevisionRounds":2,"requestExpiry":"实际未来ISO时间","allowCreateWorker":true,"maxRuntimeMs":3600000,"permissionMode":"dontAsk","allowedTools":["Skill","Workflow","Read","Write","Edit","Bash"]}
}
```

bind 补齐 requestId、bindingId、worker sessionId、hostId、scopeHash 与授权时间并落盘；保存返回 requestId。若目标已有活跃 Claude CLI，优先按 [Channel 接入说明](claude-channel.md) 获取 `bridge_connect` 返回的 sessionId/cwd，设置 `control.workerTransport:"channel"` 与 `allowCreateWorker:false`。未接入 Channel 时可显式选择兼容 `relay`：用 resolve-target 唯一解析 sessionId/displayName，并提供 maxBudgetUsd。

示例 allowedTools 是本次开发需要的工具授权，应按实际范围收紧。allowedPaths 是协作契约与结果校验边界，并非操作系统文件沙箱。request 输入文件放在工作区外或被忽略的目录，避免建档本身改变已确认的 Git dirty 基线；之后不得修改已绑定的权限/目标/通知配置。

## 主控操作顺序

```text
doctor
bind --request-file <输入JSON> --cwd <工作区>
export-context --request-id <id> --cwd <工作区> [--read-history]
dispatch --request-id <id> --cwd <工作区> --dry-run
dispatch --request-id <id> --cwd <工作区>
status --request-id <id> --cwd <工作区>
```

无 `--read-history` 时仅交接本次明确契约，输出 history-not-requested；不能将其描述为全部历史。需要历史时使用官方只读接口；旧 transcript 在 origin.transcriptPath 显式指定。主控和 worker 不在同一 worktree 时需要 workspace.worktreeMapping 的 origin/worker 绝对路径，不自动复制代码。

派发期间不同时修改相同文件；runner 在隐藏的 Node 进程中持续运行。状态文件记录进程 ID、启动 token、心跳、Workflow 身份。不要通过再次 dispatch 来猜测运行是否结束。

## 接收与验收

worker 的真实终态生成 result.json，CLI queue 将短消息和文件引用投递到原 Codex ID。队列不会替主控执行验收；目标没有消费时状态保持 queued。主控读消息后：

Channel 模式通过 `bridge_complete` 或后台候选结果收集器验证并自动发送；报告子代理不直接运行 codex queue。`status` 的 `deliveryErrorCode`/`deliveryDiagnostic` 保留启动失败与进程退出的区别及脱敏输出。仅明确未提交的失败允许 `retry-delivery` 后 `drain`；未知发送状态先对账。

```text
receive --request-id <id> --cwd <worker工作区> --session-id <当前Codex ID>
acknowledge --request-id <id> --cwd <worker工作区> --session-id <当前Codex ID> --verdict accepted --evidence <具体证据>
```

receive 校验包 hash/身份并返回实际结果。先亲自核对改动、task 完成情况、测试退出码和证据，再 acknowledge；有缺陷用 needs-rework，需要用户决策用 needs-decision。CLI 不根据文本摘要自动接受成果。

返工是新的明确 request，引用上一 request 和所需修复，不自动从结果消息继续派发。当前同一业务目标最多两轮返工，由主控按 control.maxRevisionRounds 约定执行；超过后报告问题并等待决策。暂不提供自动多轮业务编排。

若同一 Claude session 的受控 worker 仍在执行，新切片必须使用新的 requestId，并在 `control.resumeFromRequestId` 明确引用当前 active request；`dispatch` 会将它写入持久 inbox。前一 runner 与子进程确认退出后，调度器才以相同 session ID 串行 resume。不得为排队项设置 `allowCreateWorker:true`，也不得跨 worktree 复用同一 session。

## 停止与恢复

cancel 撤销尚未发送的通知；运行中仅记录 stop-requested，不能把它当作进程已经停止。CLI/model 失败时先读 status 的 errorCode，修复配置后再决定是否安全 resume；未知进程状态不抢锁。

开发已完成但通知失败，先 status，再只处理对应 outbox。delivery-unknown 必须先在目标按 messageId 对账；不能盲目重发。普通任务不会自动读取旧 bridge request；只凭旧摘要不得恢复发送权限。

`reconcile` 只回收拥有者及相关进程已确认退出、且没有未终结 Workflow 的锁，并将遗留 sending 标记为 delivery-unknown；不发送、不重启开发。`retry-delivery` 仅重置已证明发生在发送之前的 unsupported 预检失败，随后可 drain。无法证明进程退出或 PID 已被复用时会拒绝回收。

同一 request 的重复 dispatch 只返回已有状态；新的 request 可按上述约束进入同一受控 worker 的串行 inbox。外部活跃会话优先使用 Channel，其 `dispatchStatus`/`workerReceipt` 记录目标接收，结果回传仍使用 `deliveryStatus`/`controllerStatus`。兼容 relay 的原生 success/msg_id 只证明入队。Windows 不开放 Codex resume 兼容发送：只读 stdio 状态不能证明原主控独占。退出/崩溃后的恢复必须遵循上述已实现边界。

回滚：停止新增 dispatch，对已有请求先 cancel 并检查实际进程/Workflow；不能把 stop-requested 当作已停止。确认全部退出后，可归档 `.workflow-bridge/` 状态。源码恢复只涉及本变更明确路径，保留其他未提交修改；不要在任务仍运行时删除状态。
