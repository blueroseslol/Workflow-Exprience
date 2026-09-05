# Codex CLI 可选覆盖

默认策略：**不启用 Codex CLI**。现有 Review / Final Audit 继续使用逻辑别名 `fable`。只有用户在 `workflow ...` 需求里明确指定 Codex CLI 时，才切换对应阶段；不得自行启用。provider 映射是可变配置，不能在本文把 `fable` 固定等同于某个上游模型。

> **实现边界**：这是 **authoring-time override**，不是 `gitnexus-routed.js` 静态模板内置开关。用户点名 Codex 时，`workflow-experience` 必须在生成/复制本次 workflow 时把 Controller/CLI 阶段真正写进脚本；若没有插入对应调用，不得声称 Codex 已启用。

## 自然语言开关

主 agent / workflow skill 在 intake 时识别：

- `审阅使用 codex cli` / `review 使用 codex cli` → `codexReview=true`
- `审阅使用 codex cli，模型使用 gpt-5.6-sol` → `codexReview=true, codexModel='gpt-5.6-sol'`
- `修改代码使用 codex cli` / `让 codex cli 修复` → `codexFix=true`
- 未明确指定 → 保持 `codexReview=false, codexFix=false`，仍走默认 fable Review/Audit 与原实现模型

用户显式要求 Codex CLI 时视为 required：Codex 不可用、命令失败或输出不可解析时 **fail-closed**，不得静默改回 fable。

建议传入 workflow args：

```js
const CODEX_REVIEW = args?.codexReview ?? false
const CODEX_FIX = args?.codexFix ?? false
const CODEX_MODEL = args?.codexModel ?? 'gpt-5.6-sol'
const CODEX_SESSION_ID = args?.codexSessionId ?? null
const CODEX_MAX_ROUNDS = args?.codexMaxRounds ?? 3
```

这些开关只覆盖用户点名的阶段，不改变 Recon / Route / Planner / Preflight / Verify / GitNexus / Commit Gate。

## Review 覆盖

默认：

```text
Plan → Review(fable)
```

`codexReview=true` 时改为：

```text
Plan → haiku Codex Controller → Bash: codex exec → REVIEW_SCHEMA
```

Controller 只负责调用 Codex CLI、解析输出并映射现有 Review schema，不再额外调用 fable 做同一轮审阅。

首次只读审阅：

```bash
codex exec --json --sandbox read-only --ask-for-approval never --model gpt-5.6-sol - < .tmp/codex-plan-review.md > .tmp/codex-plan-review.jsonl 2> .tmp/codex-plan-review.err
```

要求 Codex 亲自读取仓库关键代码，优先找：错误假设、遗漏依赖、blast radius 低估、生命周期/并发、公共 API 兼容性、rollback、测试缺口、whitelist/mustNotTouch 错误。每个阻塞意见必须给 `file:line` / git diff / GitNexus / 测试证据之一，最终映射 `approve / revise / block`。

首次使用 `--json` 时保存 JSONL 中的 `thread_id`。Review=revise 后 Planner 重规划，优先续接同一线程：

```bash
codex exec resume <SESSION_ID> --json "继续审阅新版计划，逐条核对上一轮问题是否解决。"
```

把 `codexSessionId` 随 `nextArgs` 与 checkpoint 固化。并行 workflow 禁止依赖 `resume --last`，避免串会话。

## 实现后 Code Review

当 `codexReview=true` 时，在 **Commit Gate 前**增加 Codex Code Review。

工作区未提交：

```bash
codex exec review --uncommitted
```

按基线分支：

```bash
codex exec review --base master
```

若需要 OpenSpec / Plan / routeMiss 等自定义上下文，改用普通只读 `codex exec` + stdin prompt，让 Codex 自己读取 `git diff` 和 changed files。

有证据的 correctness blocker → `needs-rework` / `replan-required`，禁止 commit。纯 style、命名偏好、无证据猜测不能单独阻塞。

## Codex 修改代码

只有 `codexFix=true` 才允许 Codex 写工作区：

```bash
codex exec --json --sandbox workspace-write --ask-for-approval never --model gpt-5.6-sol - < .tmp/codex-fix.md > .tmp/codex-fix.jsonl 2> .tmp/codex-fix.err
```

要求：保持修改范围最小，遵守 OpenSpec 与 whitelist，不 commit、不 push；输出修改文件、原因、验证结果和剩余风险。

之后必须回到原 Ultracode 链：

```text
Codex Fix → Verify → GitNexus actual impact → routeMiss → Audit → Commit Gate
```

严禁根据 Codex 自述“已修复”直接 green。

`codexFix=true` 不自动表示 Review 也切 Codex；只有用户同时明确要求审阅使用 Codex CLI 时才设置 `codexReview=true`。

## Final Audit

默认仍使用 `fable`。仅 `codexReview=true` 时，CRITICAL / routeMiss 的 Final Audit 改用 Codex CLI；优先复用 `codexSessionId`，要求重新查看最终 `git diff`、changed files、关键 caller/callee、OpenSpec、测试与 routeMiss 证据，输出 `accept / needs-rework / escalate-to-human`。

## 命令纪律

正确形式：

```bash
codex exec --sandbox read-only --model gpt-5.6-sol "..."
codex exec --sandbox workspace-write --model gpt-5.6-sol "..."
```

`--sandbox` 后直接跟 `read-only` / `workspace-write`；模型参数是 `--model`。长 prompt 优先 stdin `-` + 文件重定向。

Codex CLI 没有通用 `reviewer` 角色参数；`default / worker / explorer` 是内部 subagent 角色概念，不是 `codex exec review` 的角色选择参数。

## 超时与外部 watchdog（必做）

Codex CLI 存在已知 automation hang 场景：Git 命令失败后 `codex exec review` 可能迟迟不产生 terminal event（截至 2026-09-01 官方仓库仍有未关闭报告）。fail-closed 只能处理「命令返回了失败」，处理不了「命令永远不返回」——**Controller 必须给每次 Codex 调用套外部超时/watchdog，不得裸等 CLI 自己退出**。

```js
const CODEX_TIMEOUT_MS = args?.codexTimeoutMs ?? 600000  // 默认 10 分钟（与 Bash 工具上限一致）；大仓库 review 可调大
```

1. 每次 `codex exec`（含 `review` / `resume` / fix）都必须带外部超时：Bash 工具 timeout 参数或 Controller 侧 watchdog 计时，二者至少其一。
2. **超时即失败**（fail-closed 的一种）：杀掉进程，读取已落盘的 JSONL 尾部与 stderr 做诊断，状态记 `codex-timeout` 并把诊断写进 result。不得因超时静默改回 fable——用户显式要求 Codex 时 Codex 是 required。
3. 区分「超时强杀」与「正常非零退出」：前者按 hang 嫌疑上报（附已捕获的部分输出），后者看 stderr/JSONL 解析失败原因；两者的诊断信息都必须进 result，不得吞掉。
4. 可选增强：`--json` 模式下 watchdog 同时监视输出文件停滞——JSONL 长时间无新行即可提前判定 hang，不必等满整个超时。

## 最终原则

```text
默认：fable Review / Audit
用户明确“审阅使用 Codex CLI”：只覆盖 Review / Code Review / Audit
用户明确“修改使用 Codex CLI”：只覆盖实现/修复动作
未点名的阶段保持原动态路由
```

Codex 与 Planner 冲突时，以源码、OpenSpec、GitNexus、git diff 和真实测试证据裁决，不按模型名投票。
