## Purpose

为用户指定的本机 Codex 与 Claude Code 会话提供可恢复、可追踪的 CLI 双向传输，明确运行与投递结果，防止串会话、并发恢复、重复开发和将未确认送达误报为成功。

## ADDED Requirements

### Requirement: Claude 执行与通信仅依赖 CLI
系统 MUST 在 Claude Code 命令行进程中执行 Ultracode 与会话通信，支持受控非交互进程和用户已有交互终端的对应传输方式；MUST NOT 要求 Claude Desktop 或桌面 UI 自动化。Codex 主控界面按实际使用环境单独验证。

#### Scenario: 仅安装命令行程序
- **WHEN** 机器安装 Codex CLI 与 Claude Code CLI，具备所需运行能力但没有桌面应用
- **THEN** 可以执行和验收双向 CLI 闭环，不因缺少桌面应用阻断

### Requirement: Codex 定向发送使用已验证能力
系统 SHALL 使用能力探测通过的 CLI transport 向绑定 Codex ID 发送消息，深链接导航不得充当发送回执。

#### Scenario: 目标支持 queue
- **WHEN** 已核实当前运行环境支持向目标 session 入队
- **THEN** 使用明确 ID 发送短消息与上下文引用，按真实结果记录 queued 或其他投递状态

#### Scenario: queue 不可用
- **WHEN** 当前版本没有 queue 或目标不在其可达运行环境
- **THEN** 返回 unsupported/needs-target，只有显式选择并验证的空闲 resume 路径可替代，不能另建线程冒充目标

### Requirement: Claude 固定会话执行与活跃投递
系统 SHALL 支持受控 Claude worker 的启动/恢复，以及能力已验证的活跃会话定向 relay；MUST 校验返回 sessionId 与绑定一致。

#### Scenario: 创建或恢复受控 worker
- **WHEN** 用户授权新建执行会话或恢复一个已确认退出的 worker
- **THEN** CLI 在指定 cwd 与 session ID 执行，持久化真实身份，不使用最近会话选项

#### Scenario: 向活跃外部 Claude 会话发消息
- **WHEN** 目标已活跃且用户选择已验证的 relay 模式
- **THEN** 经官方 peer 工具定向发送，回执反映 delivered/held/refused，不能通过并发 resume 创建副本

#### Scenario: relay 能力不足
- **WHEN** CLI relay 无 peer 工具或目标拒绝消息
- **THEN** 报 unsupported/refused，保留上下文，不绕过限制发送

### Requirement: 消息文本不会成为 shell 代码
系统 MUST 将提示词、名称和路径作为数据传给进程，并在中文、空格及 shell 元字符条件下保持原意。

#### Scenario: Windows 特殊字符
- **WHEN** 消息含换行、双引号、反引号、美元子表达式或 &
- **THEN** 目标收到字面文本，不产生额外 shell 命令，过长正文改用文件引用

### Requirement: 业务成果与投递回执独立
系统 MUST 分别报告 workStatus、deliveryStatus 和 controllerStatus；发送进程退出成功不得直接视为目标已接收或验收。

#### Scenario: 已完成开发但队列未消费
- **WHEN** workStatus 为 completed 且 CLI 仅确认入队
- **THEN** deliveryStatus 为 queued，controllerStatus 仍 awaiting-result，并保留结果供恢复

#### Scenario: 主控读取与验收
- **WHEN** 原目标验证 messageId、requestId、身份与 hash 并读取结果
- **THEN** 记录 received；仅在主控核对验收条件后才记录 accepted 或 needs-rework

### Requirement: 幂等与故障恢复
系统 MUST 在副作用前持久化发送意图、对同一终态去重并保留不确定状态；通知恢复不得重复代码执行。

#### Scenario: Stop 与外层同时处理终态
- **WHEN** 两个完成处理器提交相同 run 的相同 terminalFingerprint
- **THEN** 仅产生一条逻辑终态消息，重复完成操作返回已有状态

#### Scenario: 发送后记录回执前崩溃
- **WHEN** 传输可能已成功但本地无可靠回执
- **THEN** 标记 delivery-unknown，优先核对目标回执；无幂等依据不得盲目重发

#### Scenario: 只恢复失败通知
- **WHEN** 用户恢复已有结果的未完成投递
- **THEN** 仅恢复对应 outbox，不重新运行 Implement/Verify

### Requirement: 运行所有权与取消
系统 MUST 防止同一绑定会话或工作区被多个受控 writer 同时恢复，并尊重时效和取消。

#### Scenario: 两个 dispatch 争用会话
- **WHEN** 同一 request 或同一工作区已有活跃写入者
- **THEN** 返回已有运行状态或等待占用释放，不启动第二份 writer

#### Scenario: 取消或过期
- **WHEN** 尚未发送的请求被用户取消或已过期
- **THEN** 停止派发；运行中仅报告 stop-requested，直到实际终态才能报告 cancelled
