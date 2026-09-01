# 约束句式全表

按本机 46 个唯一 workflow 脚本体的命中率排序。**命中率高 ≠ 有效** —— 这些是历史习惯，不是经过检验的规范。

> 通用性标注：`[通用]` 可跨项目直接用；`[LDL_UGC]` 绑定 OpenSpec 移植上下文，其他项目需改写。

---

## 1. file:line 引用 — 33/46 脚本，106 次 `[通用]`

唯一横跨规划/审阅/实现/验证/调研全五类的约束。

```
每条结论必须引用你亲自 Read 到的 file:line，禁止凭摘要、记忆或他人转述。
```

变体（更严，用于规划层）：
```
必读（亲自 Read，禁止凭摘要）：
- <path> 中 <条款> 原文
GitNexus 索引落后时须标注，不得当作「无影响」。
```

**已知缺口**：语料只证明 26 个脚本「写了」这条约束，未证明 agent 「遵守了」。要验证需扫 `agent-*.json` 的实际返回值。

---

## 2. 白名单 / mustNotTouch — 21/46 脚本，78 次 `[通用]`

```
只允许修改 whitelist 内的文件；mustNotTouch 内的一律不动。越界即失败。
```

配套的 schema 字段：
```js
whitelist: { type: 'array', items: { type: 'string' } },
mustNotTouch: { type: 'array', items: { type: 'string' } },
```

**要点**：whitelist 必须精确到文件路径，不要写目录通配。凡不在 whitelist 的都要显式进 mustNotTouch —— 留空等于默许。

---

## 3. 改前 Read、改后 Read — 18/46 脚本，33 次 `[通用]`

```
改前先 Read 目标文件确认现状，改后再 Read 一次确认落盘符合预期。
```

**为什么改后还要 Read**：Edit 工具报错才说明失败，但「成功写入了错误的内容」不会报错。第二次 Read 是唯一的落盘校验。

---

## 4. 有证据才勾选 — 18/46 脚本，26 次 `[LDL_UGC]`

```
没有测试输出或命令退出码作证据，不得勾选任何 checkbox。只允许勾选本次交付的条目。
```

严格变体（指定哪些必须保持未勾选）：
```
只允许勾选 5.3。4.6/1.7/2.6/5.4/5.5 保持 [ ]。4.7/4.8/5.1/5.2 保持 [x]。
```

**跨项目改写**：把 checkbox 换成你的进度标记（issue 状态、TODO 注释、CHANGELOG 条目），核心是「状态变更必须有可复现的证据」。

---

## 5. git 安全 — 14/46 脚本，39 次 `[通用]`

```
禁止 git add . 与 git add -A，逐文件 add；feat 与 docs 分两笔提交；不 push。
```

**haiku 能否 commit**：能。用户已裁定（2026-09-01）。语料里存在相反口径的脚本（2 个写「haiku 禁止 commit」），那是早期写法，以本条为准。

配套 schema：
```js
commits: { type: 'array', items: { type: 'string' } },   // 记录实际 commit hash
```

---

## 6. fail-loud / 禁止伪造 — 17/46 脚本，41 次 `[通用]`

```
如实报告。测试失败就写失败并附原始输出，不得伪造成功、不得吞掉错误。
```

配套的**结构性**保障（比措辞可靠）：
```js
notImplemented: { type: 'array', items: { type: 'string' }, description: '计划里有但本轮没做的，必须诚实列出' },
honesty: { type: 'string', description: '有什么是你没验证的' },
```

required 里带上这两个字段，模型就必须正面回答「你漏了什么」，而不是靠一句劝诫。

---

## 7. 零网络 / 零 Provider — 10/46 脚本，14 次 `[LDL_UGC]`

```
不得调用付费 Provider、不得联网、不得写数据库。验收必须是离线可复现的证据。
```

**跨项目改写**：任何有外部副作用或计费的操作都适用（云 API、部署、邮件、支付沙箱）。

---

## 8. 已拍板决议不得回问 `[通用]`

```
用户已拍板（不得当成 blocker 再问）：
1) <决议一>
2) <决议二>
```

**为什么重要**：规划层 agent 缺省会把所有不确定项列进 openQuestions，导致 workflow 早退、用户被反复问同样的问题。把已定的事显式钉住，早退才有意义。

---

## 9. 分层职责边界 `[通用]`

| 层 | 允许 | 禁止 |
|---|---|---|
| Plan | Read、GitNexus 查询 | Edit / Write / commit |
| Review | Read | 任何写操作 |
| Preflight | 装依赖、建目录、跑基线 | 改业务代码 |
| Implement | Edit / Write（whitelist 内） | commit / push |
| Verify | 跑测试、逐文件 add、commit | push、改业务代码 |

写进 prompt 的措辞：
```
你是<层名>。<允许的事>。不要<禁止的事>（<负责该事的层>负责）。
```

---

## 10. 不信任上一层自述 `[通用]`

```
不要相信上一层的自述，自己跑一遍。
低于基线视为回退，status 填 red。
```

这条配合 Preflight 的基线数字才有意义 —— 没有基线就没有「回退」的定义。
