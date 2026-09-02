# ADR-007：持久语义缓存——Runtime Resume + Artifact Restore 两级命中

**日期**：2026-09-02
**状态**：已采纳
**关系**：补充 ADR-005，不推翻 same-session resume 规则

## 背景

OpenSpec-first v0.3 已经把 `proposal/specs/design/tasks` 当作长期 Plan IR，并避免把 `args.decisions` 塞回 BasePlan prompt。但它仍有一个结构性缺口：只要主 agent 新开一个 Workflow run，模板仍会重新执行 `Recon → BasePlan → Review`。

Ultracode 原生 cache 只能通过 `resumeFromRunId` 复用，而且受两个硬限制：

1. journal 按 `sessionId` 隔离；跨 session 无法读取；
2. `scriptPath` 对应脚本内容必须保持一致，否则 cache identity 变化。

因此“旧聊天还在”“插件重新安装”“OpenSpec 没变”都不等于原生 Workflow cache 仍可用。

## 决定

新增第二层 **Semantic Artifact Cache**，形成三级恢复顺序：

```text
workflow <需求>
  ↓
Checkpoint Resolver
  ├─ same session + exact script hash → Runtime Resume
  ├─ fingerprint valid              → Artifact Restore
  └─ fingerprint invalid / absent   → Normal Flow
```

### Level 1：Runtime Resume

候选 state 的 `sessionId / runId / scriptPath / scriptSha1` 都有效时，主 agent 必须优先：

```js
Workflow({
  scriptPath: previous.scriptPath,
  resumeFromRunId: previous.runId,
  args: { ...首轮完整 args, ...本轮新增 args }
})
```

禁止重新 author 一份“逻辑相同”的脚本；哪怕只改一个字符也可能破坏原生 cache。

### Level 2：Artifact Restore

无法 native resume 时，从：

```text
docs/ultracode/state/<checkpoint>.json
```

恢复：

- `recon`
- `basePlan`
- `effectivePlan`
- `review`
- `decisions`
- `routing`
- 依赖 fingerprint

恢复前由 hook 用 SHA-256 重新计算：

1. 目标 OpenSpec change 下全部 Markdown；
2. BasePlan + EffectivePlan 涉及的 whitelist / slice files。

只有两者都未变化时，`checkpointValidation.valid=true`。

模板随后允许：

```text
Recon        ARTIFACT HIT
BasePlan     ARTIFACT HIT
DecisionApply JS
EffectivePlan ARTIFACT HIT（decisions 未变且旧 Review=approve）
Review       ARTIFACT HIT
```

因此跨 session、插件重装、脚本重新生成都不再强制支付昂贵 Plan/Review token。

### Level 3：Normal Flow

fingerprint 任一变化时不得盲目复用 Plan/Review。Resolver 会把 `changedPaths` 暴露给主 agent；当前版本回退正常 Recon/Plan，后续可继续做 selective invalidation。

## State Builder

`harvest-workflow.cjs` 固化 raw snapshot 后，调用 `checkpoint-lib.cjs` 构建语义 state。raw 仍是 append-only 历史，state 是“某个 checkpointKey 的最新可恢复状态”。

state key 默认：

```text
<changeDir>::<milestone>
```

模板允许用 `args.checkpointKey` 显式覆盖。

`SpecSync` 已成功时，state 中可复用 Plan 会清空 `openspecEdits`，防止下一轮把已经同步过的 Markdown edit 再执行一次；原 edit 另存到 `appliedOpenSpecEdits` 供审计。

## Backfill

State Builder 会扫描已有 `docs/ultracode/raw/wf_*.json` 尝试回填 v0.3 历史 run。只有能可靠恢复 OpenSpec `changeDir` 与 Plan 的 run 才生成 state；推不出来就跳过。

但 v0.3 raw 没有保存**生成当时的文件 fingerprint**，所以回填 state 一律标 `legacyUnverified=true`：不得把“今天计算的 hash”冒充历史基线。同 session 且旧脚本 hash 一致时仍可 native resume；否则先用 `haiku` CheckpointValidate 定向重读当前 OpenSpec 与历史 Plan 涉及代码，只有 `planStillValid/reviewStillValid` 通过才允许跳过昂贵 Plan/Review。

## 安全边界

- “聊天还在”不作为任何 cache 命中依据；
- fingerprint 不匹配时不能强制 artifact hit；
- `legacyUnverified` 不能直接 artifact hit，必须 native resume 或廉价 CheckpointValidate；
- 当前 route 高于历史 route 时，不复用历史 BasePlan；
- Review 只有在 decisions 未变、历史 `review.verdict=approve`、历史 route 不低于当前有效 route 时才复用；
- cache schema / template 语义不兼容时通过 `cacheVersion` 失效。

## 结果

OpenSpec-first 的长期 Plan IR 与 Ultracode 的计算缓存正式分层：

- OpenSpec：产品/架构规划的 source of truth；
- Runtime Resume：同 session 的计算缓存；
- Semantic State：跨 run / 跨 session 的 LLM 结果缓存；
- raw snapshot：不可变历史与遥测。
