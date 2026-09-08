# 可行性与证据（2026-09-08）

结论：核心目标可行，建议采用“本机会话桥 + 固定 session ID + 上下文包 + CLI 回传”。深度链接保留为输入和导航入口，不承担未经证实的发送协议。上线前必须完成 M0 与 M6 真实适配验收；本文件不声称链路已经打通。

用户已澄清 Claude 使用命令行程序。本方案中的 Claude 会话、worker、relay 均指 Claude Code CLI；没有 Claude Desktop 依赖。下文 Desktop 启动仅是此前查阅的 Codex 能力，属于可选兼容证据，不是 Claude 端要求。

## 本轮已核实

| 能力/事实 | 证据 | 判断 |
|---|---|---|
| Codex CLI 0.153.0 | 本机 `codex --version` | 已确认安装版本 |
| 定向入队 | `codex queue --help`：必填 thread、message；接受 UUID 或精确名称 | 命令存在；所选主控环境中的定位、唤醒、回执待实测 |
| Codex 非交互恢复 | `codex exec resume --help`：显式 session、stdin `-`、JSONL | 支持恢复；不是无条件安全的活跃会话注入 |
| Desktop 启动 | `codex app --help` 接受 workspace PATH | 未提供深链接携正文发送的证据 |
| App Server | 本机有 proxy、generate-json-schema；官方有 thread/read、thread/resume、turn/start | 可用于只读历史与兼容适配；独立 server 不等于 Desktop 当前 server |
| Claude Code 2.1.260 | 本机 `claude --version` | 已确认安装版本 |
| Claude 固定会话 | session-id、name、resume、print、stream-json；agents --json | 可编排创建/恢复；名称仅辅助 |
| Claude 活跃会话 | 官方 ListAgents/SendMessage；本机未列出独立 claude send | CLI 通过受限 relay 承接，不能虚构发送子命令 |
| 后台副本风险 | 本机帮助明示 bg + resume 在已运行时可能复制 | 禁止把副本报告成原会话 |
| Headless Ultracode | 官方 workflows 明确包含 claude -p 和 Agent SDK | 文档支持；本机 provider、插件、权限组合待验 |
| Astra Low | 官方支持 gpt-6-astra 与 low；本任务环境也列出该模型 | 保留用户所选主控，不改 Claude 逻辑角色 |
| 仓库基线 | HEAD f5e2ecf，plugin 0.5.0；此前没有 OpenSpec root | 本轮用 OpenSpec 1.7.0 初始化 tools none |
| 无关改动 | 原有 docs/workflow-main-flow.drawio 为 modified | 本 change 不修改它 |

## 当前源码接入依据

- `hooks/workflow-intake.cjs`：workflow 前缀注入路由；peer 意图目前由主会话语义判断，并非完整规则分类器。
- `skills/workflow-experience/references/peer-handoff.md`：已有显式意图、terminal 后、外层发送、失败不冒充成功约定。
- `legacy/codex-handoff.mjs`：有预算流式提取与只读查询；硬编码 state_5.sqlite、忽略 scheme、候选取最新、个人 memory 兜底不可直接用于新协议。
- `templates/openspec-incremental.js`：已有 Plan IR、checkpointEnvelope、broadcast；strongModel 默认 opus。
- `tools/verify-all.mjs`：现有顶层语法扫描和三组行为验证；新增子目录必须明确纳入扫描。
- GitNexus 索引为 `3db0c33`，落后于当前 `f5e2ecf`；本机 runner 的多词 query 出现参数拆分错误。本轮规划不依赖该图证明调用链，接入依据来自当前源码；实施时刷新索引并交叉核对。

## 官方来源

1. [Codex CLI 命令参考](https://learn.chatgpt.com/docs/developer-commands?surface=cli)：exec/resume 与 app 启动；本次页面未建立 queue 语义，queue 依据本机帮助。
2. [Codex App Server](https://learn.chatgpt.com/docs/app-server)：只读历史与 thread/turn 协议，分页接口有实验性边界。
3. [Astra 模型](https://developers.openai.com/api/docs/models/gpt-6-astra)：用户指定模型和 low 能力。
4. [Claude 非交互使用](https://code.claude.com/docs/en/headless)：print、输出与 ID 恢复；正常模式加载项目定制，bare 会跳过部分定制。
5. [Claude 会话管理](https://code.claude.com/docs/en/sessions)：名称、恢复与会话身份。
6. [Claude 跨会话消息](https://code.claude.com/docs/en/cross-session-messaging)：peer 工具、活跃/空闲接收、held/refused 与本机适用范围。
7. [Claude 动态 Workflow](https://code.claude.com/docs/en/workflows)：Ultracode 与非交互 Workflow 支持。

## M0 必须解决的假设

- queue 能否命中所选 Codex CLI/Codex App 的原会话？空闲时是否自动开始新轮次？目标进程退出时是否只入队？实际输出代表什么？分别记录已测试的运行形态。
- 如何连接拥有目标会话的 app-server？当前只读历史 schema 是什么？不需要也不得修改内部 DB。
- 本机 claude -p 能否加载插件和 authoring 工具并等到 Workflow 终态？外层提前退出时如何持久等待？
- 受限 relay 能否获取 peer 工具并产出可信工具回执？若不能，该安装仅支持受控 worker，活跃外部会话保持 unsupported。

这些假设不阻止协议和离线测试，但实测通过前不能将对应 Codex 主控环境的自动回传或活跃 Claude CLI 定向发送标为已交付。未验证 Codex App 兼容不影响已经独立通过的纯 CLI 验收。
