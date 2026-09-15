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
  let source
  if (tool.scriptPath !== undefined) source = fs.readFileSync(path.resolve(input.cwd || process.cwd(), validText(tool.scriptPath, 'scriptPath')), 'utf8')
  else if (typeof tool.script === 'string') source = tool.script
  else if (tool.name) {
    // Built-ins/plugin name resolution belongs to the runtime. Do not break it.
    return null
  } else throw new Error('Workflow requires scriptPath, script or name')
  const errors = checkSource(source)
  const args = tool.args || {}
  if (typeof args !== 'object' || Array.isArray(args)) throw new Error('Workflow args must be a structured object')
  for (const key of ['repo', 'worktree', 'changeDir', 'proposalDoc', 'designDoc', 'tasksDoc', 'planDoc', 'specsGlob']) {
    if (args[key] !== undefined && !(key === 'planDoc' && args[key] === '')) validText(args[key], `args.${key}`)
  }
  if (args.gitnexusRepo !== undefined) {
    validText(args.gitnexusRepo, 'args.gitnexusRepo')
    if (/[\\/]/.test(args.gitnexusRepo) || args.gitnexusRepo === args.repo || args.gitnexusRepo === args.worktree) errors.push('gitnexusRepo must be an index name, distinct from the worktree path')
  }
  return errors
}
function main(input) {
  if (input.tool_name && input.tool_name !== 'Workflow') return null
  let errors
  try { errors = validateInput(input) } catch (error) { errors = [error.message] }
  if (errors === null) return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: '命名 Workflow 的脚本由 runtime 解析，本插件未执行静态预检；自定义开发脚本请先解析成 scriptPath 再调用。' } }
  if (!errors.length) return null
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason:
    `Workflow 执行前检查失败：\n${errors.join('\n')}\n修复脚本/结构化参数后重试。若已有运行记录，先核实工作树，只恢复失败阶段，禁止直接重放 Implement。` } }
}
module.exports = { main, validateInput }
if (require.main === module) {
  try { const result = main(JSON.parse(fs.readFileSync(0, 'utf8'))); if (result) process.stdout.write(JSON.stringify(result)) }
  catch (error) { process.stderr.write(`Workflow preflight failed: ${error.message}`); process.exitCode = 2 }
}
