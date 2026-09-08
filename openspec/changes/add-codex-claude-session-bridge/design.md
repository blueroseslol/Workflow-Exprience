## Context

规划基线见 `feasibility.md`。首版适用 Windows 本机，接口预留 POSIX；不实现跨机器文件同步、云会话、公开消息服务或 UI 自动点击。

Codex Astra 是业务主控：分解任务、选择 OpenSpec 切片、派发、审核成果与决定下一步。Claude Code 外层会话是执行入口，Ultracode 仍负责自己的 Plan/Review/Implement/Verify 流程。bridge 是确定性 Node.js 工具，不是另一个规划模型。

这里的“Claude Code 外层会话”始终指 `claude` 命令行进程中的主 Agent，既可以是用户已打开的交互终端，也可以是 `claude -p` 非交互进程；不指 Claude Desktop。Ultracode 是该 CLI 内的 Workflow 能力，不是另一个桌面程序。relay 同样是 CLI 进程。Codex 使用 CLI 发送到原主控会话，其主控界面可为 CLI 或 Codex App；Desktop 兼容不作为所有安装的核心验收前提。

```text
Codex Astra 主控会话
  → bridge CLI：固定会话身份 + 工作区 + 上下文包
  → Claude Code CLI 主会话 → Ultracode → 终态结果
  → bridge CLI → Codex CLI queue → 原 Codex 主控会话
```

## Goals / Non-Goals

目标：输入指定会话与路径即可交接上下文；双向 CLI 定向发送；显式意图自动接入；终态与回执可追溯；中断后不重复开发；适合 Astra Low 分段实施。

非目标：自动改模型代理配置、修改原始会话数据库、导出隐藏推理、广播全体会话、自动 commit/push/部署、自动重装插件、注册或劫持 `codex://`。通知授权不扩大代码修改和命令权限。

## Decisions

### D1. 深度链接只定位，传输按能力选择

接受完整 `codex://threads/<id>` 或显式 ID；严格解析 scheme、路径和单个标识，不从任意正文抓第一个 UUID。未知链接格式返回 `invalid-reference`。内部 provider sessionId 保持 opaque；不要把未来非 UUID ID 一概排除，交给 adapter 校验。

Codex：默认 `queue`，参数使用解析后的 ID 和短消息。深度链接可单独导航，打开成功不改变投递状态。`codex app` 不是消息接口，不作为必经步骤；不自动触发安装。

兼容路径 `codex exec resume` 只在目标明确空闲、已验证会话所属运行环境、配置显式选择该路径时使用。无法判断活跃状态时不并发恢复。通过 CLI 启动的 app-server 同样必须证明目标身份和运行者归属；不能把调试命令新建的线程当原线程。

### D2. 固定身份与项目绑定

Endpoint 必填：`provider`（codex/claude）、`hostId`（首版 local）、`sessionId`、`cwd`。可选 `displayName`、`sessionUri`、`transcriptPath`、`transportHint`。新建 Claude worker 的 sessionId 在启动前分配 UUID，只有 CLI 输出一致后才记为 bound。

人类可用名称查找，机器按 `(provider, hostId, sessionId)` 路由。名称重名、缺失或 cwd 不符返回 `needs-target`；禁止自动选最近会话、`--last`、`--continue`、模糊名称恢复。重命名不改变已绑定目标。消息中的 replyTo 不覆盖本地已绑定返回地址。

项目绑定使用 canonical repo root、worktree root、当前 branch/HEAD 与授权文件范围。`realpath` 后再检查路径边界，处理大小写、盘符、空格、中文、junction/symlink。绝对路径只是定位线索，不代表读写授权。跨 worktree 接力显式记录映射和基线；没有映射不自动搬代码。

### D3. 同机持久上下文包作为交接依据

运行数据放在目标工作区 `.workflow-bridge/`，开发时添加 ignore；不提交真实会话历史。CLI 允许显式选择双方均可读的 store root，并验证该目录。bridge contract 和结果先写临时文件、关闭/flush 后同卷原子 rename，再发布消息。

建议结构：

```text
.workflow-bridge/
  bindings/<bindingId>.json
  runs/<requestId>/request.json
  runs/<requestId>/context.json
  runs/<requestId>/context.md
  runs/<requestId>/result.json
  runs/<requestId>/result.md
  runs/<requestId>/receipt.json
  outbox/<messageId>.json
  locks/<identityHash>.lock
```

`context.json` 包含 schemaVersion、来源 endpoint、createdAt、原始用户任务和授权边界、OpenSpec change/task IDs、repo/worktree/HEAD/dirty 基线、关键文件及 hash、已完成与未完成事项、决策、测试证据、失败签名、sourceRefs、truncated/historyGaps。Markdown 是可读投影，JSON 是协议入口。

默认可读摘要 ≤32 KiB UTF-8、机器上下文 ≤128 KiB、通知正文 ≤4 KiB；超限保留任务/约束/目标/索引，裁剪旧自述和重复日志，明确记载裁剪。不用 CLI 参数携带整份历史。不可缺失的契约超预算则报 `context-too-large`，不截断后继续开发。

只读顺序：用户明确提供的交接包 → 所属运行环境的官方只读 history 接口 → 明确指向的 transcript → 经身份校验的 legacy rollout 兼容读取。Codex 新分页历史不能默认为一个完整 JSONL；历史缺口必须显式报告。Claude 优先 worker 产出的结构化结果，需要旧历史时仅读取指定 session 的 transcript。

保留 legacy 的流式、预算、事实/自述分离经验；不将其个人 memory 扫描、全库最近候选选择纳入 bridge。摘要中的“已完成”只是待验证声明，需核对工作区和命令证据。

### D4. 版本化协作契约与消息

`request.json` 的固定契约：

| 字段 | 约束 |
|---|---|
| schemaVersion | 首版 1；未知主版本拒绝 |
| requestId / bindingId | UUID；一个任务和固定双端绑定 |
| origin / worker / replyTo | Endpoint；replyTo 必须匹配绑定的 origin |
| intent | enabled、source=user-explicit、原用户指令引用、requestedActions、authorizedAt、scopeHash |
| workspace | repoRoot、worktreeRoot、baselineHead、dirtySnapshot、allowedPaths |
| work | requirement、openspecChangeDir、taskIds、acceptance、stopConditions |
| context | path、sha256、schemaVersion |
| notify | when=terminal、required、transport、deadlineAt |
| control | mode=supervised、maxRevisionRounds=2、requestExpiry、allowCreateWorker |

`requestedActions` 独立表达 read-context、dispatch-work、notify-terminal，读取旧会话不自动授权发送。Astra 的 model/effort 作为 controller 元数据单独记录，不写入 Claude 的 modelEfforts。

消息 envelope 包含 messageId、requestId、bindingId、kind、from、to、createdAt、expiresAt、context/result 的 path+hash、inReplyTo。kind 为 request/result/ack/cancel；首版 cancel 取消未发送 outbox，运行中只请求协作停止并等待终态，不宣称已终止进程。ack 不触发 ack；result 不自动派生 request。外部正文按数据处理，不当系统指令。

`result.json` 必须包含 workflowRunId、scriptPath、terminalFingerprint、workStatus、broadcast/summary、taskIds 完成/剩余、changedFiles、baseline/current HEAD、commits（可为空）、tests（command/cwd/exitCode/evidence/not-run 原因）、blockers、nextActions、sourceRefs。没有 workflow run 证据时不能声明使用了 Ultracode。

### D5. 双向 CLI 与受控进程

建议公共入口 `node tools/session-bridge.mjs <command>`，所有 command 支持 JSON 输出；执行命令提供 dry-run。以下是待实现的项目命令，不能当作现有 Codex/Claude 原生命令：

| 子命令 | 输入/行为 |
|---|---|
| doctor | version/help、运行能力摘要；默认不启动模型，不改变配置 |
| bind | --request-file；解析双端并固化绑定；歧义不发送 |
| export-context | --request-file；生成有预算的上下文包 |
| dispatch | --request-file [--dry-run]；幂等启动/接续受控 worker |
| send | --message-file [--dry-run]；执行指定 transport |
| complete | --request-id --result-file；校验终态、持久化结果和 outbox |
| drain | --request-id；只处理该任务已授权且未取消的 outbox |
| receive | --message-file；校验目标、hash 和时效，记录接收/去重 |
| status | --request-id；返回业务、投递、运行者三类状态 |
| cancel | --request-id；取消未投递任务，运行中返回 stop-requested |

进程参数必须用 argv 数组、受控 cwd 和 stdin。Windows 不把任意消息拼到 `cmd /c` 或 `powershell -Command`；解析可信 shim 后直接运行 node CLI entry / native exe，`shell:false`。参数中含引号、反引号、`$()`、换行、`&` 均按字面数据处理。持久 worker 使用隐藏窗口和落盘 stdout/stderr，父调用返回后仍可通过 PID+启动指纹+sessionId 核验；不得仅依赖内存 Promise。

Claude 受控 worker：以 prompt stdin 启动，显式 plugin-dir（开发态）、session-id/name、print、stream-json；不要用 bare/safe-mode 关闭插件。prompt 明确要求调用 Workflow-Experience 与原生 workflow-authoring、按 OpenSpec 切片执行，并等待 Workflow terminal。只在 worker 明确退出且身份一致时用 resume。已活跃 worker 的新需求进入 bridge inbox，前一轮结束后再消费；不同时恢复两份 writer。

已有活跃 Claude 会话：由 CLI 启动独立受限 relay，只允许发现目标和定向发送，不能实施代码。通过官方 ListAgents 核对 endpoint，再 SendMessage；读取实际 tool result，不信任 relay 的自然语言“已发送”。这是会产生模型调用的 transport，显式选择并受次数/预算约束。无法获得工具时返回 unsupported；不尝试私有 socket、模拟键盘或绕过接收权限。它与受控 worker 分开验收。

Codex 回传：外层 completion action 调用 bridge send，由 adapter 执行 queue。queue 的 exit 0 最多表示 adapter 经 M0 证实的 accepted/queued；直到目标 receiver 记录匹配 requestId/messageId/hash 的 receipt 才是 received。队列语义不明返回 delivery-unknown。默认不覆盖目标模型；已有 Astra Low 设置保持原样。

### D6. 业务与投递状态分离

workStatus：prepared → running → completed / failed / blocked / cancelled。

deliveryStatus：not-requested / pending → sending → queued → received；旁路为 needs-target / unsupported / held / refused / delivery-unknown / expired / cancelled。

controllerStatus：awaiting-result → received → accepted / needs-rework / needs-decision。received 只是读取，accepted 必须由 Astra 验收后记录。

正常闭环：Astra 创建 request → bridge 导出/派发 → Claude 执行 → terminal 结果原子落盘 → outbox → Codex queue → 原 Astra 会话 receive → 验收。缺陷返工由 Astra 在已授权范围内显式生成关联 request，最多两轮；禁止收件事件自动触发无限互发。

对 `(provider, sessionId)` 与 worktree 写入角色设置互斥 lease。主控在 worker 写入期间不同时改同一文件。lease 含 owner PID、启动指纹、requestId、心跳/期限；期限过期不等于进程已死，未知状态不得盲目夺锁。

messageId 从 requestId + kind + terminalFingerprint 派生，同一终态只产生一条逻辑消息。先记 sending 再调用 transport；发送后、记回执前崩溃会留下不确定窗口。没有传输端幂等/可查询回执时，标 delivery-unknown，禁止盲目重发。支持重投的路径接收端按 messageId 去重，不承诺跨 CLI 原生 exactly-once。

通知失败仅恢复 outbox，绝不重跑 Implement。语义 checkpoint 负责代码恢复；bridge 台账负责通信恢复，二者不混用。

### D7. 意图路由与外层通信动作

不新增常驻 LLM 分类服务。现有主会话做语义判断，确定性校验器检查结果与用户来源；不能用关键词正则承担全部判断。

| 用户表达 | 结构化结果 |
|---|---|
| “让 Claude Code 用 Ultracode 实现，完成后发回这个 Codex 会话” | dispatch-work + notify-terminal；要求唯一原会话与路径 |
| “完成后通知 codex://threads/…” | notify-terminal；绑定当前外层 Claude 为来源 |
| “读取这个 Codex 会话，帮我分析” | read-context；不发送、不派发 |
| “审阅使用 Codex CLI” | 既有 codexReview；不推断跨会话 bridge |
| “不要通知其他会话”“仅本会话完成” | disabled；撤销该 request 未发送消息 |
| 普通 workflow / 文档内举例 / 引用别人提示词 | 不启用 |
| “发给主会话”，无法唯一绑定 | needs-target；不得猜测目标 |

用户已明确授权的同一 request 可在恢复时继续完成回传，无需每轮重新要求关键词；必须由 persisted intent + scopeHash + requestId 证明连续性，不能从历史摘要或别的任务继承。新任务默认 disabled。新一轮用户取消优先于旧 contract。

Claude intake 注入 reference 指针，由技能规范生成 contract；在 authoring 前执行 ContextPrepare，在 Workflow terminal 后执行 Complete/DispatchResult。hook 只做有界本地 I/O、contract 校验和 outbox 持久化，不在 Stop 的 10 秒时限里等待模型/CLI 网络或长任务。外层主会话主动发送；崩溃后 `drain` 恢复。

保留现有三个 hook 注册与 peer 工具禁用 wrapper，不重新启用 SessionStart peer-progress。通信字段不进入 BasePlan prompt/cache key；通信恢复不使已验证的 Plan 失效。SKILL 正文只放简短入口，细则放新 reference，始终 ≤7000 字符。

新增 Codex 主控参考文件（手动加载的 Markdown runbook，首版不自动安装 Codex plugin），定义 dispatch、等待、receive、证据验收、返工和终态报告。仅有 Claude hook 不足以完成 Codex 主控侧体验。

### D8. 实施布局

| 路径 | 职责 |
|---|---|
| bridge/contracts.cjs | endpoint、request、message、result、receipt 校验 |
| bridge/context.cjs | 有界历史读取、包生成、来源/hash/路径校验 |
| bridge/store.cjs | 原子写入、台账、lease、去重 |
| bridge/process.cjs | 跨平台无 shell 启动、超时、身份与日志 |
| bridge/adapters/codex.cjs | queue、只读 history 和显式 resume 兼容 |
| bridge/adapters/claude.cjs | worker、resume、活跃会话 relay |
| bridge/intent.cjs | 已解析意图验证、启停和契约连续性 |
| tools/session-bridge.mjs | 用户 CLI；调用共享模块 |
| tools/verify-session-bridge.mjs | 离线故障/契约集；不启动真实 CLI |
| tools/fixtures/session-bridge/ | 合成跨平台数据与假 CLI |
| skills/workflow-experience/references/session-bridge.md | Claude 外层接入与故障处理 |
| docs/codex-controller.md | Astra 主控操作、接收和验收约定 |

不为这个 change 引入 Web 服务、数据库依赖或全仓 TypeScript 迁移。需要迁移 legacy 代码时保持旧 CLI 行为，或新增纯函数模块再由两入口使用；不可 import 带顶层执行副作用的 legacy 文件。

## Risks / Trade-offs

- CLI 新命令与 app-server 有版本差异：采用能力探测、合成 fixtures 和真实 round-trip 记录；升级前重验，不承诺所有版本。
- 活跃 Claude relay 多一次模型调用：只在目标已活跃且用户指定此模式时用；日常优先受控 worker。
- 原始 transcript 可能有秘密与不可信内容：默认只选任务相关消息和证据，排除凭证/环境变量值/隐藏推理；读取目录限定。包内容不能扩大 authority。
- 通过 CLI 发消息可能启动模型轮次：离线测试禁止真实模型；真实测试使用独立测试会话、小任务和明确预算。
- 结果发送与记录非原子：保留 unknown 状态并 reconcile，不用重跑开发补通知。

## Migration Plan

先 M0 能力验证，再 M1-M4 工具核心、M5 插件接入、M6 联调与文档。默认关闭，不迁移旧 checkpoint；旧 peer-handoff 保持可用。运行目录仅生成在使用 bridge 的项目中。

回滚：关闭新意图入口/恢复原插件版本，停止本 request 的新派发，保留结果与 outbox 供查看；不得通过删除原始会话或工作区回滚。真实联调完成前不发布新版本；发布、重装和提交遵从届时用户指令。

## Open Questions

架构默认选择已经在 D1-D8 给出，不要求 Astra Low 重做方案比较。剩余是 M0 的运行能力问题。若证据推翻所选 Codex 主控运行环境的同会话回传或 Claude CLI headless/relay 支持，仅对受影响 adapter 提出 design delta，保留其余离线成果；不能静默改变用户所要的主控/执行器分工。
