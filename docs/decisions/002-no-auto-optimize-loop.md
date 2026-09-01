# ADR-002：砍掉「hook 自动优化脚本与 skill」的闭环

**日期**：2026-09-01
**状态**：已采纳（用户拍板 Q7=砍）

## 背景

需求 2 原文：*"添加 Ultracode 完成 Hook，跑完之后自动固化脚本到项目目录的 ./docs/ultracode 中。并按照运行记录优化 Ultracode 脚本以及这个 skill 或者 plugin，起到不断迭代流程的功能。"*

前半（固化）已实现。后半（自动优化）砍掉。

## 决定

**保留固化，砍掉自动改写。** 改为人工触发的 `tools/scan-corpus.mjs` 分析工具。

## 理由

### 1. 与 resume 机制直接互斥（决定性）

Workflow 的 resume 缓存键是 `sha256(滚动链 ‖ prompt ‖ 归一化 opts)`。**脚本改动一个字节，从改动点起后面全部重跑。**

而"自动优化脚本"的字面含义就是改脚本。两者不能共存：
- 要么保留 resume 的复用能力，脚本就不能自动改
- 要么允许自动改，resume 就永远失效

拍板边界的方案（ADR-003）依赖脚本稳定性，所以选前者。

### 2. result 字段可以炸掉上下文

语料实测 `result` 字段长度：
- 中位 9,692 字符
- p90 55,439 字符
- **max 697,472 字符 ≈ 194k token**

要让模型"按运行记录优化"，就得把 result 喂进去。单个 run 就可能撑爆上下文。

### 3. hook 自改 skill = 无人复核的自改写

hook 对模型的唯一通道是 `additionalContext`（且 Stop 的 additionalContext 会额外起一整轮对话）。让 hook 自主修改 SKILL.md 或模板，意味着：
- 没有 diff 审查
- 没有测试
- 出错后下一次会话直接读到污染过的指导

这类自改写系统的失败模式是**渐进漂移** —— 每次改一点点，看起来都合理，几十次之后文档已经与现实脱节，且没有任何一次改动可以被指认为错误。

## 后果

- `harvest-workflow.cjs` 只做**纯文件搬运**：复制 `wf_*.json` + 追加 `index.jsonl`，不调用模型
- 它**不返回 `additionalContext`** —— 固化是静默的，人想看时自己读 `index.jsonl`
- 迭代改由 `tools/scan-corpus.mjs` 支持：按 token 倒序、按失败状态筛选，**产出给人看，由人决定改什么**

## 替代方案（未采纳）

- **降级为"hook 生成待办清单，人工执行"**：这是 A 加一层无收益的包装 —— 清单本身还是要人读、人判断，而 `scan-corpus.mjs` 已经做到了，且不占用 hook 预算。

## 迭代该怎么做

```bash
node tools/scan-corpus.mjs --failed      # 看非 completed 的 run
node tools/scan-corpus.mjs --top 5       # 看最贵的 run
```

然后 Read 这些 run 的 `journal.jsonl`，看它们停在哪个 phase。**反复失败的 phase 就是模板该改的地方。**

改完提交，git 历史就是迭代记录。
