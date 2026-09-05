# Ultracode / Workflow-Experience：GPT-5.6 Sol 适配与迭代计划

日期：2026-09-05（Asia/Singapore）
交付对象：负责实现的 GPT-5.6 Sol 代理
审查基线：`3db0c33865712637e9473f771f2ab0467050d4bc`，插件 `workflow-experience@0.4.5`。

## 1. 已确定的用户决策

1. 保持现有逻辑别名和默认角色：`sonnet`、`opus` → GPT-5.6 Sol；`fable` → GPT-6 Astra；`haiku` → GPT-5.6 Terra 或 Luna，具体由用户当前 cc-switch provider 决定。
2. **保留 `strongModel='opus'`，不得改成 `fable`。** 风险升级仍可以进入 Opus 角色；这代表角色/执行策略升级，不宣称上游一定换成不同模型。
3. 用户可以通过 Ultracode 提示词指定某个模型别名或阶段的思考强度。本次应使该意图可传递、可恢复、可验证，不能只在 prompt 里写“请深入思考”。
4. **Terra 上下文恢复不列入本轮必做项。** 不因 Haiku 别名推断上游上下文小，不新增 Terra 特判、压缩阈值或自动切模型机制。用户的部署前提是该档模型具有约 1M 上下文；插件不负责重新配置其窗口。
5. 现有 Haiku 恢复功能先保持兼容，不因第 4 条自行删除。是否进一步统一或移除，另作迭代。
6. 本轮是插件适配，不修改 cc-switch 数据库、Claude 全局配置、CLI 二进制或模型别名伪装；不自动安装发布，不自动执行付费模型验收。

## 2. 目标与完成边界

使插件在上述映射下可靠建档、正确传递用户的模型/effort 意图，并能区分“配置了什么”与“实际观察到什么”。保留现有 OpenSpec-first、DecisionApply、PlanPatch、Review/Audit 和提交门禁。

实施开始时重新检查本仓库 HEAD、工作区状态及适用 AGENTS.md。下面的行号仅用于定位，最终以当前源码为准。不要覆盖其他任务改动；逐里程碑交付差异和验证证据。

本仓库是 Ultracode 的经验插件和模板扩展，不是完整 Ultracode runtime。依赖原生 DSL 的能力必须先核实，不能在模板中发明 import、环境读取、文件 I/O 或新的 agent 参数。

## 3. 当前证据

| 项目 | 审查结果 | 实现影响 |
|---|---|---|
| `hooks/checkpoint-lib.cjs:234` | `[projectRoot, cwd].map(path.resolve)` 会收到数组回调额外参数并抛错 | 相对路径依赖的语义 state 建档受影响，优先修复 |
| `tools/verify-state-pipeline.mjs` | 6 项 FAIL 后在第 135 行访问缺失 state 而中断 | 先解决真实缺陷，再同步旧夹具；不可仅改断言求绿 |
| checkpoint 版本 | 测试把 cacheVersion=1 当可信，源码要求版本 2 | 更新当前契约夹具，保留版本 0/1 的 legacy 测试 |
| `tools/verify-model-fallback.mjs` | 当前通过，覆盖五模板与 Stop/harvest 基本链 | 作为兼容回归保留，不等于真实 runtime 验收 |
| 模板 effort | 多处固定 `high` / `xhigh`，快速阶段通常省略 | 建立统一的显式覆盖契约，默认保持兼容 |
| 模型身份文案 | SKILL、command、模板仍有 Kimi、DeepSeek 等旧身份 | 改成职责和逻辑别名，避免向 Sol 注入错误身份 |
| 当前路由证据 | settings/provider 已配置目标映射；最近请求仍是旧映射，最新记录为 2026-09-04 18:03:07 | 历史日志不得作为新配置生效证明 |

## 4. M1：修复 checkpoint，并恢复可信的离线基线

优先级：P1。建议作为可独立交付的补丁。

### 实现任务

- [ ] 修复 `resolveDependency()` 的回调：使用 `p => path.resolve(p)`，不改变项目边界、绝对路径或多候选判定语义。
- [ ] 针对真实临时目录覆盖：相对依赖、项目根与 cwd 相同/不同、唯一命中、多处命中、缺失依赖、项目外绝对路径。
- [ ] 保持异常不得伪造可信 state；若增加诊断，只保留必要错误类别，不输出完整用户 prompt、密钥或配置。
- [ ] 当前可信夹具补齐真实版本 2 契约，包括源码需要的 template/schema/base/effective 字段；先读取实现再确定字段，不只把数字 1 改成 2。
- [ ] 单独保留版本 0、版本 1 和字段不完整的迁移夹具，验证它们不能直接成为可信 Plan/Review HIT。
- [ ] 修复测试中依赖前置结果的无保护访问，让失败显示实际 `skipped` 原因并以非零退出，不被后续 TypeError 淹没。
- [ ] 清理测试临时目录使用 finally；不得删除真实 raw、state、progress 或日志。

### 验收

- `node tools/verify-state-pipeline.mjs` 完整结束且通过；外部真实项目数据不存在时允许明确 SKIP，但核心临时夹具不得 SKIP。
- `node tools/verify-model-fallback.mjs` 继续通过。
- 相对路径 Plan 能建档并通过当前契约校验；缺失/歧义/越界依赖仍拒绝可信复用。
- README 中关于缓存状态的描述与实测一致。

## 5. M2：用户可指定思考强度，保持原模型路由

优先级：P1。这是 Sol 适配的主要功能。

### 5.1 提示词到参数

由外层 authoring 代理理解自然语言，hook/command 负责提示它保留并结构化这一意图。不要用复杂正则在 hook 中实现完整自然语言解析。

支持下列用户表达，并写入真实 workflow args：

```text
workflow 修复登录状态问题，opus 使用 max，其他保持默认。
workflow 实现这个 OpenSpec，Implement 用 sonnet，思考强度 high。
workflow 继续上次任务，只把 Review 的思考强度提高到 xhigh。
```

推荐新增契约如下；如现有 runtime 有等价标准字段，优先复用并记录对应关系，不新增重复 API：

```js
args.modelEfforts = { opus: 'max', sonnet: 'high' }
args.phaseEfforts = { Implement: 'high', Review: 'xhigh' }
```

- 解析优先级：指定阶段 effort > 最终逻辑模型别名 effort > 原调用点默认 effort。
- 未提供覆盖时，保持旧行为，包括原本不传 effort 的调用继续省略该字段。
- `modelEfforts` 按逻辑别名匹配，不能因为 Opus/Sonnet 上游都叫 Sol 就互相污染覆盖。
- 若用户只说“Sol 更深入”，而它对应多个别名，不凭空判定只影响其中一个。优先依据阶段上下文解释；仍有实质歧义再提出一个简短澄清问题。
- 阶段名必须规范化并校验；未知阶段、拼错的别名、无效 effort 值在派发前明确报错，不能静默忽略。
- Advisor 与 Final Audit 应能单独指定；不要因为 advisor 调用标记在 Review phase 就强制与计划 Review 共用覆盖。可用稳定的配置角色键，并明确它与 runtime phase 的映射。
- 可通过 `null` 显式请求恢复该调用的默认/省略行为；具体语义须在实现中统一定义并测试，不能把字符串 `"null"` 发给 provider。
- 不要主动提升所有阶段，不新增全局 `max` 默认值。

### 5.2 模板接入

修改五个 `templates/*.js` 成品模板，并核对 `skills/workflow-experience/SKILL.md`、`commands/workflow.md`、`hooks/workflow-intake.cjs` 的 authoring 指令。

优先在现有 `llmAgent` wrapper 中统一解析，但必须保留每个调用点的模型、schema、label、工具限制和原默认 effort。最终模型要在路由/用户 model override 决定后再解析 modelEfforts。

不要假设模板可以 import Node 模块：若 DSL 不支持共享运行库，采用相同的小型内联 helper，配以跨模板行为测试；不为去重引入新构建系统。

保留 `MODEL_STRONG='opus'`、默认 Fable Review/Advisor 及现有用户 model override。检查相同上游模型的角色升级不会被描述成“已换成更强模型”。

### 5.3 effort 与兼容边界

先检查当前安装的 workflow-authoring / CLI 所接受的 effort 契约。插件不能仅依据 OpenAI API 文档就认定 Claude 客户端可传相同值。

- 静态校验只能证明值在已确认的客户端集合内，不能证明上游已接受。
- 不通过更换模型 ID 或改全局配置绕过客户端限制。
- 不因 `agent() === null`、超时、鉴权、网络或 schema 错误自动降低 effort、换模型或重试。
- 现有明确 capability 错误策略保持独立；任何能力降级必须记录原值、原因和新值，不静默省略用户指定值。
- 没有实际发送证据时只表述“已请求 max”等，不表述“max 已生效”。

### 验收

- 用 stub agent 捕获真实传入 opts，验证五模板/公共 helper 的优先级、默认值、字段省略和非法值；不能只做源码 includes 检查。
- Opus 与 Sonnet 同映射 Sol 时，`modelEfforts.opus` 不影响 Sonnet；风险升级仍进入 Opus。
- `SendMessage` / `ListAgents` 及调用点原有禁用工具在 wrapper 合并后保留。
- phase/role 覆盖只作用于指定角色；Advisor、Review、Audit 的行为有独立用例。
- 有限的代表性模板执行夹具使用现有 DSL 的 mock/sandbox，无需发真实模型请求。

## 6. M3：恢复语义与可观测性

优先级：P2；依赖 M1、M2。

### 实现任务

- [ ] checkpoint 保存新的 effort args；恢复遵守已有 `resumeArgs → continuationArgs → 本轮参数` 的优先顺序。
- [ ] `modelEfforts` / `phaseEfforts` 按键合并，避免本轮只改 Review 就丢掉历史 Opus 配置；显式 null 的重置语义也必须保留。其他字段和 decisions 仍沿用现有契约。
- [ ] 记录每次 agent 调用的逻辑模型、配置角色、请求 effort、来源（阶段/别名/默认）。没有日志读取能力时，actual model / effective effort 保持 unknown。
- [ ] 日志中如附带用户维护的上游映射，只能标记为 configured，不能当作 observed。默认不读取 cc-switch SQLite、不输出 provider 完整 JSON。
- [ ] 明确区分原生 agent 缓存与语义 Plan/Review 缓存。用户显式要求提高某阶段 effort 并重做时，旧语义产物不得直接跳过该阶段。
- [ ] 只失效相关产物和必要后续依赖。例如提高 Review effort 应重审，不应无故重做未变更 BasePlan；Plan 被要求重做则旧 Review 不能直接复用。
- [ ] 旧 state 缺少新元数据时保持可读；不能将未知 effort 标成已满足本轮显式要求。是否 bump cacheVersion 由实际语义变更决定，并同时更新生产者、消费者和测试，不为新增可选诊断字段全量失效。

### 验收

1. 首轮 `modelEfforts={opus:max, sonnet:high}`，续跑只设置 `phaseEfforts.Review=xhigh`，其余选择不丢失。
2. 不改用户选择时原生恢复仍可用；改 effort 时缓存行为按实测 runtime 契约解释，不承诺未经验证的命中范围。
3. 提高 Review effort 后真正调用 Review；未失效的 BasePlan 仍可复用；旧 Review 不伪装成新 effort 的结果。
4. 无上游观测时日志输出 unknown；旧请求记录不会被当作本次实际请求。

## 7. M4：文档一致性与发布交付

优先级：P2。M1 可先交付，M2/M3 完成后再整理功能版本。

- [ ] 清理 SKILL、commands、五模板和 references 中写死的 Kimi/DeepSeek/GPT 身份；保留有日期且明确标为历史证据的旧快照。
- [ ] 更新 `model-effort.md`：目标映射为可变部署配置；Opus/Sonnet 可以同上游；用户能按别名/阶段覆盖 effort。
- [ ] 删除或纠正建议用虚构/替代模型 ID 绕过 effort 限制的操作指南。
- [ ] 调整“不同别名必然有不同模型视角”的表述；独立 Review 要求亲自检查代码和证据，不以名字保证审查独立性。
- [ ] README 添加三条用户提示词示例、离线验证命令、已知客户端限制与“请求不等于生效”的说明。
- [ ] 版本号、manifest、README 与变更日志保持一致；具体版本在实现时结合最新仓库决定。
- [ ] 新增单一离线验收入口，运行 state、model fallback、effort 与恢复策略测试；任一失败必须非零退出。

交付时报告：修改文件、行为变化、测试命令与退出码、失败/跳过项目、残留限制。提供可直接检查的 diff，不自行发布、安装插件或修改其他工程。

## 8. 可选真实链路验收（单独执行）

离线通过不等于 cc-switch 转换与真实上游已验证。真实验收须在用户授权后进行，次数/费用预算以该次授权为准；本计划不授权发请求。

选择一个临时仓库和无副作用的小任务，对实际需要的 Opus/Sonnet effort 覆盖取样，记录：客户端请求别名、请求 effort、反代后模型、可观测的实际 effort、流式终态、工具调用结果、结构化结果、耗时。无法观察的字段写 unknown。

无需为“验证 Terra 有 1M”发送大上下文，也不做压力测试。遇到提交结果未知或流中断，不自动重试有副作用操作。

## 9. 给 Sol 的直接执行指令

> 请在 `D:\AI\Skill\Workflow-Exprience` 按本计划实施，从 M1 开始，完成必要离线验证后推进 M2、M3、M4。保留 Opus 强角色路由，不新增 Terra 上下文恢复。先读现有 runtime contract 再设计 effort 参数，保持未指定参数时的旧行为。优先修真实建档故障，禁止通过放宽安全断言让测试通过。每个里程碑提供差异与验收证据；不要改 cc-switch/Claude 全局配置、执行付费模型测试、发布安装或覆盖无关改动。若某项必须修改本仓库之外的 runtime 才能实现，交付已完成的插件适配和具体阻塞证据，不用虚构字段假装完成。

参考：OpenAI 官方 [GPT-5.6 Sol 模型说明](https://developers.openai.com/api/docs/models/gpt-5.6-sol) 与 [模型目录](https://developers.openai.com/api/docs/models)。它们描述上游能力，不证明本机反代链路能力。
