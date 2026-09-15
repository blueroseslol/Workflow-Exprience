## ADDED Requirements

### Requirement: 活跃 Claude Channel 接收证据
系统 SHALL 提供显式 channel transport，由目标 Claude 的 MCP Channel 消费持久消息。系统 MUST 仅在目标连接校验 request/message/hash 后产生接收回执，MUST NOT 把入队或通知发送等同于收到。

#### Scenario: 正常接收
- **WHEN** 目标显式接入并调用匹配消息的 bridge_ack
- **THEN** 持久记录其会话和连接身份，标记请求 received，保留业务与结果回传状态独立

#### Scenario: 普通会话未接入
- **WHEN** 插件被加载但目标没有调用 bridge_connect
- **THEN** 不消费持久队列，不声称 Channel 可用或消息已收到

#### Scenario: 断线或回执超时
- **WHEN** 消息已经记录发布意图但没有 ACK，且连接断开或超过等待时间
- **THEN** 保留未确认状态，不自动重复注入或重跑；目标可通过 pending 对账

#### Scenario: 重复消息
- **WHEN** 相同 request 重复 dispatch 或相同消息重复 ACK
- **THEN** 不创建第二条消息；已有 ACK 返回 execute=false

#### Scenario: 会话身份改变
- **WHEN** session 生命周期结束、epoch 改变、工作区不匹配或另一个连接占用同一 session
- **THEN** 拒绝消费或回执，不从消息提供的 session ID 接管其他目标

#### Scenario: 后续任务串行
- **WHEN** 同会话前一请求已经可能发布且尚无经 Workflow 快照验证的结果
- **THEN** 后续请求等待；取消和超时不证明执行停止，未 ACK 请求由目标明确拒收后可释放队列

### Requirement: 结果自动回传与诊断
系统 MUST 在已绑定 Workflow 终态及候选 Result v1 验证通过后自动回传原 Codex 会话；MUST 分开记录启动失败、CLI 非零退出、入队和主控验收，不得因通知失败重跑开发。

#### Scenario: 只写候选结果
- **WHEN** 外层已有 ACK 和真实 run 绑定并写入完整 candidate-result.json
- **THEN** 后台验证并执行与 bridge_complete 相同的回传，普通 Markdown 不当成完成证据

#### Scenario: Windows npm shim
- **WHEN** PATH 中 Codex 通过 npm cmd shim 安装
- **THEN** 解析 node_modules 中实际入口并用 argv 启动，不能错选 shim 内辅助 node.exe 或丢失 spawn error

#### Scenario: 通知失败恢复
- **WHEN** 通知失败且结果已经验证
- **THEN** 保留退出码/启动错误与脱敏输出，仅明确未提交的失败可以重置通知；未知送达状态先对账
