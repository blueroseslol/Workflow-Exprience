# 受控并行实现

两条开发主模板支持 `parallelMode: 'auto' | 'off'`（默认 auto）、`maxParallel: 1..4`（默认 2）。主 Agent 组织任务，JS 负责依赖排序、派发与汇总，不额外调用调度模型。

## 单 Workflow

Planner 为每个 slice 增加 execution：

```js
{
  id: 'S2', title: '接入已确定的接口', files: ['src/ui.ts'], rationale: 'design.md:18',
  execution: {
    parallelSafe: true, dependsOn: ['S1'], resources: [],
    contextFiles: ['src/api.ts'],
    acceptance: ['展示接口返回的状态；失败时保留重试入口']
  }
}
```

OpenSpec slice 仍须带 sourceTaskIds。contextFiles 同时加入计划 evidenceDependencies 或 whitelist，让现有 checkpoint 指纹覆盖读取依赖。files 必须是精确 repo 相对路径。

- 契约/依赖/共享资源已查清且有足够独立工作量才设 parallelSafe=true。
- 依赖完成才释放下游；写写、读写路径重叠和 resources 同名不能同批运行。Windows 路径大小写、斜杠作保守归一化。
- 旧计划缺元数据、路径含糊、白名单有未分配文件或只能串行时，保留一个实现 Agent。重复 ID、无效依赖、循环、归属越界则停止。
- 等待本批所有写者结束后检查每个结果，不可 filter(Boolean) 丢失失败。缺失/越界/未完成阻止下一批与 Verify，并保留所有已返回结果。
- 顾问在批次结束后按 slice 顺序调用，所有切片与 Repair 共享 advisorMax；叶子禁用 Agent/Task/Workflow，避免递归扩大预算。
- 共享基线一次；叶子只做必要局部检查，最后统一集成 Verify。白名单是调度契约与结果检查，并非文件系统沙箱；并行前须确认 symlink/路径别名不会指向同一实际文件。

## 多 Workflow

仅用于独立 change、仓库或可独立交付单元。外层记录每个 runId/taskId/scriptPath、实际 worktree、workflowSliceId、负责文件，并分配总并发预算。总预算 2 时，两个同时运行的 Workflow 各传 maxParallel=1，不能各用 2。

传稳定 `workflowSliceId: 'backend'` 等标识；模板给 checkpointKey 附加 `::slice:backend`。同 change/milestone 分支不再共用状态，已有后缀不重复追加。续跑保留原 sliceId；默认旧串行 key 保持兼容。

不同 worktree 从明确基线开始，由集成者接收修改并验证；相同工作区必须确保文件和可变资源分离。OpenSpec 文档写入、tasks 勾选、全量验证和提交归唯一收口者，子 Workflow requireCommit=false。插件没有跨进程锁、自动创建/合并 worktree 或跨 run 信号量；外层必须安排这些边界，不能仅凭参数宣称已隔离。

原生 resume 可能重放失败 Agent 后的后续调用。先读取 execution.outcomes、journal、当前 git diff，核实成功切片，使用限定剩余范围的恢复计划继续；不能盲目重跑并行写入。并行省时不保证省 Token，须用相同任务记录实际用量、耗时、返工和验收结果。
