# Workflow-Experience

Ultracode workflow 的本机经验库：可粘贴模板、约束速查、运行记录固化、跨会话进度提醒。

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

## 目录

```
├── .claude-plugin/          插件清单 + 本地 marketplace
├── skills/workflow-experience/
│   ├── SKILL.md             ★ 常驻正文，4103 字符（门禁 ≤5200）
│   └── references/          按需 Read，不常驻
│       ├── schemas.md         五件套 schema + 为什么它们从未被真正复用
│       ├── prompt-openers.md  八类开场白原文
│       ├── constraints.md     十类约束句式 + 命中率
│       ├── gitnexus-block.md  前置/后置检查块
│       ├── model-effort.md    模型分工 + effort 门控真相 ★
│       ├── resume-and-args.md 缓存键 / resume 限制 / args 门
│       └── pitfalls.md        十条踩坑记忆
├── templates/               可粘贴成品脚本（核心交付物）
│   ├── four-phase.js          Plan→Review→Preflight→Implement→Verify
│   ├── stage-with-gates.js    拍板边界模板（一个决议一个 workflow）
│   └── readonly-recon.js      只读调研
├── hooks/                   三个 hook，全部实测通过
│   ├── hooks.json
│   ├── harvest-workflow.cjs   Stop：固化 run + 写进度
│   ├── skill-pointer.cjs      PreToolUse(Skill)：注入一行路径指针
│   └── peer-progress.cjs      SessionStart：注入其他会话的新进度
├── tools/
│   └── scan-corpus.mjs      人工触发的语料分析（替代被砍掉的自动闭环）
├── legacy/                  codex 深链接接力（独立能力，不参与 plugin 打包）
└── docs/decisions/          ADR
```

---

## 三个 hook 做什么

| Hook | 事件 | 行为 |
|---|---|---|
| `harvest-workflow` | `Stop` | 轮询 `wf_*.json` 终态 → 复制到 `<项目>/docs/ultracode/raw/` + 追加 `index.jsonl` + 写 `.claude/progress/<sessionId>.jsonl` |
| `skill-pointer` | `PreToolUse(Skill)` | 命中 `workflow-authoring` 时注入 ~30 token 的路径指针 |
| `peer-progress` | `SessionStart(startup\|clear)` | 汇总同项目其他会话的新进度，硬性截断 10 行 / 1500 字符 |

全部**不动全局 `settings.json`** —— plugin 的 `hooks.json` 是追加。这很重要：全局配置里所有 hook 都指向 `127.0.0.1:15721`，而那**同时是 `ANTHROPIC_BASE_URL`**，动它可能打断所有会话。

三个 hook 的共同纪律：
- 任何异常都静默 `exit 0`，绝不阻断会话
- `harvest` 第一件事查 `stop_hook_active`，防递归
- 跨轮次游标存 `os.tmpdir()`，因为 workflow 是后台任务，Stop 触发时文件可能还没落盘

---

## 三条前车之鉴

**1. 上一次沉淀已经烂尾。** `docs/dynamicworkflow` 已经 492K，其中 `generated/` 与 `snippets/` 两个目录**都是空的**，只剩一堆一次性的 prompt 文档。

这次为什么不同：交付的是**可粘贴模板**而不是散文，且 SKILL.md 有体积门禁（≤5200 字符）。

**2. 语料是 n=1 的样本。** 23 个 project 目录里只有 7 个 LDL_UGC 系列有 run。所有约束都深度绑定 OpenSpec 移植上下文。`references/` 里每条都标注了「通用 / LDL_UGC 专有」。

**3. 同名 schema 从未真正被复用。** `PLAN_SCHEMA` 声明 11 次 = **11 个不同签名**，`VERIFY_SCHEMA` 9 次 = 9 个。被复用的是命名习惯，不是代码。

加上沙箱**禁止 `import`/`require`**（AST 层面拒绝），"公共库"在机制上就不成立。所以本项目交付的是**可粘贴片段目录**，不是库。

---

## 已知的重要事实

**effort 门控**（详见 `references/model-effort.md`）：
- `haiku + effort:'max'` 是**空操作**，参数根本不发送
- `sonnet + effort:'xhigh'` **静默降级**为 high
- 全程无报错

要表达"验得更严"，用**取证型 schema**（要退出码 + 原始输出尾巴），不要用 effort。

**resume 限制**（详见 `references/resume-and-args.md`）：
- same-session only —— 跨会话会**静默全量重跑**
- 脚本一字节不能改
- 25 agent / 1.5M token 警告线

所以拍板边界用「一个决议一个 workflow」，不用 resume 续跑。

---

## 待验证

以下尚未实测，使用前建议先验：

- **E4**：`args` 在脚本里的绑定方式未在本机验证。目前模板里写的是 `args?.advisorModel ?? 'fable'`，若不成立需改成常量。
- **hook 在真实 Claude Code 会话中的行为**：三个 hook 都用构造的 stdin 实测通过，但尚未在真实会话里跑过一轮完整流程。

---

## 相关记录

- 立项调研：3 个 Opus 5 workflow，16 agent，231 万 token（2026-09-01）
- 用户拍板：Q6=一个决议一个 workflow / Q7=砍掉自动优化闭环 / Q5=haiku 可以 commit
