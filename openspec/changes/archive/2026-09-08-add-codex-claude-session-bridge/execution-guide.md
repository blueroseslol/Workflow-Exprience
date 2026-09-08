# Astra Low 执行说明

本文件是实施入口。此 change 的名称是 `add-codex-claude-session-bridge`，状态为待实施；不会因为 OpenSpec artifacts 全部存在而视为功能完成。

**Claude 端固定为 Claude Code CLI。** 已有终端会话与新建非交互 worker 都是 `claude` 进程，Ultracode 在其中运行，不需要 Claude Desktop。Codex 的主控界面按用户实际使用的 CLI/Codex App 记录，回传均经 Codex CLI；不能把未测试桌面兼容视为纯 CLI 链路失败。

## 读取顺序与执行粒度

1. 先看 `proposal.md` 和 `feasibility.md`，确认目标与已知证据。
2. 读取 `design.md`，固定 D1-D8 的已选方案；不要从零另造 Full Plan。
3. 看 `tasks.md` 中当前里程碑及相应 capability spec，仅再读取受影响代码。
4. 每次处理一个里程碑，过大的项再分成可独立验证的小切片；完成一项即保存证据。没有新增架构疑问时不重新设计协议。
5. 实施开始时核对 git status。规划时存在的 `docs/workflow-main-flow.drawio` 改动不得覆盖或混入提交。

建议首次开发提示词：

```text
请在 D:\AI\Skill\Workflow-Exprience 使用 Astra Low，按
openspec/changes/add-codex-claude-session-bridge 执行开发。
先读取 execution-guide.md、feasibility.md、design.md 和 tasks.md。
复用既有方案，先完成 M0 只读核对和 M1/M2 离线切片。
保持 Claude strongModel='opus'、现有 effort/checkpoint 与子代理隔离。
不要把通信字段加入 BasePlan，也不要改已有无关 drawio。
每项验证通过才勾 tasks；真实模型通信探针未获授权时保留未验证，
继续完成不依赖探针结果的离线工作。不要提交、发布或重装插件。
```

需要测试真实闭环时，补充一条具体授权即可，后续不必反复确认相同范围：

```text
允许在独立测试会话执行 M0/M6 的真实通信与最小 Ultracode 探针。
由我指定测试 Codex 会话、Claude 会话/可新建 worker 的范围、工作区、
模型调用预算和截止条件；只在该范围完成验证，不向其他业务会话发消息。
```

真实探针所需目标/预算是执行时输入，不在计划中虚构；本轮没有创建这些会话。

## 里程碑依赖

```text
M0 版本/能力与最小探针
  ├─ M1 契约/存储/安全进程 → M2 上下文
  └─ transport 实测结论 + M1/M2 → M3 Codex 回传
       → M4 Claude worker/relay → M5 意图/外层接入
       → M6 全量离线 + 真实闭环 + 使用文档
```

M0 实测未授权不阻止 M1/M2 离线核心；M3/M4 可按已知接口写 fake transport 测试，但不可将未经验证的运行分支标成生产可用。M6 没有真实收件证据，就不勾对应任务。

## 既定选择速查

| 事项 | 既定方案 |
|---|---|
| 主控 | 当前 Codex Astra，用户选 low；不自动切模型 |
| 开发执行 | Claude Code CLI 主会话 + Ultracode；opus 等逻辑角色维持原配置 |
| Codex 地址 | 支持的深链接解析为 sessionId；CLI queue 负责传输 |
| Claude 地址 | sessionId 持久绑定，名称辅助；live relay 与 worker 分开 |
| 长上下文 | JSON+Markdown 有界文件包；消息带路径/hash |
| 接入位置 | 外层 ContextPrepare / terminal completion；不增加内部 LLM phase |
| 状态 | 业务成果、CLI 投递、主控验收三条独立状态 |
| 去重 | terminalFingerprint/messageId；不宣称原生 exactly-once |
| 恢复 | 代码用原 checkpoint，通知用 outbox；禁止因投递失败重跑代码 |
| 默认 | 不启用 bridge；同任务显式授权可恢复，新任务不继承 |
| 首版部署范围 | 同一机器和路径空间；不做 Web 服务与云同步 |

## 每个切片的最小工作记录

在此 change 的 `evidence/` 内写精简 Markdown，包含：task IDs、修改文件、基线/当前 HEAD、执行命令与 cwd、退出码、通过/失败/未运行、证据路径和剩余阻塞。真实 transcript 默认只保存本地受控目录，Git 中只放脱敏摘要，不提交会话数据库、凭证、完整私有上下文。

里程碑结束后回报：完成 task IDs、验证证据、未完成范围、下一项。所选方案不能满足契约时，指出被哪个具体事实推翻，更新最小 design delta；不要用“本地测试绿”掩盖缺失的实际传输能力。

## 验收命令

现有命令：

```powershell
node tools/verify-all.mjs
openspec validate add-codex-claude-session-bridge --strict
openspec status --change add-codex-claude-session-bridge --json
git diff --check
```

计划新增命令（实现后才可执行）：

```powershell
node tools/verify-session-bridge.mjs --group contract
node tools/verify-session-bridge.mjs --group store
node tools/verify-session-bridge.mjs --group context
node tools/verify-session-bridge.mjs --group codex
node tools/verify-session-bridge.mjs --group recovery
node tools/verify-session-bridge.mjs --group claude
node tools/verify-session-bridge.mjs --group intent
node tools/verify-session-bridge.mjs --group integration
```

不带 group 运行全部离线 bridge 套件；所有 group 对无效名称报错。verify-all 必须覆盖这套测试且保持离线。

## 完成定义

满足三组 spec；普通 workflow 无回归；真实最小代码任务通过 Ultracode 完成并回到原 Codex 会话；Astra 能依据回传包继续处理；活跃 Claude 定向消息有独立证据；失败恢复不重复开发；所有未支持能力有明确状态。仅生成计划、启动 CLI、产生代码文件或队列 exit 0，均不是本 change 的完整验收。
