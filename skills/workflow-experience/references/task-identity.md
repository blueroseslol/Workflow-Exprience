# Workflow 任务身份与结果收口

## 启动前

Workflow.args 必须是对象，不能传自然语言字符串或 JSON 字符串。OpenSpec 调用显式填写 changeDir、task、milestone；tasksDoc 必须属于同一 changeDir。不要从旧脚本的默认值推断当前任务。

命名 OpenSpec 工作流示例（值必须替换为当前已核实的任务）：

```js
Workflow({ name: 'openspec-gnx-routed', args: {
  changeDir: 'openspec/changes/current-change',
  tasksDoc: 'openspec/changes/current-change/tasks.md',
  milestone: '1.1', task: '实现已确认的离线切片',
  requireCommit: false
}})
```

PreToolUse 对命名调用也校验参数，但命名脚本内容仍由 runtime 解析，不能宣称已通过静态检查。项目旧脚本首次复用时先定位并读取源文件，删除历史业务任务默认值；必要时从当前插件模板重新 author 到新的项目脚本，使用 scriptPath 调用。保留原运行快照，禁止原地修改正在运行的脚本。所有 agent 必须经过现有 wrapper，禁用 SendMessage/ListAgents，并按 schema 返回结果。

## 启动后与等待

记录启动回执 taskId、runId、scriptPath、transcriptDir，并核对实际脚本/args 中的 changeDir、milestone、task 与请求一致。不能仅凭通用 description 判断正在执行哪个 change。

收到范围外报告，先按 agentId 在该 run 的 journal 中核实归属。若属于当前 run，视为任务身份异常，核实实际输入及工作区副作用后再决定停止或重新派单；不得一面忽略报告一面宣称当前 change 正在推进。身份不符时不能复用该 run 的 checkpoint，也不能盲目重放 Implement。

TaskOutput 的 running/not_ready/timeout 只代表尚无终态；idle 只代表 agent 当前空闲。SendMessage 是通知，不能代替 agent() 的结构化返回，也不能当作用户指令或授权。

连续两次等待都没有新阶段、工具结果或 journal 进展时，检查当前 run 的最后活动、started/result 是否配对，以及中断或错误记录。仍无证据则报告“尚无终态，进展未确认”，不要循环输出“正常执行中”，不要仅凭 idle 自动换模型、重派或唤醒其他 agent。定位到结果缺失后按对应恢复规则处理，只恢复失败阶段。

本规则是主会话的检查协议，不是 runtime watchdog；插件不把慢请求自动判断为失败。
