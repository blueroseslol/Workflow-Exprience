# workflow-bridge-routing Specification

## Purpose
让 Workflow-Experience 按用户真实协作意图有选择地接入 Codex 主控与 Claude Ultracode 执行的交接流程，同时保留普通开发、只读调研、checkpoint、模型路由和子代理隔离行为。
## Requirements
### Requirement: 显式意图形成结构化契约
系统 SHALL 从当前用户指令解析读取、派发、终态通知和关闭动作；MUST 默认关闭跨会话发送，不因提及产品名或历史摘要而启用。

#### Scenario: 明确要求双向协作
- **WHEN** 用户要求 Codex 主控、Claude Ultracode 开发并回传原会话
- **THEN** 生成带原始授权引用、固定双端和 task scope 的 bridge contract

#### Scenario: 仅上下文读取或 Codex 审阅
- **WHEN** 用户只要求读旧会话分析或用 Codex CLI 审阅
- **THEN** 仅执行对应能力，不自动启用跨会话派发/回传

#### Scenario: 引用或否定
- **WHEN** 示例代码块提到通知，或用户明确说不要通知
- **THEN** 不发送；否定指令同时取消该请求尚未发送的通知

### Requirement: 同一任务授权可恢复但不可串任务
系统 MUST 仅在 requestId、scope 和原始显式授权均一致时恢复 bridge contract；不能从任意 checkpoint 继承发送权限。

#### Scenario: 恢复已授权任务
- **WHEN** 同一任务中断后恢复，用户未撤销通知要求
- **THEN** 延续原回传目标和未完成投递，无需重复关键词，但先重新验证身份与范围

#### Scenario: 新任务遇到旧通知记录
- **WHEN** 用户开始无通信意图的新任务且目录里存在旧 bridge 状态
- **THEN** 新任务保持关闭，不重放旧任务通知

### Requirement: 通信在 Workflow 外层执行
系统 SHALL 在派发前准备上下文，在真实 terminal 后生成结果/回传；MUST 保留内部子代理的 SendMessage/ListAgents 禁用边界。

#### Scenario: Ultracode 在后台仍运行
- **WHEN** 外层 CLI 返回但没有匹配的 Workflow terminal 证据
- **THEN** 保持 running/unknown 并恢复等待，不发送“开发完成”

#### Scenario: 内部代理完成一个阶段
- **WHEN** Plan 或 Implement 子代理返回但整个 Workflow 未终结
- **THEN** 不触发终态通知，也不由该子代理调用通信工具

#### Scenario: 阻塞终态
- **WHEN** Workflow 明确 failed 或 blocked 且契约要求 terminal 通知
- **THEN** 回传真实失败/阻塞与继续条件，不声称开发成功

### Requirement: 原流程兼容和主控接收
系统 MUST 保持原 OpenSpec Plan IR、模型别名/effort、缓存和默认 hook 行为；SHALL 提供 Codex 主控接收与验收操作约定。

#### Scenario: 未启用 bridge
- **WHEN** 用户执行普通 workflow
- **THEN** 不产生 bridge 进程/消息/状态目录，默认模板与模型行为保持一致

#### Scenario: 只修改回传地址
- **WHEN** 工作切片未改变，仅经用户授权更新通知目标
- **THEN** 重建通信绑定/消息身份，不无故重做未变 BasePlan

#### Scenario: 主控收到代码结果
- **WHEN** Codex 收到绑定 request 的结果
- **THEN** 按上下文路径核对实际改动与测试，记录验收或有限返工，不自动开启无限互发
