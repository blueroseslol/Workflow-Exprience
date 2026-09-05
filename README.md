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
│   └── verify-state-pipeline.mjs 语义缓存管道端到端检查（v0.4.3，含 LDL_UGC 干跑）
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

只有当前用户的原始需求显式要求 handoff 时，workflow 才把它保留为执行契约；workflow 返回 terminal result 后，外层 Claude Code 主会话才可定向执行 `ListAgents` / `SendMessage`。普通并行开发、历史 checkpoint 或其他会话的存在都不得触发即时消息。

三个默认注册 hook 的共同纪律：
- 任何 hook 自身异常都静默 `exit 0`；只有明确 Haiku context/compaction 失败会有意 `decision:block`
- `harvest` 第一件事读取 `stop_hook_active`；被它续起后的 Stop 只固化、不再次阻止
- 跨轮次游标存 `os.tmpdir()`，因为 workflow 是后台任务，Stop 触发时文件可能还没落盘
