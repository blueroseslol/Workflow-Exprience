'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const C = require('./contracts.cjs')
const E = require('./engine.cjs')
const { Store, atomic, readJson, alive } = require('./store.cjs')
const context = require('./context.cjs')

const queueKey = r => C.hash(C.identity(r.worker))
const relative = (r, leaf) => `scheduler/${queueKey(r)}/${leaf}`
function runtime(store, r, leaf) {
  C.ensure(C.samePath(C.real(store.cwd), C.real(r.worker.cwd)), 'workspace-mismatch', 'scheduler 工作区不匹配')
  return store.runtimeFile(relative(r, leaf))
}
function ensureRuntime(store) {
  fs.mkdirSync(store.runtimeRoot, { recursive: true, mode: 0o700 })
  C.ensure(!fs.lstatSync(store.runtimeRoot).isSymbolicLink(), 'unsafe-store', '运行状态目录不能是链接')
}
function readSlot(store, r) {
  try { return readJson(runtime(store, r, 'active.json')) } catch (e) { if (e.code === 'ENOENT') return null; throw e }
}
function pending(store, r) {
  const dir = runtime(store, r, 'pending')
  try { return fs.readdirSync(dir).filter(n => /^[a-zA-Z0-9_-]+\.json$/.test(n)).map(n => readJson(path.join(dir, n))).sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt) || a.requestId.localeCompare(b.requestId)) } catch (e) { if (e.code === 'ENOENT') return []; throw e }
}
function preview(store, r) {
  const slot = readSlot(store, r)
  if (!slot) return { action: 'launch', resume: false }
  C.ensure(slot.worker && C.sameEndpoint(slot.worker, r.worker), 'workspace-mismatch', '同一 Claude session 已绑定其他 worktree')
  if (slot.requestId === r.requestId) return { action: 'duplicate', slot }
  return { action: 'queue', position: pending(store, r).length + 1, activeRequestId: slot.requestId, resume: true }
}
function admit(store, r, { resume = false, dryRun = false, validate } = {}) {
  ensureRuntime(store)
  const key = `scheduler:${C.identity(r.worker)}`
  return store.transact(key, () => {
    const plan = preview(store, r)
    if (plan.action !== 'duplicate') validate?.(plan.action === 'queue' || !!resume)
    if (dryRun) return plan
    if (plan.action === 'duplicate') return plan
    if (plan.action === 'queue') {
      const state = E.assertActive(store, r)
      C.ensure(state.workStatus === 'prepared' || state.runnerStatus === 'queued', 'unsafe-retry', '只有未执行请求可以进入 inbox')
      C.ensure(r.control.resumeFromRequestId === plan.activeRequestId, 'scope-mismatch', 'inbox request 必须明确引用当前 active request')
      const entry = { schemaVersion: 1, requestId: r.requestId, scopeHash: r.intent.scopeHash, storeRoot: store.root, worker: r.worker, enqueuedAt: new Date().toISOString(), resume: true }
      const file = runtime(store, r, `pending/${r.requestId}.json`)
      if (fs.existsSync(file)) C.ensure(C.hash(readJson(file)) === C.hash(entry), 'request-conflict', 'inbox 中已有不同请求记录')
      else atomic(file, entry)
      E.setState(store, r.requestId, { runnerStatus: 'queued', queuePosition: plan.position, activeRequestId: plan.activeRequestId })
      return { ...plan, queued: true }
    }
    const token = crypto.randomUUID()
    const slot = { schemaVersion: 1, requestId: r.requestId, scopeHash: r.intent.scopeHash, storeRoot: store.root, worker: r.worker, token, phase: 'reserved', reservedAt: new Date().toISOString(), resume: !!resume }
    atomic(runtime(store, r, 'active.json'), slot)
    E.setState(store, r.requestId, { runnerStatus: 'starting', launchToken: token, workStatus: 'running', resumeRequested: !!resume, queuePosition: null, activeRequestId: r.requestId })
    return { action: 'launch', token, resume: !!resume }
  })
}
function ensureClaim(store, r, token) {
  ensureRuntime(store)
  return store.transact(`scheduler:${C.identity(r.worker)}`, () => {
    let slot = readSlot(store, r)
    if (!slot) {
      slot = { schemaVersion: 1, requestId: r.requestId, scopeHash: r.intent.scopeHash, storeRoot: store.root, worker: r.worker, token, phase: 'reserved', reservedAt: new Date().toISOString(), resume: !!E.state(store, r.requestId).resumeRequested }
    }
    C.ensure(slot.requestId === r.requestId && slot.scopeHash === r.intent.scopeHash && slot.token === token && C.sameEndpoint(slot.worker, r.worker) && C.samePath(path.resolve(slot.storeRoot), store.root), 'owner-mismatch', 'scheduler 运行者身份不匹配')
    slot = { ...slot, phase: 'running', runnerPid: process.pid, startedAt: new Date().toISOString() }
    atomic(runtime(store, r, 'active.json'), slot)
    return slot
  })
}
function finish(store, r, { unresolved = false, canResume = true } = {}) {
  ensureRuntime(store)
  return store.transact(`scheduler:${C.identity(r.worker)}`, () => {
    let slot = readSlot(store, r)
    if (!slot) return null
    C.ensure(slot.requestId === r.requestId && C.sameEndpoint(slot.worker, r.worker), 'owner-mismatch', '不能结束其他 scheduler 运行者')
    if (unresolved || (!canResume && pending(store, r).length)) {
      atomic(runtime(store, r, 'active.json'), { ...slot, phase: 'unresolved', unresolvedAt: new Date().toISOString() })
      return null
    }
    for (const entry of pending(store, r)) {
      const entryFile = runtime(store, r, `pending/${entry.requestId}.json`)
      let nextStore, next
      try {
        C.ensure(entry.schemaVersion === 1 && entry.scopeHash && C.sameEndpoint(entry.worker, r.worker), 'identity-mismatch', 'inbox 目标不匹配')
        nextStore = new Store(r.worker.cwd, entry.storeRoot)
        next = E.load(nextStore, entry.requestId)
        C.ensure(next.intent.scopeHash === entry.scopeHash && C.sameEndpoint(next.worker, r.worker), 'identity-mismatch', 'inbox request 身份不匹配')
        E.assertActive(nextStore, next)
        E.checkDrift(next); context.verifySourceFiles(nextStore, next)
      } catch (e) {
        if (nextStore && C.id(entry.requestId)) try { E.setState(nextStore, entry.requestId, { workStatus: 'blocked', runnerStatus: 'queue-blocked', errorCode: e.code || 'queue-invalid' }) } catch {}
        fs.unlinkSync(entryFile)
        continue
      }
      const token = crypto.randomUUID()
      const nextSlot = { schemaVersion: 1, requestId: next.requestId, scopeHash: next.intent.scopeHash, storeRoot: nextStore.root, worker: next.worker, token, phase: 'reserved', reservedAt: new Date().toISOString(), resume: true }
      atomic(runtime(nextStore, next, 'active.json'), nextSlot)
      fs.unlinkSync(entryFile)
      E.setState(nextStore, next.requestId, { runnerStatus: 'starting', launchToken: token, workStatus: 'running', resumeRequested: true, queuePosition: null, activeRequestId: next.requestId })
      return { store: nextStore, request: next, token }
    }
    fs.unlinkSync(runtime(store, r, 'active.json'))
    return null
  })
}
function reconcile(store, r) {
  ensureRuntime(store)
  return store.transact(`scheduler:${C.identity(r.worker)}`, () => {
    const slot = readSlot(store, r)
    if (!slot) return { next: null, schedulerStatus: 'idle' }
    if (slot.requestId !== r.requestId) return { next: null, schedulerStatus: 'queued-behind', activeRequestId: slot.requestId }
    C.ensure(slot.scopeHash === r.intent.scopeHash && C.sameEndpoint(slot.worker, r.worker), 'owner-mismatch', 'scheduler slot 身份不匹配')
    const state = E.state(store, r.requestId)
    const runnerPid = Number.isInteger(slot.runnerPid) ? slot.runnerPid : state.runnerPid
    C.ensure(Number.isInteger(runnerPid) && !alive(runnerPid), 'owner-unknown', 'scheduler runner 仍活跃或 PID 未知')
    if (Number.isInteger(state.childPid)) C.ensure(!alive(state.childPid), 'owner-unknown', 'Claude 子进程仍活跃')
    C.ensure(slot.phase !== 'unresolved' && state.errorCode !== 'workflow-still-running', 'owner-unknown', 'Workflow/会话所有权尚未解析')
    C.ensure(state.childExitKnown === true || store.maybe(store.run(r.requestId, 'result.json')), 'owner-unknown', '无法证明子进程已经退出')
    return { next: finish(store, r, { canResume: state.sessionBound === true }), schedulerStatus: 'reconciled' }
  })
}
module.exports = { preview, admit, ensureClaim, finish, reconcile, readSlot, pending }
