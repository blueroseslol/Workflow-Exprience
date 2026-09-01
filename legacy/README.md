# codex 深链接 → Ultracode 接力

把一条 codex 会话的上下文抽出来，交给 Ultracode 继续开发。

`legacy/` 下的两个脚本是这条链路的实现，**不参与 plugin 打包**（它们是独立能力，与 workflow 模板无关）。

---

## 实测数据

```bash
node legacy/codex-handoff.mjs "codex://threads/01a04367-d4df-7982-8007-60ff131fcd50" --out ./out
```

| 指标 | 实测 |
|---|---|
| 输入 | 195,112,770 B / 37,829 行 |
| 耗时 | **428 ms** |
| 输出 Markdown | 28,988 B |
| 跳过行 | 23,155（62%，占 90% 字节） |
| JSON 解析失败 | 0 |

性能来自一条设计：**90% 的字节从不 `JSON.parse`** —— `reasoning`、`custom_tool_call_output`、`item_completed` 的 CommandExecution 用行首 400 字符前缀判别直接丢弃。

---

## 输入格式

`codex://` scheme 是**纯装饰** —— 注册表 `HKCU\Software\Classes\codex` 只有 `URL Protocol`，没有 `shell\open\command`。所以输入层只用一条 UUID 正则：

```bash
node codex-handoff.mjs "codex://threads/<uuid>"     # 深链接
node codex-handoff.mjs "<uuid>"                     # 裸 uuid
node codex-handoff.mjs "帮我看看 <uuid> 那个线程"      # 含 uuid 的任意文本
node codex-handoff.mjs --grep "移除 figma mcp"        # 从 history.jsonl 反查
```

## 反查路径的四级兜底

1. `state_5.sqlite` 的 threads 表（`readOnly: true`，主键命中）
2. `fs.existsSync` 校验 —— **archive 会移动文件，DB 行会滞后**
3. 文件名 glob 扫 `sessions/` + `archived_sessions/`（实测 13ms）
4. `memories/rollout_summaries/*.md` 的 frontmatter

⚠️ SQLite 用 `mode=ro` 而**不是** `immutable=1`。后者是在向 SQLite 撒谎说文件不会变 —— 当 codex 正在写、`-wal` 有未 checkpoint 的页时，会跳过 WAL 直读主库，返回的可能是**结构上不一致的页**，而不只是"旧快照"。

---

## 抽取什么、丢弃什么

| 保留 | 用途 |
|---|---|
| `session_meta` | cwd / 模型 / CLI 版本 |
| `thread_goal_updated` | 线程目标 |
| `task_complete.last_agent_message` | 每轮成果摘要（**带 `file.ts:52` 行号引用**） |
| `message` role=user（非系统注入） | 用户原始指令 |
| 非零退出的命令签名 | **"试过什么不行"的唯一载体** |
| `compacted` | 标记历史缺口 |

| 丢弃 | 原因 |
|---|---|
| `reasoning` | 全是 `encrypted_content`，`summary: []`，**永久不可读** |
| `custom_tool_call_output` | 占字节大头，价值密度低 |
| `token_count` / `world_state` | 无接力价值 |

**失败签名段是意外收获**：469 次非零退出收敛成 137 个唯一签名，抓到自述里完全没有的东西 —— 索引损坏、路径拼接 bug（`D:\AI\Website\LDL_UGCbackend` 少个反斜杠）、pnpm 递归失败。

---

## 关键设计：数据流级分离

产物拆成两部分：

- **第 0–6 节：机器事实**（命令统计、文件列表、失败签名、git 状态）
- **第 7 节：agent 自述**（`last_agent_message`），在一条水平分割线之下

**第 7 节永不进入 Plan agent 的 prompt。** 它只在 Gate 阶段被当作**待证伪的假设**读一次。

原因：`last_agent_message` 是 GPT 的自述，可能声称完成了实际没做的事。

---

## 真实案例：一次抽取抓到的事

对 `01a04367` 线程的抽取结果：

```
git commit 调用次数 = 0
3799 次命令执行 · 361 个文件被改 · 跨 4 天 16 小时 · 68 轮
线程终态 paused，最后一轮 task_complete 消息为空（干到一半中断）
```

68 轮自述都在说"验证通过"，但**一次都没提交**。全部改动裸露在工作区，大量文件是 `??` 未跟踪。

这不是推断，是从 3799 条命令里数出来的。**任何接力都要先面对这棵树。**

---

## 接力前的验证闸门

`legacy/codex-relay.workflow.js` 的 Gate 阶段（haiku）做数字对数字的机械比对：

```js
const GATE_SCHEMA = {
  // claimTable 每条断言必须填四元组，不填过不了 StructuredOutput 校验
  claimTable: { type: 'array', items: { type: 'object',
    required: ['command', 'expected', 'actual', 'match'], ... } },
  claimsVerdict: { type: 'string', enum: ['trustworthy', 'partial', 'untrustworthy'] },
  zeroCommitRisk: { type: 'boolean' },
  workingTreeSafe: { type: 'boolean' },
}
```

三条门禁：
- `workingTreeSafe = false` → 直接 `return stopped`，报警
- `userDecisionsNeeded` 非空且无 decisions → `return`，问用户
- 一处 mismatch → `claimsVerdict` 整段降级

`zeroCommitRisk` 是**布尔量而非警告字符串**，沿三个阶段传播：Gate 检出 → Plan 收到"必须包含分批提交策略" → Verify 收到"只提交本切片"。一个警告字符串会被读过就忘；一个贯穿五个 prompt 的布尔量不会。

---

## 单向原则

**只读 `~/.codex`，绝不写。** 抽取器只用 `openSync` / `createReadStream`，SQLite 强制 `readOnly: true`。

唯一的官方写入路径是 `codex resume <uuid> "<prompt>"`，但那会消耗一次 codex 付费轮次 —— 只在用户明确要求时用。

反向通道走**仓库内的 handoff 文档**：接力完成后追加一段 `## 由 Claude Code 接手 · <ts>`，codex 下次 resume 读工作区时自然看到。零新技术、双向对称。

---

## 待你拍板

**Q1** Gate 跑不动的测试（缺权限那类）算什么？
- A. `not-run` 视同 mismatch，整段降级
- **B. 关键项 not-run 才降级，辅助项记 blocker 不降级 ← 推荐**（闸门要有区分度才有用）
- C. 不影响判定，只记录

**Q2 ★** 零提交工作树，接力前要不要先替 codex 做一次快照提交？
- A. 不提交，在悬空状态上继续（当前模板的行为）
- **B. Gate 通过后做一次 `chore: snapshot codex WIP before relay` ← 推荐**（把"不可逆"变回"可回滚"，代价只是一个不好看的 commit）
- C. 每次问用户

**Q3** Triage 阈值？
- A. 保持 10MB（当前）
- **B. 改成 `size≥10MB 或 turnCount≥15 或 跨度≥24h` ← 推荐**（单看大小会漏掉"轮次多但每轮短"的线程）

**Q4** 注册 `codex://` 成可点击？
- **A. 不注册 ← 推荐**（输入层已不依赖 scheme；注册会劫持 OpenAI 保留的 scheme，Desktop 装回就冲突）
