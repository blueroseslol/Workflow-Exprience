## Why

用户希望由 Codex Astra 主控项目开发，由 Claude Code Ultracode 执行代码工作，并将完成信息与必要上下文回传给原 Codex 会话。仓库已有单向 Codex 上下文提取器、Claude peer-handoff 约定和意图入口，但缺少统一会话身份、CLI 双向适配、可恢复投递状态和可验证的自动闭环。

本机 Codex CLI 0.153.0 的 `queue` 命令、Claude Code 2.1.260 的非交互执行与会话恢复，为本机桥接提供了基础。深度链接用于定位会话，不能预设它携带正文就会发送消息。

运行形态澄清：Claude 端是终端中的 **Claude Code CLI**，不是 Claude Desktop。支持用户已有的交互式 CLI 会话与 bridge 启动的非交互 CLI 会话；Codex 主控可以位于 CLI 或 Codex App，按实际目标验证，不要求安装任何桌面应用。

## What Changes

- 新增本机 session bridge：接受 Codex 会话链接/ID、Claude 会话 ID/名称与工作区路径，解析成固定身份。
- 新增有大小预算和证据引用的双向上下文包，复用 legacy 提取经验，兼容当前 Codex 分页历史，保持会话存储只读。
- Codex 回传优先使用 `codex queue --thread <id> --message <text>`；仅在已验证场景内使用显式恢复作为兼容路径，独立记录入队与接收。
- Claude 受控执行使用 CLI 启动/恢复固定 session；活跃外部会话通过 CLI 启动的受限 relay 调用官方 peer 工具，能力不足时明确报告。
- Workflow 根据当前用户的协作意图生成结构化 contract，在外层增加准备和终态回传动作；普通任务保持原行为。
- 新增投递台账、去重、崩溃恢复与验收证据；通知失败不会重新执行代码开发。
- 为 Astra Low 提供按里程碑的执行说明及离线、真实通信两类验收。

## Capabilities

### New Capabilities

- `session-context-exchange`：稳定身份解析、限定范围的双向上下文包、来源和工作区一致性检查。
- `session-cli-transport`：Codex/Claude CLI 定向传输、运行与投递状态、幂等和故障恢复。
- `workflow-bridge-routing`：意图启停、外层通信动作、Ultracode 接入、主控接收和原有行为兼容。

### Modified Capabilities

无既有 OpenSpec capability；这是本仓库首次建立 OpenSpec root。既有行为的兼容要求写入上述新增 capability。

## Impact

- 新增 `bridge/` 共享模块、`tools/session-bridge.mjs`、离线 fixtures 与验证入口。
- 接入 intake/harvest hooks、命令与技能引用文档；核对 `checkpoint-lib.cjs` 实际依赖，不预先改缓存 schema。
- legacy 提取逻辑可复用，但旧 SQLite 表版本、任意文本 UUID 与“候选取最新”不可直接成为自动发送路由。
- 五个 Workflow 模板默认不增加 LLM 通信 phase，保留 peer 工具禁用和模型路由；终态缺字段时先调整外层归一化。
- 风险集中在会话身份、进程并发、消息重放和写工作区所有权；首版限同机、同一操作系统路径空间。
- 本轮仅交付规划：不发送消息、不启动模型、不修改插件运行代码、不提交或重装。实现与真实通信验收在后续开发指令下进行。
