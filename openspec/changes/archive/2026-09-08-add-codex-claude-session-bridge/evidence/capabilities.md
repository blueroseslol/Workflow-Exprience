# 本机能力证据

日期：2026-09-08。环境：Windows / PowerShell，本地 Codex App 主控；Claude 全程使用 CLI。开发基线只有 `docs/workflow-main-flow.drawio` 的用户修改，本实现未修改它。插件版本保持 0.5.0。

| 组件 | 本次核实 |
|---|---|
| Node | v24.16.0 |
| OpenSpec | 1.7.0 |
| Codex，bridge 实际 executable | 本机 Codex bundle 的 codex.exe，0.153.4 |
| Codex，PowerShell npm shim | 0.153.0；以 doctor 返回实际 executable 为准 |
| Claude Code | 2.1.260，本机 npm 安装内的原生 claude.exe |

`doctor` 只执行版本/help，不启动模型；其 runtimeVerified=false 是未执行探针的标志，不能当作本文件真实运行结果。

## Codex

- 测试 thread：`01a07fe8-2981-7f12-b195-96dda6d53e49`，独立 cwd 为仓库下 `tmp/bridge-live`。
- 初始 turn：`01a07fe8-2b11-7bb2-8aa4-c72ff0d6692c`，模型 Astra / low，已 completed。
- CLI queue 退出码 0，精确回执：`Queued message 01a07fe8-433b-7252-b809-bd28178c07c7 for thread 01a07fe8-2981-7f12-b195-96dda6d53e49.`
- 原进程退出后，官方 thread/read 为 notLoaded，thread/queue/list 仍返回该 queue ID；thread/turns/list 仅有初始 completed turn。因此已证明持久入队，尚未证明自动唤醒。
- thread/turns/list 和 thread/queue/list 使用 `{data,nextCursor}`。历史读取只开放 read/list 方法。
- Windows daemon/proxy 探针失败，当前 stdio app-server 可以只读访问；其 idle/notLoaded 不代表外部主控没有 writer。生产 resume 默认拒绝，不自动替代 queue。

完整矩阵见 [codex-queue-matrix.json](codex-queue-matrix.json)：活跃时 queue ID `01a0802b-8333-7ca3-8b5c-ccccba2ce4a8` 被消费为新 turn；空闲时 `01a0802b-f6bf-7e51-9566-d145409e9fc5` 保持待取；目标进程退出为 notLoaded 后，前一消息和新 queue ID `01a0802b-f83a-7903-a20a-6f2455f62c51` 都仍可读。原始合成 queue/readback 保存在忽略目录 `tmp/bridge-live`。不发布个人历史、密钥或原始认证错误页面。

## Claude

初期模型映射不可用与 403 阻断；用户调整 cc-switch 后重新测试成功，没有修改全局模型/凭证配置。

- 成功 CLI session：`ce798b4c-d4af-4d96-80b9-cb115082f4ec`。
- CLI：`-p --model opus --plugin-dir <repo> --output-format stream-json --verbose`，退出码 0，约 52 秒，7 turns。
- 真实 Workflow：`wf_7d9c6330-b82`，status=completed，result=`{status:"completed",probe:"bridge-cli"}`，agentCount=0，durationMs=6。
- CLI init 中可见 Workflow、Skill、ListAgents、SendMessage；技能与工具可见不单独作为运行证据。
- 原生快照在匹配 session 的 workflows/wf_7d9c6330-b82.json；内联脚本被保存到同 session 的 workflows/scripts/。结果校验只接受工作区或这个确切 session 的脚本目录。
- 已在真实 `claude agents --json --all` 中解析出受控测试 worker 的名称、ID、cwd。

同 session `ce798b4c-d4af-4d96-80b9-cb115082f4ec` 退出后通过 --resume 恢复，并设置 --name bridge-capability-renamed；实际 session ID 保持相同，退出码 0，toolCalls=0。

真实 relay 中 ListAgents 只显示名称和短 peer ID，不包含完整 session ID/cwd。adapter 先用 agents --json --all 验证完整身份，再要求 ListAgents 核对唯一精确名称。SendMessage 返回 `{success:true,msg_id:...}`，不是早期假定的 `{status:"sent"}`。已按实际原生格式解析，并核对调用目标和消息原文；第一次因缺少完整 ID 而未发消息，第二次实际发送成功，未盲重发未知消息。

真实缺失目标 relay 调用了精确 SendMessage 原文，CLI 退出码仍为 0，但工具返回 `success:false`；adapter 映射为 refused，见 [claude-relay-negative.json](claude-relay-negative.json)。当前安装未产生 held 原生回执，因此 held 只保留 fixture 解析覆盖，不宣称真实观察。

同一受控 session `1fc15528-b75b-4fe7-85b3-d096b11d3546` 的串行 inbox 见 [claude-inbox-live.json](claude-inbox-live.json)：第二 request 初始 queuePosition=1，前一 runner 最后心跳与第二 runner 启动相隔 3130 ms；第二项 resumeRequested=true、sessionBound=true，创建不同 run `wf_b28fb5b6-379`，将 serial.cjs 的 1 改为 2，聚焦测试 1/1 通过。两个 runner/child 均确认退出，两个结果均 completed，投递保持 queued 等待主控收件。

## 发布支持矩阵

| 能力 | 当前本机结论 | 真实证据 |
|---|---|---|
| 新建受控 worker | supported | 固定 session、CLI 身份、真实 Workflow 与 round-trip |
| 已退出 worker 精确 resume | supported | 原 session ID 保持且 rename 不改身份 |
| 活跃受控 worker 串行 inbox | supported | 两 request、同 session、不同 Workflow、零 runner 重叠 |
| 活跃外部会话 relay 正向 | supported | ListAgents + SendMessage，success/msg_id |
| relay refused | supported | 缺失目标 success=false，映射 refused |
| relay held | recognized, not observed | fixture 解析通过；当前安装无真实 held 回执 |
| Codex queue | supported | active/idle/notLoaded 三态均返回精确 queue ID |
| Codex resume transport on Windows | unsupported | 只读状态不足以证明 owner，保持 fail closed |
| 通知预检失败恢复 | supported | 同一 outbox 重试，未重跑 worker，见 delivery-recovery.json |

代码任务 round-trip 与各层最终状态见 test-results.md。

## 依据

- 本机 CLI help、官方 CLI 返回与 Workflow 快照是本次主要依据。
- https://developers.openai.com/codex/cli/reference
- https://developers.openai.com/codex/app-server
- https://code.claude.com/docs/en/workflows ：非交互模式显式使用 Workflow 工具，关键词本身不触发。

以上是当前安装的能力快照，不承诺其他版本或平台完全相同。
