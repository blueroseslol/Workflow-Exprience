// Classify only runtime error fields, never prompts or arbitrary agent prose.
function classifyScriptFailure(run) {
  if (!['failed', 'error', 'killed'].includes(run?.status) && run?.result != null) return null
  const value = typeof run?.error === 'string' ? run.error : run?.error?.message
  if (typeof value !== 'string') return null
  const match = value.match(/ReferenceError:\s*([A-Za-z_$][\w$]*) is not defined|Path contains null bytes/i)
  return match ? { kind: match[1] ? 'undefined-variable' : 'invalid-path', error: value } : null
}
function buildScriptRecoveryReason(entries) {
  return '[Workflow 脚本故障恢复] 检测到运行时脚本/路径错误。由当前外层会话修复并续做本次已授权任务，不新增跨会话消息。\n' +
    entries.map(e => JSON.stringify({ runId: e.runId, scriptPath: e.scriptPath, rawFile: e.rawFile, error: e.scriptFailure.error })).join('\n') +
    '\n先读取原始运行记录、原脚本和 args，再读取工作树/未跟踪文件/目标内容。修复未定义变量与参数路径，执行脚本预检。' +
    '不要改完脚本就从头重跑 Implement。使用 recover-verify 模板，approvedPlan 必须取自本次失败运行的已批准计划；repo/worktree/gitnexusRepo 来自原结构化参数，核实索引映射。' +
    '实现已完成则只 Verify，部分完成只补缺失，无法核实则报告阻塞。没有已批准计划时先只读重建证据，不猜白名单。' +
    '保留原错误、命令、退出码和输出；不重复复制/应用补丁，不覆盖无关修改，不 commit/push/deploy/数据库写入。' +
    '本终态只自动恢复一次，持续失败如实报告，禁止无限重试。'
}
module.exports = { classifyScriptFailure, buildScriptRecoveryReason }
