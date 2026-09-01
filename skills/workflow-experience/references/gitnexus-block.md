# GitNexus 前置 / 后置检查块

**这是本机 hook 强制要求的流程**（`~/.claude/hooks/gitnexus/*.cjs` 会在 Edit/Write/Bash 前后注入提醒）。写 workflow 时把相应段落抄进 prompt，agent 才会照做。

> 标注：`[通用]` 适用任何已索引仓库；`[LDL_UGC]` 含项目特定的 repo 名与路径。

---

## 一、写在 Plan 层的前置块 `[通用]`

```
GitNexus 前置（Plan 层必做）：
1. list_repos 确认 repo 名。目录名 ≠ repo 名。
2. 对每个入口符号跑 context，拿到调用面。
3. 对每个入口符号跑 impact upstream maxDepth 3，评估爆炸半径。
4. 跨模块/API 改动额外跑 api_impact；响应结构改动跑 shape_check。
5. 索引时间戳落后于工作区时，必须在结论里标注「索引落后，本结果为下界」，
   不得把 LOW 当作「无影响」的证据。
GitNexus 不能替代源码阅读与 rg。三者结论冲突时以源码为准。
```

**为什么强调"不得当作无影响"**：`impact` 返回的 `epistemic` 字段可能是 `lower-bound` —— 意思是"确实存在本视图列不出的调用者"。把下界当全集是最常见的误读。

---

## 二、写在 Verify 层的后置块 `[通用]`

```
GitNexus 后置（Verify 层必做）：
1. detect_changes 检查本次改动的实际爆炸半径。
2. 对修改过的公共符号重新跑 context / impact，与 Plan 层的预估对比。
3. 预估之外的影响必须写进 scanFindings，不得静默。
```

---

## 三、何时需要重跑 analyze `[通用]`

hook 会在以下情况提醒：
- 本轮累计修改 ≥5 个文件
- API / Schema / 跨模块契约发生修改
- 涉及安全、鉴权、权限边界，或状态机、编排、复杂工作流

**提醒不等于必须立即执行**。判断标准是"功能是否已收口且通过测试"：
- 中间编辑状态 → 不跑，等里程碑完成
- 功能收口 + 测试全绿 → 跑

**另外两条固定触发点（不依赖 hook）**：

**规则 A —— 执行 ultracode 开发任务之前**：先检查索引新鲜度，**仅当 stale 才 analyze**，避免 `query` / `impact` 读到旧索引。普通刷新是机械更新，**不带 `--skills`**：

```bash
gitnexus analyze --verbose --skip-agents-md
```

**规则 B —— 当需要用户拍板时**：本轮流程最后添加一个 GitNexus 缓存重建任务，用 haiku 跑（带 `--embeddings` 让语义检索可用，早退后重跑 recon 直接命中新缓存）。**同样 freshness-gated**：若自上次索引以来 workspace 没有实际变化（如 Recon→Plan→need-decision 全程只读），跳过重建：

```bash
gitnexus analyze --embeddings --skills --verbose --skip-agents-md
```

命令（hook 提醒场景）：
```bash
gitnexus analyze --embeddings --skills --verbose --skip-agents-md
# 仅当需要 pdg_query / explain 的污点分析时加 --pdg
gitnexus analyze --embeddings --skills --pdg --verbose --skip-agents-md
```

⚠️ `--pdg` 显著增加耗时，**只在污点分析场景加**——规则 B 默认不带 `--pdg`。

---

## 四、hook 误报的处理 `[通用]`

本机 hook 是**启发式**的，会误报。常见误报：
- 只改了 `~/.claude/` 下的配置或脚本，没碰仓库代码
- 改动在未索引的目录（新建的、不在任何已索引 repo 下的）
- 命中"鉴权/状态机"关键词的是**文档文字**而非代码

**处理方式**：向用户说明为什么不适用，然后继续。不要为了"顺从 hook"去跑一次没有意义的 analyze（`--embeddings` 很慢）。

---

## 五、GitNexus 在 workflow 里的模型分配 `[通用]`

| 用途 | 模型 | 理由 |
|---|---|---|
| Plan 层的 context / impact 查询 | `opus` | 结论要进计划，需要判断力 |
| Verify 层的 detect_changes | `haiku` | 机械核对，比对预估与实际 |
| 独立的 analyze 重跑 | `haiku` | 纯执行 |
| ultracode 开发前的快速缓存刷新（规则 A，stale 才跑、不带 `--skills`） | `haiku` | 机械执行，刷新 FTS 索引 |
| 拍板时的缓存重建任务（规则 B，`--pdg` 仅污点场景加） | `haiku` | 机械执行，早退重跑直接命中新缓存 |

> **口径注记**：「全部使用 haiku」只限 GitNexus 缓存刷新 / 重建这类**机械任务本身**；不影响主链模型分配 —— Plan 仍是 `opus`、Review 仍是 `fable`、Implement 仍是 `sonnet`。

---

## 六、常见坑 `[LDL_UGC]`

- **repo 名**：本项目是 `ldl-ugc-backend`，不是 `LDL_UGC` / `backend` / 目录名。先 `list_repos`。
- **FTS/BM25 降级**：索引可能报 FTS 降级。此时 `query` 的语义检索质量下降，但 `impact` / `context` 的图遍历不受影响。降级状态**不能**作为"无影响"的证据。
- **索引损坏**：见过 `lbug.wal without lbug.shadow` 导致 `analyze` exit 1。处理：`gitnexus clean` 后重新 analyze。

---

## 七、可直接粘贴的完整片段

```js
const K_GITNEXUS_PRE = [
  'GitNexus 前置：',
  '- list_repos 确认 repo 名（目录名 ≠ repo 名）',
  '- 对入口符号跑 context 拿调用面',
  '- impact upstream maxDepth 3 评估爆炸半径',
  '- 跨模块/API 改动加跑 api_impact；响应结构改动加跑 shape_check',
  '- 索引落后须标注「本结果为下界」，不得把 LOW 当作无影响的证据',
  'GitNexus 不能替代源码阅读与 rg；结论冲突以源码为准。',
].join('\n')

const K_GITNEXUS_POST = [
  'GitNexus 后置：',
  '- detect_changes 检查实际爆炸半径',
  '- 对改过的公共符号重跑 context/impact，与 Plan 预估对比',
  '- 预估之外的影响写进 scanFindings，不得静默',
].join('\n')
```
