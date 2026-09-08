# 开发任务

状态：核心开发、真实 CLI round-trip 与后续负向/串行矩阵均已完成，31/31 项已验收。详见 evidence/capabilities.md、test-results.md、design-delta.md 及结构化 JSON 证据。

## 1. M0 — 能力验证与冻结 adapter 契约

范围：本 change 下的 `evidence/` 文档及合成探针材料，不修改运行 hooks/templates。

- [x] 1.1 记录当前 codex/claude/node/OpenSpec 版本和相关 help 摘要，核对工作区 dirty 基线、插件版本、Codex host 与运行环境；输出 evidence/capabilities.md。
- [x] 1.2 用独立测试会话验证 Codex queue 对所选主控环境（CLI 或 Codex App）原 ID 的空闲/活跃/目标进程退出行为，保存退出码、入队结果、目标实际 message/turn 证据；确认 app-server 只读连接与分页 schema。记录测试的运行形态，未测试的桌面兼容不阻断纯 CLI 验收。
- [x] 1.3 在独立 Claude Code CLI 测试 session 验证 print + plugin-dir + Ultracode 的启动、真实 run ID、终态等待、退出后 resume 身份；禁止用普通 Claude 输出替代 Workflow 证据，不依赖 Claude Desktop。
- [x] 1.4 验证受限 CLI relay 的 ListAgents/SendMessage、唯一目标、held/refused、真实工具结果；冻结 worker/relay/queue/resume 支持矩阵。失败能力明确 unsupported，受影响后续任务不能标完成。

完成条件：每个拟发布 transport 至少一条真实正向证据；未授权探针保留未勾选，M1/M2 可先做离线实现。若必要能力被否定，先更新受影响 design delta。

## 2. M1 — 契约、状态和文件存储

范围：bridge/contracts.cjs、store.cjs、process.cjs；tools/session-bridge.mjs；tools/fixtures/session-bridge；.gitignore。

- [x] 2.1 实现 Endpoint/Request/Message/Result/Receipt v1 校验和明确错误码，覆盖字段缺失、未知版本、错误目标、非法 URI 与名称歧义。
- [x] 2.2 实现 request/binding/message 身份、真实路径边界和 scope 校验；覆盖中文/空格、junction/symlink、同仓不同 worktree、改名与重复名称。
- [x] 2.3 实现原子结果/outbox 写入、终态指纹去重、业务/投递/主控状态分离；验证重复 complete 与半写入恢复。
- [x] 2.4 实现 session/worktree lease 与进程身份核验，覆盖双 dispatch、PID 复用、过期但仍活跃、父进程退出；不盲目夺锁。
- [x] 2.5 实现 CLI 骨架 doctor/status/bind、统一 JSON 和 dry-run，以及 shell:false 进程适配；用假 CLI 验证 Windows 元字符不执行。

验收：新增 `node tools/verify-session-bridge.mjs --group contract` 与 `--group store` 通过；不存在真实模型调用或原始会话写入。

## 3. M2 — 双向上下文交接

范围：bridge/context.cjs、只读 history adapter、export-context 子命令、合成 transcript fixtures。

- [x] 3.1 实现 context/result 的 JSON+Markdown 投影和预算，保留任务/权限/OpenSpec/证据/剩余事项；覆盖超限与不可裁剪契约。
- [x] 3.2 按 M0 schema 实现 Codex 官方只读历史访问和明确 transcript 的兼容读取，处理分页、压缩、缺页、归档路径失效；不使用个人 memory 自动兜底。
- [x] 3.3 实现 Claude 指定 session transcript/终态结果读取，校验 ID/cwd；两方向均区分自述与事实并排除凭证和隐藏推理。
- [x] 3.4 实现 export-context 和 receiver hash/版本/来源验证，覆盖替换包、路径越界、旧 HEAD/dirty 漂移和显式 worktree 映射。

验收：`node tools/verify-session-bridge.mjs --group context`；fixture 含旧 rollout、新分页历史、Claude transcript、缺口和超大行。

## 4. M3 — Codex 回传与可恢复投递

范围：bridge/adapters/codex.cjs、send/complete/drain/receive/cancel CLI、outbox/receipt 行为。

- [x] 4.1 实现 queue 能力探测、固定 ID argv、短消息+包路径；adapter 输出按 M0 实测映射，不把 exit 0 当 received。
- [x] 4.2 实现显式空闲 resume 兼容路径及 busy/owner-unknown 阻断；queue unsupported 不自动降级，禁止 last、新建替代线程和修改目标模型。
- [x] 4.3 实现 complete→outbox→send→receive→receipt 流程，接收端校验目标、期限、hash、授权范围，重复 message 不重复业务消费。
- [x] 4.4 实现 sending 崩溃窗口 reconcile、held/refused/unknown/expired/cancelled 状态；无可靠回执不盲目重发，恢复通知不重跑开发。

验收：`node tools/verify-session-bridge.mjs --group codex` 与 `--group recovery`，使用假 CLI，断言同一 terminal 只生成一个逻辑 message。

## 5. M4 — Claude worker 与已有活跃会话

范围：bridge/adapters/claude.cjs、dispatch 子命令、进程启动/监控、relay prompt 与工具结果解析。

- [x] 5.1 实现固定 session-id/name、cwd、plugin-dir、stdin prompt 和 stream-json 的受控 worker，验证实际 session ID 与 run ID。
- [x] 5.2 实现持久运行者和 terminal 等待，覆盖外层提前返回、Workflow failed/blocked、进程异常退出、通知重试不重开 worker。
- [x] 5.3 实现已退出 worker 的精确 resume 与活跃 worker 串行 inbox；防止 bg-resume 复制会话、双 writer 和跨 worktree 误写。
- [x] 5.4 实现显式 relay 模式、次数/预算限制、官方 peer 工具目标核对和回执解析；无真实工具结果不能报告 sent，工具不足返回 unsupported。

验收：`node tools/verify-session-bridge.mjs --group claude`；worker 与 relay 用独立 fixtures，至少覆盖一次活跃目标被拒绝且未创建副本。

## 6. M5 — 意图路由、终态动作与 Astra 主控约定

范围：bridge/intent.cjs、intake/harvest hooks、commands/workflow.md、SKILL.md、新 session-bridge reference、peer-handoff.md、docs/codex-controller.md。

- [x] 6.1 实现 enabled/actions/target/scope 的意图校验，语义判断复用主会话；加入正例、否定、引用、只读、仅 Codex 审阅、模糊主会话和中英文混合用例。
- [x] 6.2 接入 authoring 前 ContextPrepare 与显式 request contract，保证意图未启用时不创建 bridge 状态或启动进程。
- [x] 6.3 接入外层 terminal completion 与 harvest 有界 outbox 兜底，使用 run ID+fingerprint 去重；hook 不等待 CLI/模型，保留三个默认注册 hook。
- [x] 6.4 实现同一 request 显式授权的恢复与撤销优先规则；不同任务不继承，通信目标不进入 Plan/cache key。
- [x] 6.5 编写并用合成收件包验证 Codex controller runbook：读取 OpenSpec、dispatch、status、receive、核对结果、accepted/needs-rework、最多两轮返工；保留 Astra Low 和 Claude opus 逻辑角色。

验收：`node tools/verify-session-bridge.mjs --group intent` 与 `--group integration`；五模板 peer 禁用、默认行为、checkpoint/effort 均无回归，SKILL ≤7000 字符。

## 7. M6 — 验收、使用文档与交付

范围：tools/verify-all.mjs、verify-session-bridge.mjs、README.md、使用 reference、此 change 的 evidence 与 tasks；必要时仅修复已定位问题。

- [x] 7.1 将 bridge 子目录语法与新行为套件纳入 verify-all，运行完整离线入口和 OpenSpec strict；不得让默认验证触发真实模型。
- [x] 7.2 完成受控测试闭环：Astra 指定一个最小代码/测试任务→Claude Code CLI 中的 Ultracode→Codex CLI 回原主控 session→Astra 读取上下文验收；保存双端 ID、运行形态、run ID、message/receipt、diff 与测试证据。主控位于 Codex App 时另记录桌面兼容结果，Claude 端全程只用 CLI。
- [x] 7.3 实测已有活跃 Claude 定向 relay、通知失败后仅恢复投递、重复终态与会话重命名；记录已入队未消费、held/refused/unsupported 等负向结果。
- [x] 7.4 更新 README/reference 的配置、CLI 示例、支持矩阵、排障与回滚；限定修正 legacy/codex-cli 文档中与新 bridge 直接冲突的陈旧说明，不扩展其他模型迁移。
- [x] 7.5 核对全部 requirement/scenario 与验收证据映射；未验证项保留未勾选，汇报业务/投递/主控状态及未完成范围。版本发布、提交、重装按届时明确指令单独执行。

最终验收：`node tools/verify-all.mjs`；`openspec validate add-codex-claude-session-bridge --strict`；`git diff --check`；真实 round-trip 证据。静态全绿不能替代 7.2/7.3。

## 验收边界

- Codex queue 的活跃消息被原 thread 消费为空闲后的新 turn；空闲与目标进程退出时消息保持持久排队。未承诺关闭的 Codex App 会自动唤醒。
- 当前原生 relay 实测 success/msg_id 与 success=false→refused；held 在本机安装中未触发，保留 fixture 解析覆盖并在支持矩阵标为未观察，不能报告真实 held。
- 同一 Claude session 的两个真实 request 已按 FIFO 串行运行，第二项 `resumeRequested=true` 且使用新 Workflow run；跨 worktree 与所有权不明路径继续 fail closed。
- 通知预检失败后只重置并发送同一 outbox，结果 hash 未变且没有 worker 输出；queued/received/accepted 仍分别报告。

未发布、提交、推送或重装。用户原有 drawio 修改保留。

未发布、提交、推送或重装。用户原有 drawio 修改保留。
