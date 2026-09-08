'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const C = require('./contracts.cjs')
const { readJson } = require('./store.cjs')
function runsDirectory(sessionId, projects = process.env.ULTRACODE_PROJECTS_DIR || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects')) {
  C.ensure(C.id(sessionId), 'identity-mismatch', '无效 worker session')
  let dirs
  try { dirs = fs.readdirSync(projects, { withFileTypes: true }).filter(e => e.isDirectory()).slice(0, 500) } catch (e) { if (e.code === 'ENOENT') return null; throw e }
  const found = dirs.map(d => path.join(projects, d.name, sessionId, 'workflows')).filter(p => fs.existsSync(p))
  C.ensure(found.length <= 1, 'needs-target', '同 session 出现多个 Workflow 目录')
  return found[0] || null
}
function fingerprint(run) { return C.hash({ runId: run.runId, status: run.status, result: run.result, totalTokens: run.totalTokens, agentCount: run.agentCount }) }
function terminalStatus(run) {
  if (!run || !['completed', 'failed', 'killed', 'error', 'cancelled'].includes(run.status)) return null
  if (['failed', 'error'].includes(run.status)) return 'failed'
  if (['killed', 'cancelled'].includes(run.status)) return 'cancelled'
  const status = run.result?.status
  if (['completed', 'green', 'success'].includes(status)) return 'completed'
  if (['blocked', 'need-decision', 'needs-decision', 'stopped', 'route-escalation-required', 'replan-required', 'escalate'].includes(status)) return 'blocked'
  if (['failed', 'red', 'error', 'commit-failed'].includes(status)) return 'failed'
  return null // engine completed without an interpretable business result is not success
}
function terminal(run) { return !!(run && ['completed', 'failed', 'killed', 'error', 'cancelled'].includes(run.status)) }
function readRun(r, runId, options = {}) {
  C.ensure(C.id(runId) && runId.startsWith('wf_'), 'invalid-reference', '需要真实 wf_ run ID')
  const dir = runsDirectory(r.worker.sessionId, options.projects)
  C.ensure(dir, 'workflow-unavailable', '没有匹配 worker session 的 Workflow 记录')
  const file = C.boundedPath(dir, path.join(dir, `${runId}.json`))
  const run = readJson(file, 16 * 1024 * 1024)
  C.ensure((!run.runId || run.runId === runId) && (!run.sessionId || run.sessionId === r.worker.sessionId), 'identity-mismatch', 'Workflow 记录身份不一致')
  if (!run.runId) run.runId = runId
  C.ensure(run.scriptPath, 'workflow-unavailable', 'Workflow 未记录 scriptPath')
  // Inline Workflow scripts are materialized by Claude under this exact session.
  const scriptRoot = C.within(C.real(r.worker.cwd), path.resolve(run.scriptPath)) ? r.worker.cwd : path.join(dir, 'scripts')
  C.boundedPath(scriptRoot, run.scriptPath)
  return { run, file, terminal: terminal(run), workStatus: terminalStatus(run), terminalFingerprint: fingerprint(run) }
}
function discover(r, options = {}) {
  const dir = runsDirectory(r.worker.sessionId, options.projects)
  if (!dir) return []
  const after = Date.parse(options.startedAt || r.intent.authorizedAt)
  return fs.readdirSync(dir).filter(n => /^wf_[a-zA-Z0-9_-]+\.json$/.test(n)).slice(0, 200).flatMap(n => {
    const p = path.join(dir, n)
    if (fs.statSync(p).mtimeMs < after) return []
    try { const v = readRun(r, n.slice(0, -5), options); return [v] } catch { return [] }
  })
}
function verifyResult(r, result, options) {
  const record = readRun(r, result.workflowRunId, options)
  C.ensure(record.workStatus && record.workStatus === result.workStatus && record.terminalFingerprint === result.terminalFingerprint && C.samePath(C.real(record.run.scriptPath), C.real(result.scriptPath)), 'terminal-mismatch', '结果与真实 Workflow 终态不一致')
  return record
}
module.exports = { runsDirectory, fingerprint, terminal, terminalStatus, readRun, discover, verifyResult }
