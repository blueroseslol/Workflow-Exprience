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

不要依赖无效 effort。使用本机取证型 schema：二元 verdict、退出码、测试计数、原始输出尾部、Preflight 基线对比。实例集中在 `schemas.md`，这里不重复 Workflow 的通用 schema contract。

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

通用 effort 取值与继承规则直接查 `workflow-authoring`；本文件只维护上述本机异常。
