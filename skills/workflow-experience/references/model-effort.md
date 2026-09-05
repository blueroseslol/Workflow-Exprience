# 模型别名与 effort 适配

`workflow-authoring` 负责通用 `model` / `effort` contract；本文件记录逻辑别名、可变 provider 映射和插件覆盖语义。

## 一、逻辑角色

| Phase | 默认 model | 默认 effort | 职责 |
|---|---|---|---|
| Recon | `haiku` | 省略 | 代码/OpenSpec/GitNexus 事实采集 |
| Plan | `sonnet` / `opus` | `high` | 常规规划 / 架构升级 |
| Review / Advisor / Audit | `fable` | `high` | 对抗审阅与裁决 |
| Implement | `sonnet` / `opus` | `xhigh` | 常规实现 / CRITICAL 或不收敛升级 |
| Preflight / Verify / Commit | `haiku` | 省略 | 基线、测试、证据和提交 |

逻辑别名是 workflow 的稳定接口。CC Switch 可以让 `opus` 与 `sonnet` 指向同一个 GPT-5.6 Sol 上游；二者仍保留独立角色、独立用户 effort 覆盖和独立缓存身份。风险升级到 `opus` 代表执行角色与请求参数升级，不能在无路由证据时描述成“已换成更强上游模型”。

`fable` 可映射 GPT-6 Astra，`haiku` 可映射 GPT-5.6 Terra 或 Luna。映射会随 provider 改变，当前 settings 只是 configured，代理请求日志才是 observed；历史请求不能证明新配置已经生效。

## 二、用户覆盖契约

自然语言由外层 authoring 代理解释，模板接收结构化 args：

```js
args.modelEfforts = { opus: 'max', sonnet: 'high' }
args.phaseEfforts = { Implement: 'high', Review: 'xhigh', Advisor: 'max' }
```

允许值为 `low`、`medium`、`high`、`xhigh`、`max` 和 `null`。解析顺序：

1. `phaseEfforts` 中对应阶段或角色；
2. `modelEfforts` 中最终逻辑模型别名；
3. 调用点原默认 effort，原来省略的继续省略。

`null` 表示恢复调用点默认，不会作为字符串传给 provider。未知逻辑别名、未知阶段和非法 effort 在第一次 agent 派发前报错。`Review`、`Advisor`、`Audit` 是三个独立键。

Opus/Sonnet 即使同指向 Sol，`modelEfforts.opus` 也不能影响 Sonnet。若用户只说“Sol 用 max”而任务中多个别名都指向 Sol，authoring 应结合明确阶段解释；仍有实质歧义时询问用户，不能猜一个别名。

## 三、恢复与缓存

checkpoint 保存 `modelEfforts` 和 `phaseEfforts`。续跑按以下顺序分别按 key 合并，后者优先：

```text
state.resumeArgs → state.continuationArgs → 本轮新 args
```

显式 `null` 必须保留。提高 Recon 或 Plan effort 会让对应历史 artifact 失效；提高 Review effort 会改变 Review 输入并强制重审，但未变更的 BasePlan 仍可复用。改变 effort 也可能导致原生 agent cache miss，具体范围以 runtime 实测为准。

wrapper 为每次调用记录逻辑模型、phase、role、`requestedEffort` 和来源。`requestedEffort` 只表示传给 Workflow runtime 的值；除非本次链路有反代日志证据，否则 `actualModel` 与 `effectiveEffort` 必须写 `unknown`。

## 四、兼容与失败边界

本机 Claude Code 2.1.260 的 `--help` 列出 `low/medium/high/xhigh/max`。这证明客户端接口接受这些枚举，不证明每个逻辑别名、provider 或上游模型都实际执行该强度。

不得通过替换成虚构模型 ID、改 Claude 全局配置或改 cc-switch 数据库来绕过能力判断。只有 runtime/provider 明确返回 effort/reasoning capability 不支持错误时，才能按用户已授权策略改变 effort；`agent() === null`、超时、schema、鉴权、限流、网络和普通 4xx/5xx 都不是能力证据。

严格验证仍依赖 schema、file:line、命令退出码、测试计数与原始输出。effort 不是唯一质量门。

## 五、Haiku 上下文失败恢复（兼容保留）

Workflow DSL 的 `agent()` 在终端失败时只向脚本返回 `null`。Stop/harvest 从终态 `workflowProgress[].error`、logs 和根错误精确识别 `Prompt is too long`、自动压缩失败、空摘要、context length 与 input token 超限签名。

只有失败代理属于现有 Haiku lane 且 run 未成功时，才 `decision:block` 一次，并建议用原 `scriptPath + resumeFromRunId` 把失败 phase 临时切到 `sonnet`。恢复前检查工作区、测试和最近提交，避免重复副作用。普通 `null` 不触发自动恢复。本轮不新增 Terra 特判或大上下文压力测试。

支持的模型恢复参数为：

```js
args.reconModel
args.preflightModel
args.verifyModel
args.commitModel
```

模型恢复与 effort 覆盖是两条独立机制；恢复时两张 effort map 仍须按 key 合并。

## 六、Advisor 模型

```js
const ADVISOR_MODEL = args?.advisorModel ?? 'fable'
```

Advisor 的价值来自独立复核代码和证据，不能仅凭别名不同宣称具有独立模型视角。涉及架构决策、跨模块影响，或顾问连续给出模糊裁决时，仍可按原路由切换 `opus`。改变 Advisor 模型或 effort 会使该调用及必要下游缓存失效。
