## Purpose

让指定 Codex 与 Claude Code 会话通过可校验、大小受控、来源明确的上下文包交接任务，使接收方能够恢复工作、核对证据与权限范围，而不依赖猜测会话或复制全部历史。

## ADDED Requirements

### Requirement: 会话引用解析为固定身份
系统 SHALL 接受支持的 Codex 会话链接/ID、Claude 会话 ID/名称及路径，并绑定 provider、host、sessionId 与工作区；显示名称不得作为唯一持久身份。

#### Scenario: 用链接交接指定会话
- **WHEN** 用户提供合法 Codex 会话链接和可访问工作区
- **THEN** 系统解析固定身份并校验工作区后生成绑定，不因为打开链接就宣称已发送

#### Scenario: 名称歧义或项目不匹配
- **WHEN** 名称命中多个会话，或者目标工作区与授权项目不一致
- **THEN** 返回 needs-target 或 workspace-mismatch，不选最近会话且不发送

#### Scenario: 已绑定会话改名
- **WHEN** Claude 会话显示名称改变但 sessionId 不变
- **THEN** 继续使用原身份，不转发到占用旧名称的另一个会话

### Requirement: 双向上下文包含继续工作的必要信息
系统 MUST 提供任务、授权边界、OpenSpec/task IDs、工作区与 Git 基线、成果/剩余工作、测试证据、阻塞项和来源引用；每份包具有版本、时间和完整性摘要。

#### Scenario: Astra 向 Claude 派发切片
- **WHEN** 主控交接已规划的 OpenSpec 任务
- **THEN** Claude 可由包路径读取该切片、约束、基线和验收条件，并核对摘要完整性

#### Scenario: Claude 向 Astra 回传终态
- **WHEN** Ultracode 达到 completed、failed 或 blocked
- **THEN** 结果包含 run 身份、实际改动、通过/未运行测试、剩余 task IDs 和下一步，未提交时 commits 为空

### Requirement: 有界只读历史与证据分离
系统 SHALL 仅从指定且允许的来源读取上下文，支持预算裁剪和历史缺口报告；MUST NOT 修改原始会话存储、导出隐藏推理或把 Agent 自述当作验证事实。

#### Scenario: 历史超预算或采用分页存储
- **WHEN** 指定会话历史很大或不再保存为完整 rollout
- **THEN** 使用受支持的有界读取方式，输出来源和裁剪/缺口标记，不把空读取报告成完整历史

#### Scenario: 旧摘要声称测试已通过
- **WHEN** 摘要的自述缺少可核对的命令结果
- **THEN** 将其标为待验证，而不是将对应 task 标为完成

### Requirement: 路径和包完整性约束
系统 MUST 校验真实路径、访问边界、schemaVersion、目标身份和包 hash；路径引用不授予额外权限。

#### Scenario: 包被替换或路径越界
- **WHEN** hash 不符、未知协议版本、junction 指向未授权目录或路径不存在
- **THEN** 拒绝消费并返回明确原因，不从其他会话补猜上下文

#### Scenario: 同项目不同 worktree
- **WHEN** 双方工作区不同且已有明确映射
- **THEN** 保留双方路径和基线供接收方核对，不自动复制或合并代码
