'use strict'
const fs = require('node:fs')
const crypto = require('node:crypto')
const C = require('./contracts.cjs')
const E = require('./engine.cjs')
const X = require('./context.cjs')
const { atomic, readJson, alive } = require('./store.cjs')

const sessionFile = (store, sessionId) => {
  C.ensure(C.id(sessionId), 'identity-mismatch', '缺少 Claude 提供的 session ID')
  return store.runtimeFile(`channels/${sessionId}.json`)
}
function sessionEvent(store, sessionId, event) {
  C.ensure(['SessionStart', 'SessionEnd'].includes(event), 'invalid-event', '未知 session hook')
  const file = sessionFile(store, sessionId)
  const record = { schemaVersion: 1, sessionId, cwd: store.cwd, active: event === 'SessionStart', epoch: crypto.randomUUID(), updatedAt: new Date().toISOString() }
  store.transact(`channel:registration:${sessionId}`, () => atomic(file, record))
  return record
}
function registration(store, sessionId) {
  try { return readJson(sessionFile(store, sessionId)) } catch (e) { if (e.code === 'ENOENT') return null; throw e }
}
function makeMessage(store, r) {
  const messageId = C.hash(`${r.requestId}:channel:${r.intent.scopeHash}`)
  const body = {
    schemaVersion: 1, messageId, requestId: r.requestId, bindingId: r.bindingId,
    sessionId: r.worker.sessionId, cwd: r.worker.cwd, scopeHash: r.intent.scopeHash,
    requestPath: store.file(store.run(r.requestId)), context: r.context,
    requirement: r.work.requirement, expiresAt: r.control.requestExpiry,
  }
  return { ...body, sha256: C.hash(body) }
}
function validateMessage(store, r, m) {
  C.ensure(m && C.hash(makeMessage(store, r)) === C.hash(m), 'identity-mismatch', 'Channel 消息身份或内容哈希不匹配')
  X.verifyArtifact(store, r.context, r)
}
function dispatch(store, requestId, options = {}) {
  const r = E.load(store, requestId); C.authorize(r, 'dispatch-work'); E.assertActive(store, r)
  C.ensure(r.control.workerTransport === 'channel', 'action-not-authorized', '本契约未选择 channel')
  X.verifyArtifact(store, r.context, r)
  if (E.state(store, requestId).channelMessage) return { ...status(store, requestId), duplicate: true }
  E.checkDrift(r); X.verifySourceFiles(store, r)
  const m = makeMessage(store, r)
  if (options.dryRun) return { dryRun: true, transport: 'channel', message: m, channel: registration(store, r.worker.sessionId), note: '注册不证明 Channel 已启用，只有目标 ACK 才确认收到' }
  return store.transact(`request:${requestId}`, () => {
    const s = E.assertActive(store, r)
    if (s.channelMessage) return { ...status(store, requestId), duplicate: true }
    C.ensure(s.workStatus === 'prepared' && !s.dispatchStatus, 'unsafe-retry', '任务已派发')
    E.setState(store, requestId, { channelMessage: m, dispatchStatus: 'queued', runnerStatus: 'external', queuedAt: new Date().toISOString() })
    return status(store, requestId)
  })
}
function status(store, requestId, now = Date.now()) {
  const s = E.state(store, requestId)
  if (!s.channelMessage) return s
  const r = E.load(store, requestId, { allowExpired: true })
  let dispatchStatus = s.dispatchStatus
  if (!s.workerReceipt && !s.workerRejection) {
    if (s.cancelRequested) dispatchStatus = 'cancelled'
    else if (Date.parse(r.control.requestExpiry) <= now) dispatchStatus = 'expired'
    else if (now - Date.parse(s.emittedAt || s.queuedAt) >= (r.control.receiptTimeoutMs || 120000)) dispatchStatus = 'receipt-timeout'
  }
  const reg = registration(store, r.worker.sessionId)
  const channelOnline = !!(reg?.active && reg.connectionId && C.samePath(reg.cwd, store.cwd) && now - Date.parse(reg.heartbeatAt) < 10000 && alive(reg.pid))
  return { ...s, dispatchStatus, channelOnline, channelErrorCode: reg?.errorCode || null, receiptConfirmed: !!s.workerReceipt, dispatchPhase: s.dispatchStatus }
}

class Receiver {
  constructor(store, sessionId) {
    sessionFile(store, sessionId)
    this.store = store; this.sessionId = sessionId; this.connectionId = crypto.randomUUID(); this.epoch = null; this.armed = false
    const key = `channel:claude:local:${sessionId}`
    try { this.lock = store.lock(key) } catch (e) {
      if (e.code !== 'busy') throw e
      // Reclaim only the dead transport, never resume/replay its emitted work.
      store.reclaim(key); this.lock = store.lock(key)
    }
  }
  ready() {
    const reg = registration(this.store, this.sessionId)
    if (!reg?.active || !C.samePath(reg.cwd, this.store.cwd)) return false
    if (this.epoch && this.epoch !== reg.epoch) return false
    this.epoch ||= reg.epoch
    return true
  }
  assertReady() { C.ensure(this.ready(), 'identity-mismatch', '会话已结束、切换或尚未运行 SessionStart；请使用明确 ID 重启恢复') }
  connect() {
    this.assertReady(); this.armed = true; this.heartbeat()
    return { sessionId: this.sessionId, cwd: this.store.cwd, connectionId: this.connectionId, status: 'connected', note: '仍需启动时启用 Channel；目标 ACK 才证明消息到达' }
  }
  heartbeat() {
    if (!this.armed) return false
    return this.store.transact(`channel:registration:${this.sessionId}`, () => {
      if (!this.ready()) return false
      const reg = registration(this.store, this.sessionId)
      atomic(sessionFile(this.store, this.sessionId), { ...reg, connectionId: this.connectionId, pid: process.pid, heartbeatAt: new Date().toISOString() })
      return true
    })
  }
  reportError(errorCode) {
    this.store.transact(`channel:registration:${this.sessionId}`, () => {
      const reg = registration(this.store, this.sessionId)
      if (reg?.connectionId === this.connectionId) atomic(sessionFile(this.store, this.sessionId), { ...reg, errorCode })
    })
  }
  entries() {
    this.assertReady()
    const dir = this.store.file('runs')
    if (!fs.existsSync(dir)) return []
    const rows = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !C.id(entry.name)) continue
      const s = this.store.maybe(this.store.run(entry.name, 'state.json'))
      if (!s?.channelMessage || s.channelMessage.sessionId !== this.sessionId) continue
      const r = E.load(this.store, entry.name, { allowExpired: true })
      C.ensure(C.samePath(C.real(r.worker.cwd), this.store.cwd), 'workspace-mismatch', 'Channel 工作区不匹配')
      validateMessage(this.store, r, s.channelMessage)
      rows.push({ r, s })
    }
    return rows.sort((a, b) => a.s.queuedAt.localeCompare(b.s.queuedAt) || a.r.requestId.localeCompare(b.r.requestId))
  }
  pending() {
    return this.entries().map(({ r }) => status(this.store, r.requestId)).map(s => ({ requestId: s.requestId, message: s.channelMessage, dispatchStatus: s.dispatchStatus, workStatus: s.workStatus, receiptConfirmed: s.receiptConfirmed }))
  }
  async pump(notify, options = {}) {
    if (!this.heartbeat()) return
    await this.flushResults(options)
    const rows = this.entries()
    // Once possibly delivered, a request owns this queue slot until a verified
    // result exists. Cancel/timeout/disconnect alone cannot prove execution stopped.
    if (rows.some(({ r, s }) => {
      if (!s.emittedAt || s.workerRejection) return false
      const result = this.store.maybe(this.store.run(r.requestId, 'result.json'))
      if (!result || s.runVerification !== 'terminal-snapshot') return true
      C.validateResult(result, r)
      require('./workflow.cjs').verifyResult(r, result, {})
      return false
    })) return
    const next = rows.find(({ r, s }) => s.dispatchStatus === 'queued' && !s.cancelRequested && Date.parse(r.control.requestExpiry) > Date.now() && !this.store.maybe(this.store.run(r.requestId, 'result.json')))
    if (!next) return
    const { r } = next
    let m
    this.store.transact(`request:${r.requestId}`, () => {
      this.assertReady()
      const s = E.assertActive(this.store, r)
      if (s.dispatchStatus !== 'queued') return
      E.checkDrift(r); X.verifySourceFiles(this.store, r)
      m = s.channelMessage; validateMessage(this.store, r, m)
      // Write intent BEFORE notification: crash at any later point is uncertain,
      // never automatically replayed, including after server restart.
      E.setState(this.store, r.requestId, { dispatchStatus: 'awaiting-receipt', workStatus: 'awaiting-receipt', emittedAt: new Date().toISOString(), channelConnectionId: this.connectionId })
    })
    if (!m) return
    await notify({
      content: `用户已授权的 Workflow Bridge 请求。先调用 bridge_ack，传 requestId/messageId/sha256；只有返回 execute:true 才执行。重复回执 execute:false 时禁止重跑。收到不代表任务已完成。\n${JSON.stringify(m)}\n执行前读取 requestPath、校验 context，并阅读插件 skills/workflow-experience/references/session-bridge.md。只按契约范围运行 Workflow，外层用 bridge_attach_run 绑定并等待真实终态，写同目录 candidate-result.json 后 bridge_complete。插件负责回传；不得让子代理直接执行 codex queue。通知失败只补 bridge_drain，不重跑开发。`,
      meta: { request_id: m.requestId, message_id: m.messageId, sha256: m.sha256 },
    })
  }
  acknowledge({ requestId, messageId, sha256 } = {}) {
    this.assertReady()
    C.ensure(this.armed, 'channel-not-connected', '先调用 bridge_connect 接入本会话')
    const store = this.store
    return store.transact(`request:${requestId}`, () => {
      this.assertReady()
      const r = E.load(store, requestId); const s = E.assertActive(store, r)
      C.ensure(r.control.workerTransport === 'channel' && r.worker.sessionId === this.sessionId && C.samePath(C.real(r.worker.cwd), store.cwd), 'identity-mismatch', '回执不属于本 Channel 会话')
      validateMessage(store, r, s.channelMessage)
      C.ensure(!s.workerRejection, 'refused', '目标已拒绝本消息')
      C.ensure(s.channelMessage.messageId === messageId && s.channelMessage.sha256 === sha256, 'identity-mismatch', '回执 ID/hash 不匹配')
      C.ensure(s.emittedAt, 'not-delivered', '尚未向目标发布消息')
      if (s.workerReceipt) return { receipt: s.workerReceipt, duplicate: true, execute: false, note: '已接收，禁止重新执行；如先前崩溃应先核对 Workflow' }
      E.checkDrift(r); X.verifySourceFiles(store, r)
      const receipt = { schemaVersion: 1, requestId, messageId, sha256, sessionId: this.sessionId, cwd: store.cwd, connectionId: this.connectionId, receivedAt: new Date().toISOString() }
      E.setState(store, requestId, { workerReceipt: receipt, dispatchStatus: 'received', workStatus: 'received' })
      return { receipt, duplicate: false, execute: true }
    })
  }
  reject({ requestId, messageId, sha256, reason } = {}) {
    this.assertReady()
    C.ensure(this.armed, 'channel-not-connected', '先调用 bridge_connect')
    C.ensure(typeof reason === 'string' && reason.trim().length && reason.length <= 2000, 'invalid-contract', '需要简短拒收原因')
    const store = this.store
    return store.transact(`request:${requestId}`, () => {
      this.assertReady()
      const r = E.load(store, requestId, { allowExpired: true }); const s = E.state(store, requestId)
      C.ensure(r.control.workerTransport === 'channel' && r.worker.sessionId === this.sessionId && C.samePath(C.real(r.worker.cwd), store.cwd), 'identity-mismatch', '拒收不属于本会话')
      validateMessage(store, r, s.channelMessage)
      C.ensure(s.channelMessage.messageId === messageId && s.channelMessage.sha256 === sha256, 'identity-mismatch', '拒收 ID/hash 不匹配')
      C.ensure(!s.workerReceipt && !s.workflowRunId, 'already-received', '已确认或启动的任务必须通过真实 Workflow 终态关闭')
      if (s.workerRejection) return { rejection: s.workerRejection, duplicate: true, execute: false }
      const rejection = { sessionId: this.sessionId, connectionId: this.connectionId, messageId, sha256, reason, rejectedAt: new Date().toISOString() }
      E.setState(store, requestId, { workerRejection: rejection, dispatchStatus: 'refused', workStatus: 'blocked' })
      return { rejection, execute: false }
    })
  }
  workerRequest(requestId) {
    this.assertReady()
    C.ensure(this.armed, 'channel-not-connected', '先调用 bridge_connect')
    const r = E.load(this.store, requestId, { allowExpired: true })
    C.ensure(r.control.workerTransport === 'channel' && r.worker.sessionId === this.sessionId && C.samePath(C.real(r.worker.cwd), this.store.cwd), 'identity-mismatch', '任务不属于本 Channel')
    C.ensure(E.state(this.store, requestId).workerReceipt, 'receipt-required', '先由目标 ACK')
    return r
  }
  attachRun(requestId, runId, options = {}) {
    this.workerRequest(requestId)
    return require('./worker.cjs').attachRun(this.store, requestId, runId, options)
  }
  async complete(requestId, options = {}) {
    this.workerRequest(requestId)
    const result = this.store.read(this.store.run(requestId, 'candidate-result.json'))
    require('./worker.cjs').completeVerified(this.store, requestId, result, options)
    return this.drain(requestId, options)
  }
  async drain(requestId, options = {}) {
    const r = this.workerRequest(requestId)
    C.ensure(this.store.maybe(this.store.run(requestId, 'result.json')), 'no-result', '仅重试通知，必须已有验证结果')
    if (!r.intent.requestedActions.includes('notify-terminal')) return status(this.store, requestId)
    try {
      if (options.retryPreflight === true) E.retryDelivery(this.store, requestId)
      await E.drain(this.store, requestId, options)
    } catch (e) {
      E.setState(this.store, requestId, { deliveryErrorCode: e.code || 'delivery-error', ...(e.code === 'expired' ? { deliveryStatus: 'expired' } : {}) })
    }
    return status(this.store, requestId)
  }
  async flushResults(options = {}) {
    // Deterministic completion watcher: a model that only writes the candidate
    // cannot accidentally omit notification. A markdown report alone is NOT
    // sufficient evidence; the bound Workflow and Result v1 must verify first.
    for (const { r, s } of this.entries()) {
      if (!s.workerReceipt || !s.workflowRunId || s.cancelRequested) continue
      let result = this.store.maybe(this.store.run(r.requestId, 'result.json'))
      const candidate = !result && this.store.maybe(this.store.run(r.requestId, 'candidate-result.json'))
      if (!result && !candidate) {
        try {
          const record = require('./workflow.cjs').readRun(r, s.workflowRunId, options)
          if (record.terminal && s.errorCode !== 'needs-result-evidence') E.setState(this.store, r.requestId, { workStatus: 'blocked', errorCode: 'needs-result-evidence' })
        } catch (e) { if (!['workflow-unavailable', 'missing-path', 'ENOENT'].includes(e.code)) throw e }
      }
      if (candidate) {
        require('./worker.cjs').completeVerified(this.store, r.requestId, candidate, options)
        result = candidate
      }
      if (result && E.state(this.store, r.requestId).deliveryStatus === 'pending') await this.drain(r.requestId, options)
    }
  }
  close() {
    if (this.lock) { this.lock.release(); this.lock = null }
    this.store.transact(`channel:registration:${this.sessionId}`, () => {
      const reg = registration(this.store, this.sessionId)
      if (reg?.connectionId === this.connectionId) atomic(sessionFile(this.store, this.sessionId), { ...reg, connectionId: null, heartbeatAt: null })
    })
  }
}
module.exports = { sessionEvent, registration, dispatch, status, Receiver }
