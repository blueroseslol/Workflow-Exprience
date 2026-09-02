# 模型别名与 effort 本机实测

`workflow-authoring` 已负责通用 `model` / `effort` contract；本文件只记录本机别名映射、语料分工和实测偏差。

## 一、语料实证的分工

| Phase | 高频 model | 出现次数 | 职责 |
|---|---|---|---|
| Plan | `opus` | 13 | 根因分析 + 开发计划 |
| Review / Challenge | `fable` | 11 | 审计划、advisor、反驳 |
| Preflight | `haiku` | 8 | 装依赖、建目录、跑基线 |
| Implement | `sonnet` | 7 | 读码 + 实现 |
| Verify | `haiku` | 9 | 跑测试 + commit + GitNexus |

这是本机经验，不覆盖 `dynamic-routing.md` 的 HIGH/CRITICAL 路由。

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

从 CLI 二进制反查到的当前本机行为：

| 组合 | 实际发生的事 |
|---|---|
| `haiku` + `effort: 'max'` | **可能为空操作** —— 当前逻辑 `haiku` 路径会直接 return，effort 参数不一定发送给 provider |
| `sonnet` + `effort: 'xhigh'` | **静默降级为 high** —— denylist 含 sonnet-4-5 / 4-6 |
| `opus` + `effort: 'high'` | 生效 |
| `fable` + `effort: 'high'` | 生效（fable 的 capabilities 含 effort） |

当前 `haiku + max` 路径可能**无报错、无警告**：如果 CLI 在本机先把 effort 吞掉，provider 根本看不到这个参数，因此也不会触发下面的兼容重试。这和“provider 明确返回不支持某个 effort 等级”是两种情况，不能混为一谈。

语料佐证：46 个脚本里 `haiku + max` 出现 **0 次** —— 历史实践从未依赖它。

### Haiku 类型模型的 effort 兼容阶梯

当 `haiku` 别名被映射到第三方快速模型（例如 GLM-5.3-Flash），且本次 workflow **明确需要传 effort** 时，authoring / runner 按以下顺序尝试：

```text
max → xhigh → high
```

规则必须 fail-closed：

1. 首次使用 `max`。
2. **仅当 runtime / provider 明确返回“不支持该 effort / reasoning level / thinking capability”类错误**时，才改为 `xhigh` 重试。
3. `xhigh` 仍得到同类 capability 错误，再改为 `high`。
4. `high` 仍不支持时，**停止自动降级并提示用户**；让用户选择“省略 effort，使用该模型默认思考策略”或“换用支持 effort 的模型”。不得静默省略 effort，也不得擅自换模型。
5. `agent() === null`、超时、schema 不匹配、鉴权失败、限流、网络错误、普通 4xx/5xx **都不是** effort capability 证据，不得因此走这条降级链。

推荐在需要显式 effort 的模板里把它做成 args，而不是把某一级写死：

```js
const HAIKU_EFFORT = args?.haikuEffort ?? 'max'

const result = await agent(prompt, {
  model: 'haiku',
  effort: HAIKU_EFFORT,
  schema: SOME_SCHEMA,
})
```

若收到明确的 effort capability 错误，主 agent 保持其他 args 不变，只把 `haikuEffort` 依次改为 `xhigh`、`high` 后重跑；能同 session resume 时优先复用原 run。`effort` 进入 agent cache key，因此改变它会让该 Haiku agent 及其后续链路 cache miss，这是预期行为。

### 那「让 haiku 验得更严」怎么实现？

不要把 effort 当成唯一质量门。即使某个 provider 接受 `max/xhigh/high`，仍应使用本机取证型 schema：二元 verdict、退出码、测试计数、原始输出尾部、Preflight 基线对比。实例集中在 `schemas.md`，这里不重复 Workflow 的通用 schema contract。

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

通用 effort 取值与继承规则直接查 `workflow-authoring`；本文件只维护上述本机异常与第三方 Haiku 兼容策略。
