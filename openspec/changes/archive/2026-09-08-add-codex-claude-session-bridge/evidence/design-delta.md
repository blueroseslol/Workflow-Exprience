# 实测约束与未完成边界

1. Windows history 改用独立 stdio app-server 只读请求；Unix 才使用 proxy。只读观察不提供运行所有权证明，Windows Codex resume 发送保持 fail-closed。
2. queue 可在目标退出后保留消息；queued/received/accepted 必须继续分开。没有实现自动唤醒保证。
3. 原生 Workflow 内联脚本可能位于该 worker session 的 workflows/scripts，允许这个精确目录，拒绝其他 session 的脚本。
4. `reconcile` 回收已确认死亡且无未终结 Workflow 的锁并对账 sending；`retry-delivery` 只允许已证明未提交的预检失败。unknown 不盲目重发。
5. 受控 worker 按 Claude session 使用用户级持久 scheduler；活跃 worker 的新 request 进入 FIFO inbox，必须以 `resumeFromRequestId` 引用当前 active request。前序 runner/child 退出并释放 session/worktree lease 后才以原 ID resume；跨 worktree 与身份漂移 fail closed。外部活跃目标走独立显式 relay，不复制会话。
6. runner 超时后保留可能存在子进程/Workflow 的锁。cancel 只撤销待发通知并记录 stop-requested，不声称已经终止模型或子进程。
7. allowedPaths 是契约和结果校验，不是文件系统沙箱。派发会核对 HEAD、porcelain 和导出时明确文件 hash；目录授权仅有 Git 状态观察，不声称已计算完整目录内容指纹。
8. scopeHash 覆盖端点、工作区、任务、通知、执行权限和用户授权动作；不把通信信息加入 Plan 或模板缓存键。
9. 返工最多两轮是主控 runbook 约定，当前没有跨 request 自动计数/派发的业务编排器。
10. Workflow 引擎 `completed` 但业务结果缺少顶层 `status` 时标记 `workflow-result-uninterpretable`，不等待成后台任务或声明成功；worker prompt 要求自定义 schema 同样保留 status。

当前能力边界由真实矩阵与离线回归共同冻结。Codex queue 的 queued 仍不等于 received，relay 的 peer 回执仍不等于业务验收。该 change 未发布、提交、推送或重装插件。
