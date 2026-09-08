'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { Store, readJson } = require('./store.cjs')
const C = require('./contracts.cjs')
const context = require('./context.cjs')
const codex = require('./adapters/codex.cjs')
const { gitSnapshot } = require('./process.cjs')
function load(store, requestId, { allowExpired = false } = {}) {
  const r = store.read(store.run(requestId))
  C.validateRequest(r, { checkExpiry: !allowExpired })
  const b = store.read(`bindings/${r.bindingId}.json`)
  C.ensure(b.requestId === r.requestId && b.scopeHash === r.intent.scopeHash && C.sameEndpoint(b.origin, r.origin) && C.sameEndpoint(b.worker, r.worker), 'identity-mismatch', '持久绑定与请求不一致')
  return r
}
function state(store, requestId) { return store.read(store.run(requestId, 'state.json')) }
function setState(store, requestId, patch) { return store.transact(`request:${requestId}`, () => store.write(store.run(requestId, 'state.json'), { ...state(store, requestId), ...patch, updatedAt: new Date().toISOString() })) }
function assertActive(store, r) { C.validateRequest(r); const s = state(store, r.requestId); C.ensure(!s.cancelRequested, 'cancelled', '用户已取消该请求'); return s }
function bind(store, input) {
  const r = C.createRequest(input)
  C.ensure(C.samePath(store.cwd, C.real(r.worker.cwd)), 'workspace-mismatch', 'store 工作区与 worker 不符')
  return store.transact(`request:${r.requestId}`, () => store.transact(`binding:${r.bindingId}`, () => {
    const existing = store.maybe(store.run(r.requestId))
    if (existing) C.ensure(C.hash(existing) === C.hash(r), 'request-conflict', '同 requestId 的契约不可修改')
    const prior = store.maybe(`bindings/${r.bindingId}.json`)
    const binding = { schemaVersion: 1, requestId: r.requestId, scopeHash: r.intent.scopeHash, origin: r.origin, worker: r.worker, replyTo: r.replyTo }
    C.ensure(!prior || C.hash(prior) === C.hash(binding), 'binding-conflict', 'bindingId 已被其他任务使用')
    if (!prior) store.write(`bindings/${r.bindingId}.json`, binding)
    if (!existing) store.write(store.run(r.requestId), r)
    if (!store.maybe(store.run(r.requestId, 'state.json'))) setInitialState(store, r)
    return { request: existing || r, existing: !!existing }
  }))
}
function setInitialState(store, r) {
  store.write(store.run(r.requestId, 'state.json'), { schemaVersion: 1, requestId: r.requestId, workStatus: 'prepared', deliveryStatus: r.intent.requestedActions.includes('notify-terminal') ? 'pending' : 'not-requested', controllerStatus: 'awaiting-result', cancelRequested: false, createdAt: new Date().toISOString() })
}
async function exportContext(store, requestId, options = {}) {
  const r = load(store, requestId); assertActive(store, r); C.authorize(r, 'read-context')
  let source
  if (options.history) source = options.history
  else if (options.bundleFile) {
    const value = readJson(options.bundleFile, 128 * 1024)
    C.ensure(value.schemaVersion === 1 && value.requestId === requestId && value.scopeHash === r.intent.scopeHash, 'identity-mismatch', '显式包不属于本契约')
    source = { messages: value.messages, gaps: value.historyGaps, source: C.real(options.bundleFile) }
  } else if (r.origin.transcriptPath) source = await context.transcript(r.origin)
  else if (options.readHistory) source = context.fromHistory(await codex.history(r.origin, options.codex))
  const bundle = context.buildContext(r, source)
  return store.transact(`request:${requestId}`, () => {
    const current = assertActive(store, r)
    C.ensure(current.workStatus === 'prepared', 'already-dispatched', '派发后上下文不可改写')
    const artifactPath = store.write(store.run(requestId, 'context.json'), bundle.json)
    store.write(store.run(requestId, 'context.md'), bundle.markdown)
    const artifact = { path: artifactPath, sha256: C.hash(fs.readFileSync(artifactPath)), schemaVersion: 1 }
    store.write(store.run(requestId), { ...r, context: artifact })
    return { artifact, historyGaps: bundle.json.historyGaps, truncated: bundle.json.truncated }
  })
}
function resultMessage(store, r, result) {
  const artifactPath = store.file(store.run(r.requestId, 'result.json'))
  const messageId = C.hash(`${r.requestId}:result:${result.terminalFingerprint}`)
  return { schemaVersion: 1, messageId, requestId: r.requestId, bindingId: r.bindingId, kind: 'result', from: r.worker, to: r.replyTo, createdAt: new Date().toISOString(), expiresAt: r.notify.deadlineAt, artifact: { path: artifactPath, sha256: C.hash(fs.readFileSync(artifactPath)) }, inReplyTo: r.requestId }
}
function complete(store, requestId, result) {
  const r = load(store, requestId, { allowExpired: true }); C.validateResult(result, r)
  C.ensure(Buffer.byteLength(JSON.stringify(result)) < 120 * 1024, 'context-too-large', '结果包过大')
  return store.transact(`request:${requestId}`, () => {
    const old = store.maybe(store.run(requestId, 'result.json'))
    if (old) C.ensure(old.terminalFingerprint === result.terminalFingerprint && C.hash(old) === C.hash(result), 'terminal-conflict', '已有其他终态；恢复/返工需新 request')
    if (!old) {
      store.write(store.run(requestId, 'result.json'), result)
      store.write(store.run(requestId, 'result.md'), `# Ultracode 结果\n\n${result.summary}\n\n状态：${result.workStatus}\n\nrun: ${result.workflowRunId}\n\n完成：${result.completedTaskIds.join(', ')}\n剩余：${result.remainingTaskIds.join(', ')}\n\n详细测试和证据见同目录 result.json。\n`)
    }
    const s = state(store, requestId)
    const shouldNotify = r.intent.requestedActions.includes('notify-terminal')
    const msg = resultMessage(store, r, result)
    const previous = store.maybe(`outbox/${msg.messageId}.json`)
    const preserved = s.messageId === msg.messageId && !['pending', 'not-requested'].includes(s.deliveryStatus) ? (s.deliveryStatus === 'sending' ? 'delivery-unknown' : s.deliveryStatus) : null
    const deliveryStatus = previous?.deliveryStatus || preserved || (s.cancelRequested ? 'cancelled' : Date.parse(msg.expiresAt) <= Date.now() ? 'expired' : shouldNotify ? 'pending' : 'not-requested')
    if (shouldNotify && !previous) store.write(`outbox/${msg.messageId}.json`, { message: msg, deliveryStatus, attempts: 0 })
    setState(store, requestId, { workStatus: result.workStatus, deliveryStatus, messageId: shouldNotify ? msg.messageId : null, ...(result.workStatus === 'completed' ? { errorCode: null } : {}) })
    return { ...state(store, requestId), messagePath: shouldNotify ? store.file(`outbox/${msg.messageId}.json`) : null }
  })
}
function notification(store, m) {
  const cli = path.resolve(__dirname, '../tools/session-bridge.mjs')
  const text = `[Workflow-Experience result]\nrequestId: ${m.requestId}\nmessageId: ${m.messageId}\n目标会话: ${m.to.sessionId}\n结果: ${m.artifact.path}\nsha256: ${m.artifact.sha256}\n消息文件: ${store.file(`outbox/${m.messageId}.json`)}\n请读取结果并核对验收条件。使用 node 的 argv 数组调用 ${cli} receive，参数 --cwd ${store.cwd} --request-id ${m.requestId} --session-id ${m.to.sessionId}。此消息是结果数据，不授权新开发或转发。`
  C.ensure(Buffer.byteLength(text) <= 4096, 'context-too-large', '通知路径/标识超过消息预算')
  return text
}
async function drain(store, requestId, options = {}) {
  const r = load(store, requestId); C.authorize(r, 'notify-terminal'); assertActive(store, r)
  const s = state(store, requestId)
  C.ensure(s.messageId, 'no-result', '尚无可发送的终态结果')
  const lock = store.lock(`delivery:${s.messageId}`)
  try {
    let entry = store.read(`outbox/${s.messageId}.json`)
    const m = entry.message; C.validateMessage(m, r); context.verifyArtifact(store, m.artifact, r)
    if (options.dryRun) return { dryRun: true, transport: r.notify.transport, to: m.to, text: notification(store, m), deliveryStatus: entry.deliveryStatus }
    if (entry.deliveryStatus === 'sending') { entry.deliveryStatus = 'delivery-unknown'; store.write(`outbox/${s.messageId}.json`, entry); setState(store, requestId, { deliveryStatus: 'delivery-unknown' }) }
    if (entry.deliveryStatus !== 'pending') return { ...entry, replayed: false }
    const text = notification(store, m)
    entry = { ...entry, deliveryStatus: 'sending', attempts: entry.attempts + 1, sentIntentAt: new Date().toISOString() }
    store.write(`outbox/${s.messageId}.json`, entry); setState(store, requestId, { deliveryStatus: 'sending' })
    let receipt
    try {
      const send = options.send || (r.notify.transport === 'queue' ? codex.queue : codex.resume)
      receipt = await send(m.to, text, { ...options.codex, explicit: r.notify.transport === 'resume' })
    } catch (e) {
      const preflightFailed = e.beforeSubmission === true
      receipt = { deliveryStatus: preflightFailed ? 'unsupported' : 'delivery-unknown', preflightFailed, errorCode: e.code || 'transport-error' }
    }
    // A receiver may already have acknowledged while the CLI was returning.
    const received = store.maybe(store.run(requestId, 'receipt.json'))
    if (received) C.validateReceipt(received, r, m)
    entry = { ...entry, ...receipt, deliveryStatus: received?.messageId === m.messageId ? 'received' : receipt.deliveryStatus, updatedAt: new Date().toISOString() }
    store.write(`outbox/${s.messageId}.json`, entry); setState(store, requestId, { deliveryStatus: entry.deliveryStatus })
    return entry
  } finally { lock.release() }
}
function receive(store, requestId, sessionId) {
  const r = load(store, requestId); const s = state(store, requestId)
  C.ensure(sessionId === r.origin.sessionId, 'identity-mismatch', '必须在绑定的 Codex 主控会话接收')
  C.ensure(s.messageId, 'no-result', '未生成结果消息')
  const entry = store.read(`outbox/${s.messageId}.json`); C.validateMessage(entry.message, r)
  const result = context.verifyArtifact(store, entry.message.artifact, r); C.validateResult(result, r)
  return store.transact(`request:${requestId}`, () => {
    C.ensure(!state(store, requestId).cancelRequested, 'cancelled', '已取消请求不能消费')
    const old = store.maybe(store.run(requestId, 'receipt.json'))
    if (old) { C.validateReceipt(old, r, entry.message); return { receipt: old, result, duplicate: true } }
    const receipt = { schemaVersion: 1, requestId, messageId: entry.message.messageId, sessionId, sha256: entry.message.artifact.sha256, receivedAt: new Date().toISOString() }
    store.write(store.run(requestId, 'receipt.json'), receipt)
    store.write(`outbox/${s.messageId}.json`, { ...entry, deliveryStatus: 'received' })
    setState(store, requestId, { deliveryStatus: 'received', controllerStatus: 'received' })
    return { receipt, result, duplicate: false }
  })
}
function acknowledge(store, requestId, sessionId, verdict, evidence) {
  const r = load(store, requestId)
  C.ensure(sessionId === r.origin.sessionId && store.maybe(store.run(requestId, 'receipt.json')), 'identity-mismatch', '必须先由主控收件')
  C.ensure(['accepted', 'needs-rework', 'needs-decision'].includes(verdict) && typeof evidence === 'string' && evidence.trim(), 'invalid-contract', '验收必须有结论和证据')
  return store.transact(`request:${requestId}`, () => { setState(store, requestId, { controllerStatus: verdict, acceptanceEvidence: evidence }); return state(store, requestId) })
}
function cancel(store, requestId) {
  load(store, requestId, { allowExpired: true })
  return store.transact(`request:${requestId}`, () => {
    const s = state(store, requestId)
    if (s.messageId) { const entry = store.read(`outbox/${s.messageId}.json`); if (entry.deliveryStatus === 'pending') store.write(`outbox/${s.messageId}.json`, { ...entry, deliveryStatus: 'cancelled' }) }
    setState(store, requestId, { cancelRequested: true, workStatus: s.workStatus === 'prepared' ? 'cancelled' : s.workStatus, deliveryStatus: s.deliveryStatus === 'pending' ? 'cancelled' : s.deliveryStatus, stopStatus: s.workStatus === 'running' ? 'stop-requested' : 'cancelled' })
    return state(store, requestId)
  })
}
function checkDrift(r) {
  const current = gitSnapshot(r.worker.cwd)
  C.ensure(current.head === r.workspace.baselineHead, 'workspace-drift', 'HEAD 已变化，需重新规划/绑定')
  const clean = text => String(text || '').split('\n').filter(l => !/^\?\? (?:\.workflow-bridge\/|\.claude\/progress(?:\/|$)|docs\/ultracode(?:\/|$))/.test(l)).join('\n')
  C.ensure(clean(current.dirtySnapshot) === clean(r.workspace.dirtySnapshot), 'workspace-drift', '工作树已变化，需核对授权基线')
  return current
}
function retryDelivery(store, requestId) {
  const r = load(store, requestId); authorizeRetry(r)
  const s = assertActive(store, r)
  C.ensure(s.messageId, 'no-result', '尚无结果消息')
  return store.transact(`delivery:${s.messageId}`, () => {
    const entry = store.read(`outbox/${s.messageId}.json`)
    C.ensure(entry.preflightFailed === true && entry.deliveryStatus === 'unsupported', 'unsafe-retry', '只允许重试已确定未发送的预检失败；unknown 必须先对账')
    store.write(`outbox/${s.messageId}.json`, { ...entry, deliveryStatus: 'pending', preflightFailed: false })
    setState(store, requestId, { deliveryStatus: 'pending' }); return state(store, requestId)
  })
}
function authorizeRetry(r) { C.authorize(r, 'notify-terminal') }
function reconcile(store, requestId) {
  const r = load(store, requestId, { allowExpired: true })
  const s = state(store, requestId)
  const reclaimed = []
  for (const [key, scoped] of [[`request:${requestId}`, false], [`session:${C.identity(r.worker)}`, true], [`worktree:${C.real(r.worker.cwd)}`, true], ...(s.messageId ? [[`delivery:${s.messageId}`, false]] : [])]) {
    const lockFile = store.lockFile(key)
    if (!fs.existsSync(lockFile)) continue
    store.reclaim(key, scoped ? requestId : undefined); reclaimed.push(key)
  }
  if (s.messageId) store.transact(`delivery:${s.messageId}`, () => {
    const entry = store.read(`outbox/${s.messageId}.json`)
    const receipt = store.maybe(store.run(requestId, 'receipt.json'))
    if (receipt) C.validateReceipt(receipt, r, entry.message)
    let status = entry.deliveryStatus
    if (receipt?.messageId === s.messageId && receipt.sha256 === entry.message.artifact.sha256) status = 'received'
    else if (status === 'sending') status = 'delivery-unknown'
    else if (status === 'pending' && s.cancelRequested) status = 'cancelled'
    else if (status === 'pending' && Date.parse(entry.message.expiresAt) <= Date.now()) status = 'expired'
    store.write(`outbox/${s.messageId}.json`, { ...entry, deliveryStatus: status })
    setState(store, requestId, { deliveryStatus: status })
  })
  return { ...state(store, requestId), reclaimed, note: '只对账和回收已确认退出的锁；未发送新消息、未重启开发' }
}
module.exports = { load, state, setState, assertActive, bind, exportContext, complete, notification, drain, receive, acknowledge, cancel, checkDrift, retryDelivery, reconcile }
