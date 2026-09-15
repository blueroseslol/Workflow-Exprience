# 验收任务

- [x] 1. 新增 Channel transport、持久消息、哈希及 ACK/拒收状态。
- [x] 2. 实现显式连接、会话环境身份、生命周期失效和连接互斥。
- [x] 3. 接入 CLI、既有 Workflow 终态门禁及插件 MCP/hooks 分发。
- [x] 4. 编写接入与故障恢复说明，保留 worker/relay 兼容路径。
- [x] 4.1 修复 Windows npm shim CLI 解析与启动错误丢失，增加脱敏回传诊断。
- [x] 4.2 新增外层 MCP 完成/回传工具及候选结果自动收集，仅补通知、不重跑开发。
- [x] 5. 完整离线回归、manifest 与 OpenSpec 验证：原桥接 68/68、新增 15/15、Workflow repair 120 项、42 个语法检查与 6 组行为验证全部通过，liveModelCalls=0。
- [ ] 6. 在目标真实 Claude 会话启用预览通道，验证空闲/忙碌 ACK、断线、重复消息及真实 Workflow/Codex 结果闭环。需要用户在该终端确认开发 Channel；本次代码验收不代替此项。
