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


三个 hook 的共同纪律：
- 任何异常都静默 `exit 0`，绝不阻断会话
- `harvest` 第一件事查 `stop_hook_active`，防递归
- 跨轮次游标存 `os.tmpdir()`，因为 workflow 是后台任务，Stop 触发时文件可能还没落盘