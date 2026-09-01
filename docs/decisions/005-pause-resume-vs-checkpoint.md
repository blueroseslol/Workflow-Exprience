# ADR-005：暂停两级设计——Resume 保缓存（同 session），Checkpoint 保状态（跨 session）

**日期**：2026-09-01
**状态**：已采纳
**关系**：细化 ADR-003，不推翻

## 背景

ADR-003 为「等用户拍板」场景选了 B（一个决议一个 workflow，结论抄进新脚本 `COMMON`），把 resume（A）留作"同会话优化"。实践后发现两对概念被混为一谈：

1. **早退有两种**：
   - `route-escalation-required` / `replan-required` —— 主 agent 可自动处理，**不等用户、必然同 session**
   - `need-decision` —— 必须等用户拍板，**大概率跨 session**（拍板往往隔夜）
2. **「保存什么」有两种**：计算缓存（agent 结果）vs 开发状态（plan / routing / 决议 / 进度）。

对第一类早退套用 ADR-003 的"开新 workflow"，会白白重跑 Recon（中位 ~10 万 token），而它本来可以缓存命中。

## 决定

**按 session 边界分流，不再一刀切首选新脚本：**

| | Resume | Checkpoint |
|---|---|---|
| 保存 | 计算缓存（agent 结果） | 开发状态（plan / routing / 决议 / 进度） |
| 机制 | 同 scriptPath + `resumeFromRunId` + 新 args | 新脚本，上轮结论抄进 `COMMON` |
| 前提 | 同 session、脚本一字节未改 | 无（跨 session 唯一选择） |
| 成本 | 未变前缀全部 CACHE HIT | 重跑只读 recon（~10 万 token） |

- **自动可处理的早退**（`route-escalation-required` / `replan-required`）→ resume 是**主路径**。
- **等用户拍板的早退**（`need-decision`）→ 用户同 session 立即回答用 resume；隔夜 / `/clear` / 重启后用 checkpoint（ADR-003 的 B 不变，此时它是唯一路径而非"首选"）。
- Checkpoint 的数据源：`harvest-workflow` 固化的 `docs/ultracode/raw/wf_*.json`（完整 result，含 plan / routing / decisions）+ `.claude/progress/*.jsonl`（跨会话进度摘要）。

## 关键机制说明

- **resume 的 args 是全量替换不是合并**：首轮 args（repo / task / milestone / ts…）必须原样带上再叠加 `nextArgs` / `decisions`，否则脚本回退到 `<占位>` 默认值。
- **escalation resume 为什么只重跑升级段**：`args` 不进缓存键，但 `minRoute` 经 JS 纯函数改变 `route` —— 跨模型档（LOW/MEDIUM ↔ HIGH/CRITICAL）时 `plannerModel` 变、`model` 进缓存键；同档升级（LOW→MEDIUM、HIGH→CRITICAL）模型不变，靠 Plan prompt 内嵌的 `routing.route` 变化失效（prompt 进缓存键）。二者任一都使 Plan 起缓存 miss、Plan 及之后重跑；Recon 的 prompt/opts 未变 → 命中。即「只升级 Planner 及以后，不从头花钱重读代码」。
- **升级粘滞**：`minRoute` 给路由兜底，Recon 重判 LOW 也不会回落，避免「升级 → 回落 → 再升级」死循环。

## 与 ADR-003 的关系

ADR-003 的「resume 是优化不是主路径」原文仅适用于其自身场景（等用户拍板），已加修订指针指向本 ADR。三个 blocker 在两个场景下的适用性：

| Blocker | 等用户拍板（ADR-003 场景） | 自动续跑（本 ADR 场景） |
|---|---|---|
| same-session only | 拍板常隔夜，session 大概率已换 → 静默全量重跑 | 主 agent 收到早退**当场**处理，同 session 是确定的 |
| 25-agent 警告线 | 「整个 Stage 一个 workflow」才越线（7 里程碑 × 3-4 = 21-28） | 每个 milestone 仍是独立 workflow（4-8 agent），resume 不并 run |
| 脚本冻结 | 冻结期横跨拍板等待，想改模板就得作废等待中的 run | 续跑在秒级完成；真要改模板，作废一个刚早退的 run 代价本就只是一次重跑 |

B 仍是跨 session 的唯一选择；本 ADR 把「同 session 自动续跑」从"优化"提升为该类场景的主路径。
