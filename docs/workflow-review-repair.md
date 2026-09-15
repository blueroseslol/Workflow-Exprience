# Reviewer 自修、受控讨论与失败恢复

本次修改适用于开发入口的 `gitnexus-routed.js` 和 `openspec-incremental.js`；只读调研与其他参考模板维持原行为。

Reviewer 对有源码/测试/计划字段证据的 mechanical、单 slice 问题，直接返回 `revisedPlan`。JS 检查 decisionPoints 不变、mustNotTouch 不减少、未声明受影响的 slice 不变、slice 文件仍在 whitelist；随后新的 Review 调用独立审查修订结果。Reviewer 不直接写业务代码或计划文件，批准后的 OpenSpec delta 仍由 SpecSync 写回。

跨 slice、架构推理或 Reviewer 无法给出具体修订时，由外层脚本串行调用 Planner 提案、Challenger 质疑、唯一汇总者修订，双方结果显式传递。后续仍需独立 Review。新增用户决策返回 block，讨论不能替用户决定新的范围/资源/架构取舍。默认最多修订 2 轮；通用模板为 `maxReviewRounds`，OpenSpec 模板为 `maxPatchRounds`（含历史局部恢复消耗的轮次），允许整数 0–5。

Verify 未通过时，最多执行 `maxRepairRounds`（默认 2，整数 0–5）次 `Repair → Verify`。Repair 只修改已批准 whitelist，真实失败证据随调用传入；超范围或不能完成则返回 needs-rework。Verify 无返回直接 failed；索引不匹配停止，不能换仓库冒充通过。JS 同时核对状态、失败计数、typecheck 退出码、测试总数、原始输出，以及每条计划命令和两条 diff 检查的退出码。GitNexus unavailable 如实保留，表示图验证缺失，不能声称图验证成功。

两条开发主模板默认 `requireCommit=false`。只有用户明确授权提交时才传 true，push、deploy、数据库写入不由本次修复开启。Review/讨论及 Repair 的历史随终态返回，保存在现有 raw 运行记录中。

## 脚本预检与恢复

`PreToolUse(Workflow)` 对 `scriptPath` 或 inline `script` 做 AST 解析和变量作用域分析，不执行候选脚本，不启动任何模型调用。能发现 Verify 分支中的未定义 `a`，不会误报合法的局部别名。路径参数在工具调用前校验 NUL、换行和包裹引号；`gitnexusRepo` 必须是索引名，不能把绝对路径同时当索引名。映射真实性仍由实际 GitNexus 验证确认。

命名内置/插件 Workflow 的解析属于 runtime，本插件不会冒充已经检查其源码：返回明确的未预检说明；自定义开发脚本先解析为 `scriptPath` 再执行。静态分析不能证明运行时所有分支或业务逻辑正确，仍需 Verify。

Stop hook 只从失败运行的 `error` 字段识别 `ReferenceError: … is not defined` / `Path contains null bytes`，不从 prompt、示例和任意日志猜根因。命中后保持原始 raw 记录，并续起外层会话一次处理；同终态通过现有游标去重，Stop 递归保护继续生效。

外层读取原始脚本、args、已批准计划及当前 dirty/未跟踪内容，修复脚本后使用 `recover-verify.js`：

```json
{
  "repo": "D:/actual/repository",
  "worktree": "D:/actual/repository",
  "gitnexusRepo": "actual-index-name",
  "approvedPlan": {
    "whitelist": ["src/existing-file.ts"],
    "testCommands": ["npm run typecheck"]
  },
  "maxRepairRounds": 2
}
```

这里的 plan 必须来自对应失败任务已批准计划，示例不可当真实授权。恢复只读 Recon 必须给出逐项证据：complete 直接 Verify；partial/not-started 只补缺失；unknown 停止，不覆盖工作树。缺失已批准计划时先取证，不猜白名单。原脚本修改可能使 runtime 缓存失效，因此不能直接从头重放 Implement。

## Agent Teams 支持边界（2026-09-14 核对）

本机 CLI 为 Claude Code 2.1.260。官方文档已说明 v2.1.178 后 TeamCreate/TeamDelete 被移除；交互式主会话启用 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 后，命名子代理可以成为 teammate。`-p` / Agent SDK 非交互会话不生成 teammates。Windows 可用 in-process 模式，不要求 tmux。

当前 Workflow DSL 中没有原生 Team 调用适配器，模板 `llmAgent()` 也继续禁用 SendMessage/ListAgents。本次实现的是脚本负责调用和传递结构化结果的受控讨论，**不是原生 AgentTeam**。若需要原生团队参与 Reviewer，需由外层交互式主会话创建并协调，再把团队汇总结果接回计划验证与续跑流程；仅修改 Reviewer prompt 或传 `agentTeam:true` 不能实现该接线。本次没有修改用户 Teams 配置，也没有启动真实团队测试。

来源：[Agent Teams](https://code.claude.com/docs/en/agent-teams)、[Dynamic workflows](https://code.claude.com/docs/en/workflows)。旧 ADR-004 的具体 API 名称/邮箱细节只作历史记录，当前能力以这两份官方文档与实测为准。

## 维护与验收

运行 `node tools/verify-all.mjs`，包含执行真实模板的 stub 回归，无模型调用。修改共享策略后运行 `node tools/sync-workflow-policy.mjs`，保持可独立复制的模板同步。修改静态分析器时先 `npm ci` 再 `npm run build:preflight`；已安装插件携带打包后的解析器，运行 hook 只需要 Node。
