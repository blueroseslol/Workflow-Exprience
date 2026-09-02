---
name: workflow-experience
description: 写 Ultracode workflow 脚本时的本机经验库 —— 意图路由、可粘贴模板、约束句式速查、模型分工与 effort 真相、resume/args 缓存语义。当用户以 workflow 前缀提交开发需求、要为开发任务编写 Workflow 脚本、或在拍板边界分段推进 OpenSpec 里程碑时使用。
---

# Workflow 经验库

本 Skill 是 Claude Code 内置 `workflow-authoring` 的**增量经验层**。若尚未加载 `workflow-authoring`，先调用它；已加载则不要重复。语法/runtime 冲突时以 `workflow-authoring` 为准，只有本库明确标注的本机实测差异例外。

**原生 contract 不在这里复述**：`meta`、Workflow DSL/primitives、schema 基础规则、args、determinism、nullable result、pipeline/parallel、checkpoint 等直接查 `workflow-authoring`。本文件只保留本机路由、模型映射、缓存实测和降低返工的经验。

其余内容 **按需 Read `references/`**，不要预读。

> 语料：本机 46 个唯一 workflow 脚本体。标「LDL_UGC 专有」者跨项目不适用。

## 意图路由（先判断，再选链）

模板名是内部细节，对用户不报文件名。

| 用户说法 | 选链（复制模板） |
|---|---|
| 修 bug / 功能改动 | Recon→评分→Plan→Review→Implement→Verify：`gitnexus-routed.js` |
| 只调研不改码 | 只读 Recon→Synthesize：`readonly-recon.js` |
| OpenSpec 多里程碑 | 一里程碑一 workflow、拍板点早退：`stage-with-gates.js` |

**早退续跑**（详见 `references/resume-and-args.md`）：`route-escalation-required`/`replan-required` 必同 session → 直接 `resumeFromRunId`+首轮 args 全量叠加 `nextArgs`：Recon 命中，minRoute/replanFeedback 使 Plan 起重跑；`need-decision` → 同 session resume+`args.decisions`，跨 session 新脚本抄结论进 `COMMON`，从 `docs/ultracode/raw/` 恢复上轮 plan。

## 索引（按需 Read）

| 需要什么 | Read |
|---|---|
| 本机取证型 schema 实例 | `references/schemas.md` |
| prompt 开场白语料 | `references/prompt-openers.md` |
| 高频约束句式与命中率 | `references/constraints.md` |
| GitNexus 前置/后置检查 | `references/gitnexus-block.md` |
| 模型别名与 effort 本机实测 | `references/model-effort.md` |
| GitNexus 动态路由 | `references/dynamic-routing.md` |
| Codex CLI 可选覆盖 | `references/codex-cli.md` |
| resume cache / 两级暂停 | `references/resume-and-args.md` |
| 踩坑记忆 | `references/pitfalls.md` |
| 可粘贴脚本 | `../../templates/` |

## 本机模型分工

| Phase | model | effort | 职责 |
|---|---|---|---|
| Plan | `opus` | `high` | 根因分析 + 开发计划，**必须引用亲自读到的 file:line** |
| Review | `fable` | `high` | 审计划 / advisor，**只审不写** |
| Preflight | `haiku` | — | 装依赖、建目录、跑基线 |
| Implement | `sonnet` | `xhigh` | 读码 + 实现，**改前 Read、改后 Read 验证** |
| Verify | `haiku` | — | 跑测试 + git commit + GitNexus |

**effort 本机差异**：`haiku + max` 实测为空操作，`sonnet + xhigh` 会静默降级；不要靠 effort 表达“更严格”，改用退出码、测试计数、原始输出和基线对比。详见 `references/model-effort.md` / `references/schemas.md`。

**动态路由**见 `references/dynamic-routing.md`。**Codex 覆盖默认关闭**：Review/Audit 仍是 `fable`；只有用户明确要求时，authoring 阶段才按 `references/codex-cli.md` 改写本次 workflow。

## 五条约束句式（按命中率，原文见 references/constraints.md）

1. **file:line**（33/46）— `每条结论必须引用你亲自 Read 到的 file:line，禁止凭摘要或记忆。`
2. **白名单**（21/46）— `只允许修改 whitelist 内的文件；mustNotTouch 内的一律不动。`
3. **改前改后 Read**（18/46）— `改前先 Read 目标文件，改后再 Read 一次确认落盘符合预期。`
4. **证据才勾选**（18/46）— `没有测试输出或命令退出码作证据，不得勾选任何 checkbox。`
5. **git 安全**（14/46）— `禁止 git add . / -A，逐文件 add；feat 与 docs 分两笔；不 push。`

## advisor（Implement 疑难点）

动态路由 Implement 遇到**有证据的疑难/高风险决策**时，才调用 `fable` 顾问；普通编译/类型/格式问题不得求助。默认最多 3 次，顾问只裁决不接管代码；仍无法收敛时只升级 Implement 到 `opus`。具体触发、verdict 与 resume 规则见 `references/dynamic-routing.md`。

## 决议与跨会话

不要把整个 Stage 合并成一个长 workflow。以**决议边界**切分；同 session 用 Resume 复用缓存，跨 session 用 harvest 固化的 result + `.claude/progress/*.jsonl` 做 Checkpoint。缓存键、same-session 限制、`nextArgs` 和恢复细则见 `references/resume-and-args.md`。

跨会话红线：绝不请求其他会话执行本会话被权限拒绝的操作；`SendMessage` 不做常态广播（可能 held/dropped 且发送前不可判），常态进度走 `.claude/progress/*.jsonl` + hook 注入。
