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
│   ├── SKILL.md             ★ 常驻正文，5168 字符（门禁 ≤5200）
│   └── references/          按需 Read，不常驻
│       ├── schemas.md         五件套 schema + 为什么它们从未被真正复用
│       ├── prompt-openers.md  八类开场白原文
│       ├── constraints.md     十类约束句式 + 命中率
│       ├── gitnexus-block.md  前置/后置检查块
│       ├── model-effort.md    模型分工 + effort 门控真相 ★
│       ├── dynamic-routing.md 动态模型路由 + GitNexus 复杂度评分（实验）
│       ├── resume-and-args.md 缓存键 / resume 限制 / args 门 / 两级暂停（Resume vs Checkpoint）
│       └── pitfalls.md        十条踩坑记忆
├── templates/               可粘贴成品脚本（核心交付物）
│   ├── four-phase.js          Plan→Review→Preflight→Implement→Verify（默认 baseline）
│   ├── gitnexus-routed.js     动态路由：Recon→JS评分→派生模型链→对抗Review（实验）
│   ├── stage-with-gates.js    拍板边界模板（一个决议一个 workflow）
│   └── readonly-recon.js      只读调研
├── commands/
│   └── workflow.md            /workflow-experience:workflow 命令入口
├── hooks/                   四个 hook，全部实测通过
│   ├── hooks.json
│   ├── harvest-workflow.cjs   Stop：固化 run + 写进度
│   ├── skill-pointer.cjs      PreToolUse(Skill)：注入一行路径指针
│   ├── peer-progress.cjs      SessionStart：注入其他会话的新进度
│   └── workflow-intake.cjs    UserPromptSubmit：workflow 前缀 → 意图路由
├── tools/
│   └── scan-corpus.mjs      人工触发的语料分析（替代被砍掉的自动闭环）
├── legacy/                  codex 深链接接力（独立能力，不参与 plugin 打包）
└── docs/decisions/          ADR
```

---

## 四个 hook 做什么

| Hook | 事件 | 行为 |
|---|---|---|
| `harvest-workflow` | `Stop` | 轮询 `wf_*.json` 终态 → 复制到 `<项目>/docs/ultracode/raw/` + 追加 `index.jsonl` + 写 `.claude/progress/<sessionId>.jsonl` |
| `skill-pointer` | `PreToolUse(Skill)` | 命中 `workflow-authoring` 时注入 ~30 token 的路径指针 |
| `peer-progress` | `SessionStart(startup\|clear)` | 汇总同项目其他会话的新进度，硬性截断 10 行 / 1500 字符 |
| `workflow-intake` | `UserPromptSubmit` | 在消息首个非空白字符处匹配 `workflow ` / `/workflow ` 前缀 → 注入意图路由指令（兼容旧前缀 `workflow-experience `；正文、代码块/引用内提及不触发） |


四个 hook 的共同纪律：
- 任何异常都静默 `exit 0`，绝不阻断会话
- `harvest` 第一件事查 `stop_hook_active`，防递归
- 跨轮次游标存 `os.tmpdir()`，因为 workflow 是后台任务，Stop 触发时文件可能还没落盘