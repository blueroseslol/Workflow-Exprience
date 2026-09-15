# Workflow-Experience

Ultracode workflow 的本机经验库：可粘贴模板、约束速查、运行记录固化、显式跨会话定向回传。

以 **Claude Code plugin** 形式提供（而非裸 skill），因为需求中的三个 hook 必须常驻。

---

## 这个项目要解决什么

**不是省 token。** 立项时的假设是"加载经验文档能省下写脚本的 token"，实测数据推翻了它：

| 事实 | 数字 |
|---|---|
| 内置 `workflow-authoring` 正文 | 17112 字符 ≈ 4753 token |
| 单次 run 的 token 中位数 | 332,482 |
| 写脚本占一次 run 的比例 | **约 0.8%** |
| 单次 `killed` 最贵烧掉 | 4,771,599 token |

写脚本本来就不费钱。而且 hook 的 `additionalContext` 是**追加不是替换** —— 注入文档后内置正文照常返回，纯增量 = 更贵。

**真正要解决的是 abort 与返工。** 当前基线（`node tools/scan-corpus.mjs` 实测）：

```
运行记录：44 个
状态分布：completed=36  killed=7  failed=1
★ 非 completed 占比：18.2%（8/44）
```

**成功指标：让这个百分比下降。** 防住一次 killed，抵得上一百次加载文档。

---

## 安装

Reviewer 自修、受控讨论、脚本预检和失败阶段恢复见 [使用说明](docs/workflow-review-repair.md)。两条开发主模板默认不提交；验证必须提供逐条命令及退出码。

```bash
# 1. 添加本地 marketplace
/plugin marketplace add D:/AI/Skill/Workflow-Exprience

# 2. 安装
/plugin install workflow-experience@workflow-experience

# 3. 验证：应看到 workflow-experience，且内置 workflow-authoring 仍在
/skills
```

⚠️ **skill 目录名必须是 `workflow-experience`，绝不能叫 `workflow-authoring`** —— 同名会**静默遮蔽**内置正文，而内置正文里含 resume 语义，正是拍板续跑方案的依赖。

---

## 提交开发需求

装好后，用 `workflow` 前缀提交需求即可，模板名不外露：

| 写法 | 机制 |
|---|---|
| `workflow 修复角色登录后偶尔状态不同步` | UserPromptSubmit hook 注入意图路由 |
| `/workflow 调研背包系统为什么这么设计` | 同上（未注册命令时作为文本被 hook 拦截） |
| `/workflow-experience:workflow 实现 openspec xxx 全部任务` | plugin 自带命令（含命名空间） |

意图路由自动选链：修 bug / 功能改动 → 动态路由链（Recon→评分→Plan→Review→Implement→Verify）；只调研不改码 → 只读链；OpenSpec 多里程碑 → 一里程碑一 workflow、拍板点早退。

> 想要**裸 `/workflow`**（无命名空间、有补全）：把 `commands/workflow.md` 复制到 `~/.claude/commands/` 即可；不复制也能用，hook 会拦截。

---

## 目录

```
├── .claude-plugin/          插件清单 + 本地 marketplace
├── skills/workflow-experience/
│   ├── SKILL.md             ★ 常驻增量经验（原生 authoring contract 不复述；门禁 ≤7000）
│   └── references/          按需 Read，不常驻
│       ├── openspec-first.md  OpenSpec-first 增量规划 / DecisionApply / PlanPatch ★
│       ├── schemas.md         本机取证型 schema 实例 + 复用统计
│       ├── prompt-openers.md  八类开场白原文
│       ├── constraints.md     十类约束句式 + 命中率
│       ├── gitnexus-block.md  前置/后置检查块
│       ├── model-effort.md    模型别名 + effort 本机实测差异 ★
│       ├── dynamic-routing.md 动态模型路由 + GitNexus 复杂度评分（实验）
│       ├── codex-cli.md        authoring-time Codex CLI 可选覆盖
│       ├── resume-and-args.md 缓存键 / resume 限制 / 两级暂停（Resume vs Checkpoint）
│       ├── peer-handoff.md    显式要求的跨会话定向回传协议
│       └── pitfalls.md        十条踩坑记忆
├── templates/               可粘贴成品脚本（核心交付物）
│   ├── four-phase.js          Plan→Review→Preflight→Implement→Verify（默认 baseline）
│   ├── gitnexus-routed.js     动态路由：Recon→JS评分→派生模型链→对抗Review + checkpoint 消费（v0.4.3）
│   ├── openspec-incremental.js OpenSpec-first 增量执行：BasePlan overlay→DecisionApply→PlanPatch→SpecSync
│   ├── stage-with-gates.js    拍板边界模板（一个决议一个 workflow）
│   └── readonly-recon.js      只读调研
├── commands/
│   └── workflow.md            /workflow-experience:workflow 命令入口
├── hooks/                   三个默认注册 hook，全部实测通过
│   ├── hooks.json
│   ├── checkpoint-lib.cjs     语义 checkpoint：建档/验证/resolver/backfill（v0.4.3 legacy+kind=none）
│   ├── harvest-workflow.cjs   Stop：固化 run + 写进度 + Haiku 上下文失败续起（v0.4.5）
│   ├── skill-pointer.cjs      PreToolUse(Skill)：注入一行路径指针
│   ├── peer-progress.cjs      历史/手动读取工具（保留文件，默认不注册、不自动注入）
│   └── workflow-intake.cjs    UserPromptSubmit：workflow 前缀 → 意图路由 + checkpoint resolver
├── tools/
│   ├── scan-corpus.mjs      人工触发的语料分析（替代被砍掉的自动闭环）
│   ├── verify-model-fallback.mjs 上下文分类→Stop 续起→Sonnet phase override 离线验证
│   ├── verify-effort-routing.mjs 五模板 effort wrapper 的 stub 执行验证
│   ├── verify-state-pipeline.mjs 语义缓存管道端到端检查（含 LDL_UGC 干跑）
│   └── verify-all.mjs          全部离线语法与行为验收入口
├── legacy/                  codex 深链接接力（独立能力，不参与 plugin 打包）
└── docs/decisions/          ADR
```

---

## 三个默认注册 hook 做什么

| Hook | 事件 | 行为 |
|---|---|---|
| `harvest-workflow` | `Stop` | 固化 `wf_*.json` + 写 index/progress；明确 Haiku 上下文失败时阻止停止一次并要求 Sonnet 恢复 |
| `skill-pointer` | `PreToolUse(Skill)` | 命中 `workflow-authoring` 时注入 ~30 token 的路径指针 |
| `workflow-intake` | `UserPromptSubmit` | 在消息首个非空白字符处匹配 `workflow ` / `/workflow ` 前缀 → 注入意图路由指令（兼容旧前缀 `workflow-experience `；正文、代码块/引用内提及不触发） |

`peer-progress.cjs` 仍保留为历史兼容/手动排障工具，但 `hooks/hooks.json` 不再注册 `SessionStart(startup|clear)`。因此默认安装只持续写入 `.claude/progress/*.jsonl` 作为 checkpoint，绝不自动读取或向新会话注入其他会话进度。

**v0.4.4 消息边界**：顶层 Workflow DSL 没有 peer primitive，但 LLM 子代理可能拥有 `ListAgents` / `SendMessage`。五个 `templates/*.js` 成品模板及仍可执行的 `legacy/codex-relay.workflow.js` 统一让每次 agent 调用经过 wrapper，在保留调用点原有 `disallowedTools` 的同时硬禁这两个工具；不依赖 prompt 自律。

**v0.4.5 Haiku 上下文恢复**：Workflow DSL 在运行中只把失败的 `agent()` 暴露为 `null`，无法区分用户跳过、权限、网络、schema 与上下文错误，因此插件不会对普通 `null` 盲目重试。Stop/harvest 会从终态 `workflowProgress/logs` 精确识别 `Prompt is too long`、自动压缩失败和空摘要；仅当失败来自 Haiku lane 且整个 run 未成功时，输出一次 `decision:block` 续起主会话，要求用原 `scriptPath + resumeFromRunId`，把失败 phase 的模型参数改成 `sonnet`。恢复指令强制先核对工作区、测试与最近提交，避免重复副作用；同一终态指纹只触发一次。五个成品模板已补齐 `reconModel/preflightModel/verifyModel/commitModel` 等按阶段覆盖参数。

**v0.5.0 GPT-5.6 Sol / effort 适配**：五个模板支持 `args.modelEfforts` 和 `args.phaseEfforts`。阶段/角色覆盖优先于逻辑模型覆盖，未指定时完全保持原调用点默认；`null` 可恢复默认。Opus/Sonnet 即使映射同一上游，也按逻辑别名独立配置。checkpoint 会按 key 合并两张 map，Plan/Recon effort 改变会失效对应 artifact，Review effort 改变只触发重审。日志只把传给 runtime 的值称为 `requestedEffort`，没有反代证据时 `actualModel/effectiveEffort` 均为 `unknown`。

可直接这样提交需求：

```text
workflow 修复角色登录状态，opus 使用 max，其他保持默认。
workflow 实现这个 OpenSpec，Implement 用 sonnet，思考强度 high。
workflow 继续上次任务，只把 Review 的思考强度提高到 xhigh。
```

对应的显式 args 形态为：

```js
{
  modelEfforts: { opus: 'max' },
  phaseEfforts: { Implement: 'high', Review: 'xhigh' },
}
```

本机 Claude Code 2.1.260 的 CLI 接受 `low/medium/high/xhigh/max`，但客户端接受只证明插件发起了该请求，不证明 cc-switch 后的上游按该强度执行。运行 `node tools/verify-all.mjs` 可完成不调用模型的离线验收。

只有当前用户的原始需求显式要求 handoff 时，workflow 才把它保留为执行契约；workflow 返回 terminal result 后，外层 Claude Code 主会话才可定向执行 `ListAgents` / `SendMessage`。普通并行开发、历史 checkpoint 或其他会话的存在都不得触发即时消息。

三个默认注册 hook 的共同纪律：
- 任何 hook 自身异常都静默 `exit 0`；只有明确 Haiku context/compaction 失败会有意 `decision:block`
- `harvest` 第一件事读取 `stop_hook_active`；被它续起后的 Stop 只固化、不再次阻止
- 跨轮次游标存 `os.tmpdir()`，因为 workflow 是后台任务，Stop 触发时文件可能还没落盘

## Workflow Bridge（暂时停用）

**从 0.5.4 起暂停启用。** 当前接入与恢复流程未达到开箱即用的要求，插件不再注册 Bridge MCP/Channel、会话 hooks 或自动收集 Bridge 结果；Bridge CLI 的派发和回传写操作也默认关闭。普通 Workflow、Review/Repair 与 checkpoint 功能继续使用。

本机 Codex 主控 Skill 已移出 skills 目录，安装脚本默认拒绝重新安装。源码及已有请求/结果保留供后续改进，下面的安装和接入内容属于停用前的历史说明，不代表当前可直接启用。维护测试可在隔离子进程设置 `WORKFLOW_BRIDGE_ENABLE_EXPERIMENTAL=1`；`verify-all` 仅对相应离线测试显式设置该值，不会启用用户会话。

### 停用前的 Codex 主控 Skill（源码保留）

两端分别安装：Claude Code 使用本仓库的 `workflow-experience` 插件；Codex 使用 [workflow-bridge-controller](codex-skills/workflow-bridge-controller/SKILL.md)。主控 Skill 负责准备契约、派发、查询 ACK、接收验收结果和恢复通知，调用现有 Bridge CLI。它不启用 Claude Channel，也不会因被加载就发送任务。

Skill 源码仍保留在仓库，供后续重新设计时参考。当前版本安装脚本会主动拒绝安装；以下命令仅展示历史安装入口：

```powershell
node tools/install-codex-skill.mjs
```

默认安装到 `$CODEX_HOME/skills/workflow-bridge-controller`，未设置 CODEX_HOME 时为 `~/.codex/skills/workflow-bridge-controller`。可用 `--dest <绝对skills目录>` 指定位置。相同内容重复安装不改动，已有不同内容会保留并报错，更新前应比较和备份。

功能重新启用前不要使用以下调用：

```text
使用 $workflow-bridge-controller，把当前已授权任务发送给指定 Claude Code 会话，确认接收回执后跟进结果。
使用 $workflow-bridge-controller，检查这个 request 的状态；如果只是通知失败，按已有授权恢复通知。
```

Skill 重新启用后可保持自动发现，也可用 `$workflow-bridge-controller` 显式调用。历史实现需要 Node.js 与 Claude 插件 0.5.3 或更新版本；当前 0.5.4 默认停用。自带的 `scripts/locate-runtime.cjs` 只读定位当前用户级安装并返回 CLI/文档路径；安装候选不唯一时需明确选择，也支持 `WORKFLOW_BRIDGE_PLUGIN_ROOT` 指定绝对运行时目录。

目标 Claude 仍需按 [Channel 接入说明](docs/claude-channel.md) 启用通道并调用 `bridge_connect`。新请求须区分会话 `worker.cwd` 与 Git `workspace.worktreeRoot`；只有 `receiptConfirmed:true` 才确认目标已收到。Skill 不内置任何 backend 会话 ID、项目路径、模型或费用授权。

维护时运行 `node tools/verify-codex-skill.mjs` 检查安装幂等、已有修改保护和运行时定位；此项也纳入 `node tools/verify-all.mjs`。Skill 源文件放在独立 `codex-skills/` 下，避免被 Claude 当成其原生 workflow Skill 加载。

### Bridge 运行机制

活跃会话新增 [本地 Channel + 接收回执](docs/claude-channel.md)：Codex 直接写持久队列，由目标会话接收并 `bridge_ack`，无需临时 Claude relay。支持身份校验、超时可见、重复投递去重和断线保守恢复。使用前需在目标显式启用开发 Channel 并调用 `bridge_connect`；离线协议验收与真实会话验收分开记录。

新增 `node tools/session-bridge.mjs`：按原 Codex session ID 和工作区绑定任务，生成带 hash 的上下文，启动 Claude Code CLI 内的 Ultracode，终态经 Codex CLI queue 回原会话。业务完成、消息入队、主控收件与验收分别记录。深度链接用于定位会话。

入口见 [Astra 主控操作说明](docs/codex-controller.md)、[命令与结果契约](skills/workflow-experience/references/session-bridge.md)；实施和真实联调进度见 [OpenSpec 任务](openspec/changes/add-codex-claude-session-bridge/tasks.md)。执行 `node tools/session-bridge.mjs doctor` 只读检查 CLI；`node tools/verify-all.mjs` 不调用模型。

只有本次明确协作意图才启用；普通 workflow 保持默认。bridge 状态位于工作区 `.workflow-bridge/`，不会写回会话数据库。原 0.5.0 路径已验证真实 Ultracode 代码任务→Codex queue→原 Astra 会话验收、活跃 Claude 定向 relay、原 ID queue 状态矩阵、通知恢复，以及同一 Claude session 的受控串行 inbox。0.5.2 新增 Channel 双向回执、候选结果自动回传与 Windows CLI 启动诊断；新通道真实会话验收见接入说明，不能复用旧 relay 验收代替。

**按需 Reviewer / 实现 Adviser**：两条开发主模板默认 `reviewMode=auto`，低/中难度且低风险、证据与验收充分才跳过独立 Review；高风险或关键不确定性强制审查。实现 Agent 遇到疑难点，可按问题选 Fable/Opus 顾问；Implement/Repair 共享每 run 默认 3 次预算。配置与边界见 [说明](docs/workflow-adaptive-review-advisor.md)。
