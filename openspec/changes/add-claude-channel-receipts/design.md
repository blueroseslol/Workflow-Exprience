# 设计与证据边界

## 决策

使用同机文件队列和 stdio MCP，避免新增 HTTP 身份认证及端口。每条 request 的 channelMessage 与发布/接收状态在同一个原子 state 文件内提交，messageId 从 request 与授权摘要确定，正文另带 SHA-256。接收端校验 context 和授权基线。

0.5.3 区分会话与代码目录：worker.cwd 和 store 保持会话根目录，workspace.worktreeRoot 声明 Git 工作区。仅 Channel 允许显式工作区为会话根目录的后代；普通 worker/relay 保留相等约束。Git、allowedPaths、源文件哈希、changedFiles 和工作区脚本校验统一以 worktreeRoot 为准，不扩大到会话父目录。

会话 ID 来自 Claude MCP 子进程环境，SessionStart/SessionEnd 登记 epoch，阻断 `/clear` 后保留旧环境的连接。接入必须由目标 bridge_connect 激活；插件仅被加载不会消费任务。跨工作区同 session 的 Channel 连接使用用户级锁互斥。

发布前持久化意图。进程崩溃后无法区分通知是否已经到达，所以默认不重新发布；目标通过 pending 查证后 ACK 或明确拒收。ACK 重复时 execute=false。已收到请求只有经过原 Workflow 快照验证的终态才能放行下一任务。未 ACK 的拒收可释放队列，已 ACK 的拒收被禁止。

结果回传继续复用 complete/drain/receive/acknowledge，不把请求 received 写入结果 deliveryStatus。取消只表达意图，不把可能已执行的请求标成已停止。

## 验证层次

- 官方文档：Channels MCP notification 与 tools、开发启用参数、CLAUDE_CODE_SESSION_ID 和恢复限制。
- 本机：Claude 2.1.260；plugin manifest 验证；已安装插件 ID 的只读查询。
- 自动验收：合成契约与真实 Git 临时仓库、SDK 客户端与独立打包 MCP 子进程，零模型调用。
- 尚未验证：真实 Claude 会话认证/预览策略、UI 开发确认、模型 bridge_ack 调用、真实 Workflow 到 Codex 回传。不得以模拟客户端替代这些证据。

## 已知限制

保证持久去重与不盲目重跑，不声称进程崩溃下业务副作用 exactly-once。存储属于同一 OS 用户信任域；拥有本机文件写权限的恶意进程不在此协议的隔离范围。断线期间已 ACK 但未形成 run 的请求保留待核对，不能自动重做。
