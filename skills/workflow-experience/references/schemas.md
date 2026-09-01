# Schema 速查

## 重要前提：schema 从未被真正复用

语料实测：

| Schema 名 | 声明次数 | **唯一签名数** |
|---|---|---|
| `PLAN_SCHEMA` | 11 | **11** |
| `VERIFY_SCHEMA` | 9 | **9** |
| `REVIEW_SCHEMA` | 8 | **8** |
| `RECON_SCHEMA` | 7 | 5 |
| `AUDIT_SCHEMA` | 5 | 3 |
| `IMPLEMENT_SCHEMA` | 4 | 4 |
| `VERDICT_SCHEMA` | 3 | **1** ← 唯一真正复用的 |

`PLAN_SCHEMA` 声明 11 次产生 11 个**互不相同**的结构。被复用的是**命名习惯**，不是代码。

**推论**：下面的 schema 是**起点**，不是标准。按任务改字段是正常的，不要为了"统一"而削足适履。

---

## 通用片段

```js
const S_STR_ARR = { type: 'array', items: { type: 'string' } }   // 31/46 脚本，232 次
```

**始终加 `additionalProperties: false`** —— 否则模型会塞进你没要的字段，schema 就失去了约束力。

---

## PLAN_SCHEMA（规划层）

```js
const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'rootCause', 'slices', 'whitelist', 'mustNotTouch', 'testCommands', 'openQuestionsForUser'],
  properties: {
    verdict: { type: 'string', enum: ['implementable', 'blocked'] },
    rootCause: { type: 'string', description: '根因，必须含 file:line' },
    slices: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'files', 'rationale'],
        properties: { title: { type: 'string' }, files: S_STR_ARR, rationale: { type: 'string', description: '含 file:line' } },
      },
    },
    whitelist: S_STR_ARR,
    mustNotTouch: S_STR_ARR,
    testCommands: S_STR_ARR,
    rollback: { type: 'string' },
    openQuestionsForUser: S_STR_ARR,
  },
}
```

**设计要点**：
- `verdict` 是二元枚举 —— 不给"基本可行"的模糊余地
- `openQuestionsForUser` 是**早退门**的输入。非空就 return，不要让 workflow 带着未定的前提往下跑
- `rootCause` 的 description 里写死"必须含 file:line"，比在 prompt 里劝有效

---

## REVIEW_SCHEMA（审阅 / advisor）

```js
const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'blockers', 'concerns'],
  properties: {
    verdict: { type: 'string', enum: ['approve', 'approve-with-changes', 'block'] },
    blockers: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['issue', 'evidence'],
        properties: { issue: { type: 'string' }, evidence: { type: 'string', description: 'file:line 或计划原文' } },
      },
    },
    concerns: S_STR_ARR,
  },
}
```

**`blockers` 必须带 `evidence`** —— 否则 advisor 容易给出"感觉有风险"这类无法处理的反馈。要求它指出具体位置，能过滤掉一半的空泛担忧。

---

## VERIFY_SCHEMA（验证层，取证型）★

这是**唯一能反制假绿**的设计。详见 `model-effort.md` 第三节。

```js
const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'vitestTail', 'testTotal', 'testPassed', 'testFailed', 'typecheckSrcExit', 'baselineDelta', 'commits', 'scanFindings'],
  properties: {
    status: { type: 'string', enum: ['green', 'red'] },
    vitestTail: { type: 'string', description: 'vitest 真实尾部输出，原样粘贴' },
    testTotal: { type: 'number' }, testPassed: { type: 'number' }, testFailed: { type: 'number' },
    typecheckSrcExit: { type: 'number' },
    baselineDelta: { type: 'string', description: '与 Preflight 基线对比；低于基线视为回退' },
    commits: S_STR_ARR,
    scanFindings: S_STR_ARR,
  },
}
```

三个反假绿机制：
1. **要原始输出**（`vitestTail`）—— 比"测试通过了"难伪造
2. **要退出码**（`typecheckSrcExit`）—— 数字，可事后复核
3. **要基线对比**（`baselineDelta`）—— 抓"全绿但测试数变少"的覆盖面缩水

---

## RECON_SCHEMA（只读调研）

```js
const RECON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['topic', 'findings', 'evidence', 'unknowns'],
  properties: {
    topic: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['claim', 'detail', 'confidence'],
        properties: {
          claim: { type: 'string' }, detail: { type: 'string' },
          confidence: { type: 'string', enum: ['verified', 'likely', 'speculative'] },
        },
      },
    },
    evidence: S_STR_ARR,
    unknowns: S_STR_ARR,
  },
}
```

**`confidence` 三档是关键**。没有它，模型会把推测和事实混在一起陈述，下游 agent 无法分辨。有了它，合成层可以只信 `verified`。

**`unknowns` 是必填** —— 逼模型正面回答"你没查清什么"，比它悄悄略过好。

---

## IMPLEMENT_SCHEMA（实现层）

```js
const IMPLEMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['done', 'filesChanged', 'notImplemented', 'honesty'],
  properties: {
    done: { type: 'boolean' },
    filesChanged: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['path', 'what'],
        properties: { path: { type: 'string' }, what: { type: 'string' } },
      },
    },
    notImplemented: { type: 'array', items: { type: 'string' }, description: '计划里有但本轮没做的，必须诚实列出' },
    honesty: { type: 'string', description: '有什么是你没验证的' },
  },
}
```

`notImplemented` + `honesty` 是**结构性诚实保障** —— 比在 prompt 里写"请如实报告"有效得多。required 里带上它们，模型就必须正面回答。

---

## VERDICT_SCHEMA（唯一被真正复用的，3 次声明 1 个签名）

```js
const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reasoning', 'nextStep'],
  properties: {
    verdict: { type: 'string', enum: ['proceed', 'change-approach', 'stop-and-ask'] },
    reasoning: { type: 'string' },
    nextStep: { type: 'string' },
  },
}
```

它之所以能复用，是因为它**不含任何任务特定字段**。这是可复用 schema 的唯一形态：小、抽象、只表达决策而非内容。

advisor 用的就是它。
