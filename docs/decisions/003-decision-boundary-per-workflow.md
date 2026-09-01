# ADR-003：拍板边界用「一个决议一个 workflow」，不用 resume 续跑

**日期**：2026-09-01
**状态**：已采纳（用户拍板 Q6=B）

## 背景

需求 7 原文：*"针对是否可以不需要拍板的里程碑、流程合并成一个 Ultracode？或者将整个 Stage 合并成一个 UltraCode，在需要拍板时暂停，等待用户输入之后拍板项回复 或者 选择 agent 给出的选项之后 继续开发。"*

技术上有两条路：
- **A**：整个 Stage 一个 workflow，拍板处早退，用户答复后 `resumeFromRunId` + 新 `args` 续跑
- **B**：一个决议边界一个 workflow，上一轮结论抄进下一个脚本的 `COMMON` 常量

## 决定

**采用 B。**

## 理由

A 的机制本身是干净的 —— `args` 不进缓存键，早退 `return` 不消耗 agent，"最长未变前缀"会命中。但有三个 blocker：

### 1. resume 是 same-session only（决定性）

journal 路径含 sessionId：
```
~/.claude/projects/<项目>/<sessionId>/subagents/workflows/<runId>/journal.jsonl
```

`/clear`、崩溃、跨天重启 → sessionId 变化 → 读不到 journal → **返回空缓存且不报错** → 静默全量重跑。

而"等用户拍板"恰恰是最容易跨会话的场景 —— 拍板往往隔了一夜。

**静默**是问题的核心。如果它报错，还能补救；它什么都不说，直接烧掉一整轮的钱。

### 2. 25 agent 警告线

实测语料：agent 数中位 4、p90 12、max 44。警告阈值是 25。

7 个里程碑 × 3-4 agent = **21-28**，开跑即越线。

### 3. 脚本一字节不能改

resume 要求脚本哈希稳定。但 `scriptPath` 的官方说明是"可用 Write/Edit 编辑后重跑"，极易手滑。

这也与 ADR-002 相关：如果将来想改模板，A 方案下所有进行中的 Stage 都会失效。

## 后果

- `templates/stage-with-gates.js` 采用 B：脚本顶部有 `COMMON.decided` 数组，写死已拍板事项
- 规划层 schema 强制输出 `decisionPoints`（带 `id` / `options` / `recommendation` / `evidence`），拍板点是结构化的而非散文
- 未决议时早退 `{ status: 'need-decision', decisionPoints, howToResume }`
- 主 agent 拿到后用 **AskUserQuestion** 问用户（脚本内无任何交互 API —— 沙箱注入的全局只有 11 个）
- 用户答复后，新建下一个里程碑的脚本，把结论抄进它的 `COMMON.decided`

## 代价

B 会重跑只读 recon agent（中位约 10 万 token/agent）。这是明知的成本。

换来的是避免：same-session 依赖、journal 静默失效、25-agent 警告线、脚本冻结 —— **四个风险换一次重跑**。

## 备注：A 仍可用于确定同会话的场景

如果确认在同一会话内、脚本不会改、agent 数不越线，A 的缓存命中率更高：

```js
Workflow({ scriptPath, resumeFromRunId: '<runId>', args: { decisions: { '5.4': 'B' } } })
```

因为 `args` 不进缓存键，把决议拼进里程碑 N 的 prompt 后，1..N-1 全部命中、N 及之后重跑 —— 正是想要的语义。

但这是**优化**，不是**主路径**。

> **2026-09-01 修订（见 ADR-005）**：上文「优化非主路径」仅适用于本 ADR 的场景——**等用户拍板**（常跨 session）。对**必然同 session 的自动续跑**（`route-escalation-required` / `replan-required`，主 agent 当场处理、不等用户），resume 已由 ADR-005 提升为主路径：三个 blocker 在该场景均不成立（同 session 确定、单 milestone 仅 4-8 agent 不越线、续跑不改脚本）。
