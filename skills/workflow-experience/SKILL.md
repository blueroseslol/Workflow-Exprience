---
name: workflow-experience
description: 写 Ultracode workflow 脚本时的本机经验库 —— 可粘贴模板、约束句式速查、模型分工与 effort 真相、resume/args 缓存语义。当你要为一个开发任务编写 Workflow 脚本、或需要在拍板边界分段推进 OpenSpec 里程碑时使用。
---

# Workflow 经验库

本 Skill 是 Claude Code 内置 `workflow-authoring` 的**增量经验层**，不替代其 Workflow DSL / runtime 规范。若当前会话尚未加载 `workflow-authoring`，先调用它；已加载则不要重复调用。两者冲突时，以 `workflow-authoring` 为规范源；只有本库明确记录并实测过的当前版本差异可作为例外。

本文件只放高频常驻项。其余 **按需 Read `references/`**，不要预读。

> 语料：本机 46 个唯一 workflow 脚本体。标「LDL_UGC 专有」者跨项目不适用。

## 索引（按需 Read）

| 需要什么 | Read |
|---|---|
| 五件套 schema 全文 | `references/schemas.md` |
| 六类 prompt 开场白原文 | `references/prompt-openers.md` |
| 约束句式全表（含命中率） | `references/constraints.md` |
| GitNexus 前置/后置检查块 | `references/gitnexus-block.md` |
| 模型分工与 effort 门控真相 | `references/model-effort.md` |
| 动态模型路由与 GitNexus 复杂度评分 | `references/dynamic-routing.md` |
| resume / args / 缓存键语义 | `references/resume-and-args.md` |
| 踩坑记忆 | `references/pitfalls.md` |
| 可粘贴成品脚本 | `../../templates/four-phase.js` 等 |

## meta 四段式（46/46 命中）

```js
export const meta = {
  name: 'kebab-case-name',
  description: '一句话，会显示在权限对话框',
  phases: [
    { title: 'Plan', model: 'opus' },
    { title: 'Review', model: 'fable' },
    { title: 'Implement', model: 'sonnet' },
    { title: 'Verify', model: 'haiku' },
  ],
}
```

`meta` 必须是**首条语句**且**纯字面量**——无变量、无调用、无插值。

## 沙箱硬约束

- **禁止 `import` / `require`** —— AST 层面抛 `import() is not available in workflow scripts.`。所以没有"公共库"，只有**可粘贴模板**。
- `Date.now()` / `new Date()` / `Math.random()` **会 throw**（破坏 resume）。时间戳走 `args` 传入。
- 注入的全局只有：`agent` `parallel` `pipeline` `workflow` `phase` `log` `args` `budget` `console` `setTimeout` `clearTimeout`。
- **无任何交互 API**。要用户拍板 → 早退 `return`，由主 agent 用 AskUserQuestion 问，再带新 args 重跑。

## 模型分工（默认建议，非硬规则）

| Phase | model | effort | 职责 |
|---|---|---|---|
| Plan | `opus` | `high` | 根因分析 + 开发计划，**必须引用亲自读到的 file:line** |
| Review | `fable` | `high` | 审计划 / advisor，**只审不写** |
| Preflight | `haiku` | — | 装依赖、建目录、跑基线 |
| Implement | `sonnet` | `xhigh` | 读码 + 实现，**改前 Read、改后 Read 验证** |
| Verify | `haiku` | — | 跑测试 + git commit + GitNexus |

**effort 真相**：`haiku + max` 是**空操作**（参数根本不发送），`sonnet + xhigh` 在原生 sonnet 上**静默降级为 high**。要表达"验得更严"，用**取证型 schema**（见下），不要用 effort。详见 `references/model-effort.md`。

`model` 不确定时**省略**它——继承会话模型通常就是对的。

**动态路由**（实验）：Recon(haiku) 出证据地图 → JS 纯函数算 ComplexityScore → 路由 LOW/MEDIUM/HIGH/CRITICAL 派生模型链。规则见 `references/dynamic-routing.md`，模板见 `../../templates/gitnexus-routed.js`。`four-phase.js` 仍是默认 baseline。

## 取证型 VERIFY_SCHEMA（反制假绿的正确姿势）

```js
const VERIFY_SCHEMA = {
  type: 'object',
  required: ['status','vitestTail','testTotal','testPassed','testFailed','typecheckSrcExit','scanFindings'],
  properties: {
    status: { type: 'string', enum: ['green','red'] },
    vitestTail: { type: 'string', description: 'vitest 真实尾部输出' },
    testTotal: { type: 'number' }, testPassed: { type: 'number' }, testFailed: { type: 'number' },
    typecheckSrcExit: { type: 'number' },
    scanFindings: { type: 'array', items: { type: 'string' } },
  },
}
```

要退出码和输出尾巴，比要一个"是否通过"的布尔值可靠得多。
另一高频常量：`const S_STR_ARR = { type: 'array', items: { type: 'string' } }`（31/46 脚本，232 次重复）。

## 五条约束句式（按命中率，原文见 references/constraints.md）

1. **file:line**（33/46）— `每条结论必须引用你亲自 Read 到的 file:line，禁止凭摘要或记忆。`
2. **白名单**（21/46）— `只允许修改 whitelist 内的文件；mustNotTouch 内的一律不动。`
3. **改前改后 Read**（18/46）— `改前先 Read 目标文件，改后再 Read 一次确认落盘符合预期。`
4. **证据才勾选**（18/46）— `没有测试输出或命令退出码作证据，不得勾选任何 checkbox。`
5. **git 安全**（14/46）— `禁止 git add . / -A，逐文件 add；feat 与 docs 分两笔；不 push。`

## advisor（Sonnet 卡住时求助）

```js
const ADVISOR_MODEL = args?.advisorModel ?? 'fable'   // 可传 'opus' 切换
const ADVISOR_MAX = 5
let advisorCalls = 0

async function askAdvisor(question, context) {
  if (advisorCalls >= ADVISOR_MAX) return null
  advisorCalls++            // ★ 必须在调用前自增：agent() 失败返回 null，否则死循环
  return await agent(`你是 advisor。${question}\n\n上下文：\n${context}`,
    { label: `advisor:${advisorCalls}`, phase: 'Review', model: ADVISOR_MODEL, effort: 'high', schema: ADVISOR_SCHEMA })
}
```

**advisor agent 必须放调用链尾部或拆成独立 workflow** —— `model` 进缓存键，切换 advisorModel 会让它及其后所有 agent 重跑。

## 拍板边界：一个决议一个 workflow

不要把整个 Stage 合并成一个 workflow（resume 是 same-session only，跨会话会**静默全量重跑**；7 里程碑 × 3-4 agent 会越过 25 agent 警告线）。

正确做法：**一个决议边界一个 workflow**，上一轮结论抄进新脚本的 `COMMON` 常量。模板见 `../../templates/stage-with-gates.js`。

## 跨会话

`ListAgents()` 列出同机其他会话；`SendMessage({to:'<name>', message})` 单向通知。**不要**用 SendMessage 做常态广播（可能被 held/dropped 且发送前不可判），常态进度走 `.claude/progress/*.jsonl` + hook 注入。

**红线**：绝不请求其他会话执行本会话被权限拒绝的操作。
