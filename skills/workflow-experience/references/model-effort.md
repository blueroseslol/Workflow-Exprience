# 模型分工与 effort 门控真相

## 一、语料实证的分工

| Phase | 高频 model | 出现次数 | 职责 |
|---|---|---|---|
| Plan | `opus` | 13 | 根因分析 + 开发计划 |
| Review / Challenge | `fable` | 11 | 审计划、advisor、反驳 |
| Preflight | `haiku` | 8 | 装依赖、建目录、跑基线 |
| Implement | `sonnet` | 7 | 读码 + 实现 |
| Verify | `haiku` | 9 | 跑测试 + commit + GitNexus |

**这是默认建议，不是硬规则。** 官方指引明写 *when unsure, omit model* —— 省略时继承会话模型，通常就是对的。

## 二、本机别名映射（重要）

`~/.claude/settings.json` 的 env 段把模型别名指向了第三方模型：

| 别名 | 实际模型 |
|---|---|
| `opus` | `claude-opus-5[1m]` |
| `sonnet` | `kimi-k3[1m]` |
| `haiku` | `deepseek-v4-flash[1m]` |
| `fable` | `gpt-5.6-sol[1m]` |

全部经 `ANTHROPIC_BASE_URL=http://127.0.0.1:15721` 代理。

**后果**：任何基于「Anthropic 原生模型行为」的假设（包括下面的 effort 门控）在本机都需要重新验证。写模板时用别名而非全 ID，切换 provider 时才不用改脚本。

## 三、effort 门控真相 ⚠️

从 CLI 二进制反查到的行为：

| 组合 | 实际发生的事 |
|---|---|
| `haiku` + `effort: 'max'` | **空操作** —— 对 haiku 直接 return，effort 参数根本不发送 |
| `sonnet` + `effort: 'xhigh'` | **静默降级为 high** —— denylist 含 sonnet-4-5 / 4-6 |
| `opus` + `effort: 'high'` | 生效 |
| `fable` + `effort: 'high'` | 生效（fable 的 capabilities 含 effort） |

**全程无报错、无警告。** 你写了 `effort: 'max'`，UI 上看不出任何异常，但那个参数从未离开过本机。

语料佐证：46 个脚本里 `haiku + max` 出现 **0 次** —— 历史实践从未依赖它。

### 那「让 haiku 验得更严」怎么实现？

**用 schema 施压，不用 effort。**

```js
// ❌ 无效：参数根本不发送
agent(prompt, { model: 'haiku', effort: 'max' })

// ✅ 有效：required 字段强迫它必须去取证
const VERIFY_SCHEMA = {
  type: 'object',
  required: ['status', 'vitestTail', 'testTotal', 'testPassed', 'testFailed', 'typecheckSrcExit'],
  properties: {
    status: { type: 'string', enum: ['green', 'red'] },        // 二元枚举，不给「基本通过」的余地
    vitestTail: { type: 'string', description: 'vitest 真实尾部输出' },  // 要原始输出
    testTotal: { type: 'number' }, testPassed: { type: 'number' }, testFailed: { type: 'number' },
    typecheckSrcExit: { type: 'number' },                       // 要退出码
  },
}
agent(prompt, { model: 'haiku', schema: VERIFY_SCHEMA })
```

**原理**：schema 校验发生在工具调用层，字段缺失或类型不符会让模型**重试**。要一个数字和一段原始输出，比要一个布尔值难伪造得多 —— 它必须真的去跑那条命令。

三个设计要点：
1. **enum 收紧** —— `['green','red']` 而非自由字符串，堵掉「大部分通过」这种模糊回答。
2. **取证字段** —— 退出码、测试计数、输出尾巴。都是可被人事后复核的硬数据。
3. **基线对比** —— `baselineDelta` 字段配合 Preflight 的基线数字，让「覆盖面缩水」也能被发现（全绿但测试数变少 = 回退）。

### 如果确实需要 sonnet 的 xhigh

两条路：
- 在 `agent()` 里写全模型 ID（如 `claude-sonnet-5`）绕开别名 denylist；
- 或设 `ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-5`。

但本机 `sonnet` 别名指向 `kimi-k3`，写全 ID 等于**换了个模型**，不只是换 effort。权衡清楚再改。

## 四、advisor 的模型选择

```js
const ADVISOR_MODEL = args?.advisorModel ?? 'fable'   // 默认 fable，传 'opus' 切换
```

**fable 作默认的理由**：advisor 的职责是反驳而非附和，需要的是不同的视角，而不是更强的算力。用与主链相同的模型做 advisor，容易得到同质化的认可。

**什么时候切 opus**：涉及架构决策、跨模块影响分析、或 fable 连续两次给出模糊裁决时。

⚠️ **advisor agent 必须放调用链尾部或拆成独立 workflow** —— `model` 进缓存键，切换 `advisorModel` 会让该 agent **及其后所有 agent** 重跑。

## 五、effort 取值参考

| 值 | 何时用 |
|---|---|
| 省略 | 默认。继承会话 effort |
| `'low'` | 机械性阶段（文件搬运、格式化） |
| `'high'` | Plan / Review —— 需要推理但有明确输入 |
| `'xhigh'` | 复杂实现、大范围调研（注意 sonnet 上会降级） |
| `'max'` | 目前无可靠用例。haiku 上是空操作 |
