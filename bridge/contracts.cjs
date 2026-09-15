'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const ensure = (ok, code, message) => { if (!ok) fail(code, message) }
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest('hex')
const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(value)
function text(value, field) { ensure(typeof value === 'string' && value.trim().length > 0, 'invalid-contract', `${field} 必须是非空文本`); return value }
function list(value, field) { ensure(Array.isArray(value), 'invalid-contract', `${field} 必须为数组`); return value }
function version(value) { ensure(value?.schemaVersion === 1, 'unsupported-version', '仅支持 schemaVersion=1') }
function samePath(a, b) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b }
function real(p) { ensure(typeof p === 'string' && path.isAbsolute(p), 'invalid-path', '必须使用绝对路径'); return fs.realpathSync(p) }
function within(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
function boundedPath(root, candidate, { exists = true } = {}) {
  root = real(root)
  const absolute = path.resolve(candidate)
  ensure(within(root, absolute), 'path-outside-root', '路径不在允许目录中')
  let parent = absolute
  while (!fs.existsSync(parent)) {
    ensure(!exists, 'missing-path', '指定文件不存在')
    const next = path.dirname(parent)
    ensure(next !== parent, 'missing-path', '路径无法解析'); parent = next
  }
  ensure(within(root, fs.realpathSync(parent)), 'path-outside-root', '路径经链接解析后越界')
  return absolute
}
function parseReference(value, provider) {
  text(value, 'reference')
  if (value.includes('://')) {
    ensure(provider === 'codex', 'invalid-reference', '此 provider 不支持会话 URI')
    let u; try { u = new URL(value) } catch { fail('invalid-reference', '无效会话链接') }
    ensure(u.protocol === 'codex:' && u.hostname === 'threads' && !u.search && !u.hash && !u.username && !u.password && !u.port && /^\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(u.pathname), 'invalid-reference', '支持 codex://threads/<id>')
    return u.pathname.slice(1)
  }
  ensure(id(value), 'invalid-reference', '请使用明确 session ID；名称必须先解析唯一目标')
  return value
}
function endpoint(e) {
  ensure(e && ['codex', 'claude'].includes(e.provider), 'invalid-contract', 'provider 必须为 codex/claude')
  ensure(e.hostId === 'local', 'unsupported-host', '首版只支持本机')
  ensure(id(e.sessionId), 'invalid-reference', '无效 sessionId')
  real(e.cwd)
  if (e.sessionUri) ensure(parseReference(e.sessionUri, e.provider) === e.sessionId, 'identity-mismatch', 'URI 与 sessionId 不一致')
  return e
}
const identity = e => `${e.provider}:${e.hostId}:${e.sessionId}`
const sameEndpoint = (a, b) => !!(a && b && identity(a) === identity(b) && samePath(real(a.cwd), real(b.cwd)))
function resolveName(name, provider, cwd, candidates) {
  const matches = candidates.filter(e => e.provider === provider && e.displayName === name && samePath(real(e.cwd), real(cwd)))
  ensure(matches.length === 1, 'needs-target', '会话名称不存在或不唯一；请指定 session ID')
  return endpoint(matches[0])
}
const scopeHash = r => hash({ origin: r.origin, worker: r.worker, replyTo: r.replyTo, workspace: r.workspace, work: r.work, notify: r.notify, control: r.control, authority: { enabled: r.intent?.enabled, source: r.intent?.source, userInstruction: r.intent?.userInstruction, requestedActions: r.intent?.requestedActions } })
function validateRequest(r, { checkExpiry = true } = {}) {
  version(r)
  for (const k of ['requestId', 'bindingId']) ensure(id(r[k]), 'invalid-contract', `无效 ${k}`)
  endpoint(r.origin); endpoint(r.worker); endpoint(r.replyTo)
  ensure(sameEndpoint(r.origin, r.replyTo), 'identity-mismatch', 'replyTo 必须匹配 origin')
  ensure(r.origin.provider === 'codex' && r.worker.provider === 'claude', 'invalid-contract', '主控必须为 Codex，执行器必须为 Claude CLI')
  const w = r.workspace
  ensure(w && Array.isArray(w.allowedPaths) && w.allowedPaths.length > 0, 'invalid-contract', '缺少工作区授权路径')
  real(w.repoRoot); real(w.worktreeRoot)
  ensure(samePath(real(w.worktreeRoot), real(r.worker.cwd)), 'workspace-mismatch', 'worker cwd 必须匹配 worktreeRoot')
  if (!samePath(real(r.origin.cwd), real(r.worker.cwd))) ensure(r.workspace.worktreeMapping?.origin === real(r.origin.cwd) && r.workspace.worktreeMapping?.worker === real(r.worker.cwd), 'workspace-mismatch', '跨 worktree 需要明确映射')
  for (const p of w.allowedPaths) boundedPath(w.worktreeRoot, path.resolve(w.worktreeRoot, p), { exists: false })
  text(w.baselineHead, 'baselineHead'); text(r.work?.requirement, 'requirement')
  for (const k of ['taskIds', 'acceptance', 'stopConditions']) list(r.work[k], `work.${k}`)
  if (r.work.openspecChangeDir) boundedPath(w.worktreeRoot, r.work.openspecChangeDir)
  ensure(r.intent?.enabled === true && r.intent.source === 'user-explicit', 'intent-required', '需要本任务显式协作授权')
  text(r.intent.userInstruction, 'intent.userInstruction')
  ensure(Number.isFinite(Date.parse(r.intent.authorizedAt)), 'invalid-contract', 'invalid authorizedAt')
  ensure(r.intent.scopeHash === scopeHash(r), 'scope-mismatch', '授权范围摘要不匹配')
  ensure(list(r.intent.requestedActions, 'requestedActions').every(a => ['read-context', 'dispatch-work', 'notify-terminal'].includes(a)), 'invalid-contract', '未知协作动作')
  ensure(r.notify?.when === 'terminal' && typeof r.notify.required === 'boolean', 'invalid-contract', 'notify 必须声明终态策略')
  ensure(['queue', 'resume'].includes(r.notify.transport), 'unsupported', '未知 Codex transport')
  ensure(r.control?.mode === 'supervised' && Number.isInteger(r.control.maxRevisionRounds) && r.control.maxRevisionRounds >= 0 && r.control.maxRevisionRounds <= 2, 'invalid-contract', '返工上限必须为 0..2')
  ensure(r.control.workerTransport == null || ['worker', 'relay', 'channel'].includes(r.control.workerTransport), 'unsupported', '未知 Claude transport')
  if (r.control.receiptTimeoutMs != null) ensure(Number.isInteger(r.control.receiptTimeoutMs) && r.control.receiptTimeoutMs >= 1000 && r.control.receiptTimeoutMs <= 3600000, 'invalid-contract', 'receiptTimeoutMs 必须为 1秒..1小时')
  if (r.control.workerTransport === 'channel') ensure(r.control.allowCreateWorker !== true && !r.control.resumeFromRequestId, 'invalid-contract', 'channel 只连接既有会话，不创建或 resume worker')
  if (r.control.resumeFromRequestId != null) ensure(id(r.control.resumeFromRequestId) && r.control.resumeFromRequestId !== r.requestId, 'invalid-reference', 'resumeFromRequestId 必须引用另一个明确 request')
  for (const date of [r.control.requestExpiry, r.notify.deadlineAt]) {
    ensure(Number.isFinite(Date.parse(date)), 'invalid-contract', '必须指定有效截止时间')
    if (checkExpiry) ensure(Date.parse(date) > Date.now(), 'expired', '请求或通知已过期')
  }
  return r
}
function createRequest(input) {
  const r = structuredClone(input)
  ensure(r && typeof r === 'object' && r.workspace && r.intent, 'invalid-contract', '缺少 request/workspace/intent')
  if (r.schemaVersion != null) version(r)
  r.schemaVersion = 1
  r.requestId ||= crypto.randomUUID(); r.bindingId ||= crypto.randomUUID()
  for (const key of ['origin', 'worker']) {
    ensure(r[key], 'invalid-contract', `缺少 ${key}`)
    r[key].hostId ||= 'local'; r[key].cwd = real(r[key].cwd)
    if (r[key].sessionUri) r[key].sessionId = parseReference(r[key].sessionUri, r[key].provider)
  }
  if (!r.worker.sessionId && r.control?.allowCreateWorker === true) r.worker.sessionId = crypto.randomUUID()
  r.replyTo ||= structuredClone(r.origin)
  r.workspace.repoRoot = real(r.workspace.repoRoot); r.workspace.worktreeRoot = real(r.workspace.worktreeRoot)
  r.intent.authorizedAt ||= new Date().toISOString()
  r.intent.scopeHash = scopeHash(r)
  return validateRequest(r)
}
function authorize(r, action) { validateRequest(r); ensure(r.intent.requestedActions.includes(action), 'action-not-authorized', `本任务未授权 ${action}`) }
function validateResult(v, r) {
  version(v)
  ensure(v.requestId === r.requestId, 'identity-mismatch', '结果不属于本请求')
  ensure(['completed', 'failed', 'blocked', 'cancelled'].includes(v.workStatus), 'not-terminal', '结果尚非终态')
  for (const k of ['workflowRunId', 'scriptPath', 'terminalFingerprint', 'summary', 'baselineHead', 'currentHead']) text(v[k], k)
  ensure(v.baselineHead === r.workspace.baselineHead, 'workspace-mismatch', '结果基线必须匹配请求')
  for (const k of ['completedTaskIds', 'remainingTaskIds', 'changedFiles', 'commits', 'tests', 'blockers', 'nextActions', 'sourceRefs']) list(v[k], k)
  ensure([...v.completedTaskIds, ...v.remainingTaskIds].every(t => r.work.taskIds.includes(t)), 'scope-mismatch', '结果 task IDs 超出契约')
  const taskIds = [...v.completedTaskIds, ...v.remainingTaskIds]
  ensure(new Set(taskIds).size === taskIds.length && r.work.taskIds.every(t => taskIds.includes(t)), 'scope-mismatch', '任务完成/剩余列表必须完整且不重叠')
  for (const changed of v.changedFiles) {
    const file = boundedPath(r.worker.cwd, path.resolve(r.worker.cwd, changed), { exists: false })
    ensure(r.workspace.allowedPaths.some(p => within(path.resolve(r.worker.cwd, p), file)), 'scope-mismatch', '结果包含授权范围外的修改路径')
  }
  for (const t of v.tests) {
    text(t.command, 'test.command'); real(t.cwd)
    ensure(Number.isInteger(t.exitCode) || (t.exitCode === null && typeof t.notRunReason === 'string' && t.notRunReason.length), 'invalid-contract', '测试必须有退出码或未运行原因')
    if (t.exitCode !== null) text(t.evidence, 'test.evidence')
  }
  if (v.workStatus === 'completed') ensure(v.remainingTaskIds.length === 0 && v.blockers.length === 0 && v.tests.every(t => t.exitCode === 0), 'verification-incomplete', '尚有阻塞、未完成任务或未通过测试，不能声明 completed')
  return v
}
function validateMessage(m, r) {
  version(m)
  ensure(id(m.messageId) && m.requestId === r.requestId && m.bindingId === r.bindingId, 'identity-mismatch', '消息身份不匹配')
  ensure(['request', 'result', 'ack', 'cancel'].includes(m.kind), 'invalid-contract', '未知消息种类')
  const reverse = m.kind === 'result'
  ensure(sameEndpoint(m.from, reverse ? r.worker : r.origin) && sameEndpoint(m.to, reverse ? r.origin : r.worker), 'identity-mismatch', '消息端点不匹配')
  ensure(Number.isFinite(Date.parse(m.createdAt)) && Number.isFinite(Date.parse(m.expiresAt)), 'invalid-contract', '消息时间无效')
  ensure(Date.parse(m.expiresAt) > Date.now(), 'expired', '消息已过期')
  text(m.artifact?.path, 'artifact.path')
  ensure(/^[a-f0-9]{64}$/.test(m.artifact.sha256), 'invalid-contract', '无效 artifact hash')
  return m
}
function validateReceipt(v, r, m) {
  version(v)
  ensure(v.requestId === r.requestId && v.messageId === m.messageId && v.sessionId === r.origin.sessionId && v.sha256 === m.artifact.sha256, 'identity-mismatch', '回执身份/hash 不匹配')
  ensure(Number.isFinite(Date.parse(v.receivedAt)), 'invalid-contract', '回执需要有效 receivedAt')
  return v
}
module.exports = { fail, ensure, hash, id, real, samePath, within, boundedPath, parseReference, endpoint, identity, sameEndpoint, resolveName, scopeHash, validateRequest, createRequest, authorize, validateResult, validateMessage, validateReceipt }
