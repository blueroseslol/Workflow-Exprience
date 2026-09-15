# 活跃 Claude 会话 Channel 与接收回执

## Why

现有 relay 为每次转发新建 Claude CLI，模型还要调用 SendMessage。原生入站控制可暂存或拒绝消息；成功工具回执只证明入队，Codex 缺少目标接收证据。

## What Changes

- 新增显式 `workerTransport: channel`，复用 request/context 与持久 store。
- Claude 插件加载 MCP Channel；目标显式 connect，ACK 与拒收绑定其环境身份和生命周期。
- 区分排队、等待回执、超时、收到及业务终态；重复派发和连接恢复不自动重跑。
- 保留 worker/relay 和原 Codex 结果返回路径。

## Impact

涉及 bridge、CLI、Claude manifest/MCP/hooks、SDK 分发 bundle、操作文档及离线验收。真实 Channel 预览能力需要目标会话启动时启用和 Claude UI 确认，离线验收不能替代真实业务闭环。
