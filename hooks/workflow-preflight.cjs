#!/usr/bin/env node
// Never execute the candidate script. Inspect all branches before any agent starts.
const fs = require('fs')
const path = require('path')
const { checkSource } = require('./vendor/workflow-static.cjs')
function validText(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\x00\r\n]/.test(value) || /^["'`]|["'`]$/.test(value)) throw new Error(`${label}: invalid path/name`)
  return value
}
function validateInput(input) {
  const tool = input.tool_input || {}
  // Validate before named-workflow resolution: strings otherwise silently use
  // the script's historical defaults through args?.changeDir / args?.task.
  const args = tool.args === undefined ? {} : tool.args
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('Workflow args must be a structured object; natural-language strings are not accepted')
  if (args.parallelMode !== undefined && !['auto', 'off'].includes(args.parallelMode)) throw new Error('parallelMode must be auto or off')
  if (args.reviewTiming !== undefined && !['milestone', 'plan'].includes(args.reviewTiming)) throw new Error('reviewTiming must be milestone or plan')
  if (args.maxParallel !== undefined && (!Number.isInteger(args.maxParallel) || args.maxParallel < 1 || args.maxParallel > 4)) throw new Error('maxParallel must be an integer from 1 to 4')
  if (args.workflowSliceId !== undefined && (typeof args.workflowSliceId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(args.workflowSliceId))) throw new Error('workflowSliceId must be a stable identifier')
  if (args.checkpointKey !== undefined && (typeof args.checkpointKey !== 'string' || !args.checkpointKey.trim() || /[\x00\r\n]/.test(args.checkpointKey))) throw new Error('checkpointKey must be non-empty text')
  if (tool.name && /openspec/i.test(tool.name)) {
    for (const key of ['changeDir', 'task', 'milestone']) {
      if (typeof args[key] !== 'string' || !args[key].trim()) throw new Error(`OpenSpec named Workflow requires explicit args.${key}; historical defaults are forbidden`)
    }
  }
  const errors = []
  for (const key of ['repo', 'worktree', 'changeDir', 'proposalDoc', 'designDoc', 'tasksDoc', 'planDoc', 'specsGlob']) {
    if (args[key] !== undefined && !(key === 'planDoc' && args[key] === '')) validText(args[key], `args.${key}`)
  }
  if (args.gitnexusRepo !== undefined) {
    validText(args.gitnexusRepo, 'args.gitnexusRepo')
    if (/[\\/]/.test(args.gitnexusRepo) || args.gitnexusRepo === args.repo || args.gitnexusRepo === args.worktree) errors.push('gitnexusRepo must be an index name, distinct from the worktree path')
  }
  if (args.changeDir && args.tasksDoc) {
    const base = path.resolve(input.cwd || process.cwd(), args.worktree || args.repo || '.')
    const change = path.resolve(base, args.changeDir)
    const relative = path.relative(change, path.resolve(base, args.tasksDoc))
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) errors.push('args.tasksDoc must belong to args.changeDir; task identity mismatch')
  }
  let source
  if (tool.scriptPath !== undefined) source = fs.readFileSync(path.resolve(input.cwd || process.cwd(), validText(tool.scriptPath, 'scriptPath')), 'utf8')
  else if (typeof tool.script === 'string') source = tool.script
  else if (tool.name) {
    // Built-ins/plugin name resolution belongs to the runtime. Do not break it.
    return errors.length ? errors : null
  } else throw new Error('Workflow requires scriptPath, script or name')
  errors.push(...checkSource(source))
  return errors
}
function main(input) {
  if (input.tool_name && input.tool_name !== 'Workflow') return null
  let errors
  try { errors = validateInput(input) } catch (error) { errors = [error.message] }
  if (errors === null) return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: '结构化参数已校验；命名 Workflow 的脚本由 runtime 解析，本插件未执行脚本静态预检。启动后核对 taskId/runId、实际 args 与 change/milestone，范围外报告先查 agent 的 run 归属；running/idle/SendMessage 均不代表完成。旧自定义脚本请先解析成 scriptPath 并检查历史默认任务与 agent wrapper。' } }
  if (!errors.length) return null
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason:
    `Workflow 执行前检查失败：\n${errors.join('\n')}\n修复脚本/结构化参数后重试。若已有运行记录，先核实工作树，只恢复失败阶段，禁止直接重放 Implement。` } }
}
module.exports = { main, validateInput }
if (require.main === module) {
  try { const result = main(JSON.parse(fs.readFileSync(0, 'utf8'))); if (result) process.stdout.write(JSON.stringify(result)) }
  catch (error) { process.stderr.write(`Workflow preflight failed: ${error.message}`); process.exitCode = 2 }
}
