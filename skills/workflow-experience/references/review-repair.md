# Reviewer 与运行恢复

完整契约见 [workflow-review-repair.md](../../../docs/workflow-review-repair.md)。

- 局部问题 Reviewer 直接返回修订后的结构化 plan，附证据和受影响 slice；新的 Review 调用独立复审。
- 跨 slice/架构分歧由脚本调用提案、质疑、唯一汇总者，不启动自主消息团队，不允许讨论替代用户决策。
- Verify 的状态与命令退出码必须一致；失败后仅在 whitelist 内 Repair，再 Verify；默认最多 2 次。
- 脚本先预检，变量作用域错误不能留到 Verify 才发现；所有路径用结构化参数，索引名与工作树路径分离。
- 实现后脚本异常：读取原始 run、args、批准计划及工作树，再用恢复模板；完成则仅 Verify，部分则补缺失，未知则停止。不要直接重跑整个脚本。
- 两条开发主模板 requireCommit 默认 false。Reviewer 输出计划不等于批准提交。
- 原生 Agent Teams 只能另行通过外层交互主会话接入；当前受控讨论不是 AgentTeam，不得宣称已启动原生团队。
