# 验收结果与需求映射

2026-09-08 离线：`node tools/verify-all.mjs` 退出码 0，bridge 68/68，原 checkpoint/state、模型回退、effort 路由均通过；SKILL 6932/7000 字符，30 个语法检查。默认入口 liveModelCalls=0。OpenSpec strict 和 git diff --check 通过。

## Requirement / Scenario 映射

| requirement | scenario 覆盖与证据 |
|---|---|
| 会话引用解析为固定身份 | contract：URI、重名、cwd、改名后 ID 不变；真实 agents 枚举见 capabilities |
| 双向上下文必要信息 | context 预算/必需字段、Result task 覆盖与测试证据；integration 完整合成收件 |
| 有界只读历史与证据分离 | context：旧 rollout、Claude transcript、分页 RPC、超大行；assistant 文本为 unverified-claim |
| 路径和包完整性 | store/context：junction、越界、hash 替换、worktree 映射、文件内容漂移 |
| Claude 仅 CLI | 真实 CLI+Workflow run，见 capabilities；无需 Desktop |
| Codex 已验证定向发送 | codex：精确 queue 回执、无回执不冒充成功、unsupported 无降级；真实 queue/readback |
| 固定 worker 与活跃投递 | claude：固定 session、退出后 resume、活跃 inbox、跨 worktree 阻断、工具回执；真实串行与 relay 正负证据齐全 |
| 消息不成为 shell 代码 | store：中文/空格/Windows 元字符 argv 字面传输，shell:false |
| 成果与回执独立 | recovery/integration：queued→received→accepted、重复收件、发送返回前已收件 |
| 幂等故障恢复 | recovery：terminal 去重、冲突、sending→unknown、重试仅预检失败、reconcile 不重发 |
| 所有权与取消 | store/recovery：共享 worktree 锁、活跃 PID/子进程/未知 Workflow 不抢锁、取消阻断发送 |
| 显式意图结构化 | intent：默认关闭、原话/引用/否定/目标；语义分类由主会话执行，无额外 LLM |
| 同任务恢复不串任务 | intent/contract：request/scope/撤销与权限摘要变化 |
| 通信位于外层 | claude/integration：runner 等真实快照，harvest 只处理绑定 session/run；原五模板 peer 禁用验证 |
| 原流程与主控兼容 | verify-all 原三套件、普通 harvest 无目录创建、主控 receive/acknowledge；缓存不包含 bridge |

## 真实联调

隔离代码任务完成，证据结构化摘要见 [roundtrip.json](roundtrip.json)：

- request：`6750a742-fe6e-441d-9ad2-f723fe953ea1`。
- Claude worker：`b5dd41be-95f3-4914-9129-2ade5aa94d08`，CLI 退出码 0，持久 runner 已退出。
- Workflow：`wf_d17ca951-fc1`；一个 sonnet agent 修改 answer.cjs，将 41 改为 42；没有业务提交。
- 原测试 Codex：`01a07fe8-2981-7f12-b195-96dda6d53e49`；Astra low 读取结果、检查 diff、复跑 node --test answer.test.cjs，1 passed/0 failed，并执行 receive/acknowledge。
- 逻辑 messageId：`805e15cb67ecf5bb092a2f4e73750deb8c6146267dded0c4aa8addf47b7e8233`。
- 结果 SHA256：`a884eee706291e9d0c9064d9bf42fb7df9e93ef6674854a0947f3d72438c2c16`。
- 三层最终状态：workStatus=completed，deliveryStatus=received，controllerStatus=accepted。
- 实际收件时间：2026-09-08T08:07:25.571Z，实际验收时间：2026-09-08T08:07:36.141Z。
- 原主控以测试专用 app-server 显式恢复加载并授予隔离目录写入权限后消费；未证明关闭的 Codex App 会自动醒来。生产 history adapter 未开放这些测试用写入方法。
- 活跃 relay 工具消息 ID：`6b093f9a-3e6e-4d5f-ae07-bacb5a1b987b`，SendMessage success=true。仅证明原生 peer 投递，业务 receipt 仍独立。更新 parser 后使用此次真实输出离线重放确认识别，无重复实际发送。
- 缺失 relay 目标 `bridge-absent-4f8c0bf0` 的原生 SendMessage 返回 success=false，CLI exit 0；adapter 映射 refused，见 [claude-relay-negative.json](claude-relay-negative.json)。本机未触发 held，矩阵只标记 recognized/not observed。
- Codex queue 三态矩阵见 [codex-queue-matrix.json](codex-queue-matrix.json)：活跃消息被原 thread 消费为新 turn；空闲和进程退出后的消息都保持在 queue/readback 中。
- 通知恢复见 [delivery-recovery.json](delivery-recovery.json)：真实缺失 executable 在提交前失败为 unsupported，重置同一 outbox 后 queue 成功并 receive；attempts 1→2、result hash 不变、无 worker output。
- 活跃受控 inbox 见 [claude-inbox-live.json](claude-inbox-live.json)：两个 request 共用 session `1fc15528-b75b-4fe7-85b3-d096b11d3546`；第二项先 queuePosition=1，随后 resumeRequested=true，使用新 run `wf_b28fb5b6-379`，serial.cjs 1→2 且测试 1/1 通过。两个 runner/child 最终均确认退出。
- 该探针暴露并修复一个状态覆盖缺陷：外层已 complete 时 runner 不应继续落入不可解释终态分支。新增离线回归后，以既有 result.json 幂等恢复状态，没有重跑 Workflow 或业务修改。

原始合成材料位于被忽略的 tmp/bridge-live、tmp/bridge-roundtrip；没有把原始用户会话或认证错误内容提交为证据。

## 保留边界

Codex queue 的 queued 仍不代表 received；关闭的 Codex App 自动唤醒未承诺。原生 held 本机未观察，不能写成实测成功。Windows Codex resume transport 因 owner 无法证明保持 unsupported。版本未发布、提交或重装。
