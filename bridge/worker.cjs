'use strict'
const fs = require('node:fs')
const path = require('node:path')
const C = require('./contracts.cjs')
const E = require('./engine.cjs')
const { alive, readJson } = require('./store.cjs')
const { spawnCommand, run } = require('./process.cjs')
const { verifyArtifact, verifySourceFiles } = require('./context.cjs')
const claude = require('./adapters/claude.cjs')
const workflow = require('./workflow.cjs')
const scheduler = require('./scheduler.cjs')
function launchClaimed(store, r, token) {
  let child
  const log = fs.openSync(store.file(store.run(r.requestId, 'runner.log')), 'a', 0o600)
  try {
    child = spawnCommand({ executable: process.execPath, prefix: [] }, [path.join(__dirname, 'runner.cjs'), '--cwd', store.cwd, '--store-root', store.root, '--request-id', r.requestId, '--token', token], { cwd: r.worker.cwd, detached: true, stdio: ['ignore', log, log] })
    child.on('error', () => { try { E.setState(store, r.requestId, { runnerStatus: 'launch-failed', workStatus: 'blocked', errorCode: 'runner-launch-failed' }) } catch {} })
    E.setState(store, r.requestId, { runnerPid: child.pid || null })
    child.unref()
  } finally { fs.closeSync(log) }
  return E.state(store, r.requestId)
}
function dispatch(store, requestId, options = {}) {
  const r = E.load(store, requestId); C.authorize(r, 'dispatch-work')
  verifyArtifact(store, r.context, r)
  const state = E.assertActive(store, r)
  if (['starting', 'running', 'queued'].includes(state.runnerStatus) || state.workStatus === 'completed') return { ...state, duplicate: true }
  if (options.resume) {
    if (state.workStatus === 'prepared' && r.control.resumeFromRequestId) {
      const prior = E.load(store, r.control.resumeFromRequestId, { allowExpired: true })
      const priorState = E.state(store, prior.requestId)
      C.ensure(C.sameEndpoint(prior.worker, r.worker) && priorState.runnerStatus === 'exited' && priorState.sessionBound === true && priorState.childExitKnown === true && store.maybe(store.run(prior.requestId, 'result.json')), 'unsafe-resume', '前序 request 没有可验证的终态 worker 身份')
      C.ensure(Number.isInteger(priorState.runnerPid) && Number.isInteger(priorState.childPid) && !alive(priorState.runnerPid) && !alive(priorState.childPid), 'owner-unknown', '前序 worker 仍存在或 PID 不完整')
    } else {
      C.ensure(state.runnerStatus === 'exited' && state.sessionBound === true && !state.workflowRunId && !store.maybe(store.run(requestId, 'result.json')), 'unsafe-resume', '同 request 只允许在尚未进入 Workflow 时恢复；新切片需 resumeFromRequestId')
      C.ensure(!alive(state.runnerPid) && !alive(state.childPid), 'owner-unknown', '先前运行者仍存在或身份不明')
    }
  } else C.ensure(state.workStatus === 'prepared', 'unsafe-retry', 'worker 已尝试执行，不可盲目重复派发')
  E.checkDrift(r); verifySourceFiles(store, r)
  if (options.dryRun) {
    const plan = scheduler.preview(store, r)
    const invocation = claude.workerInvocation(r, store.file(store.run(requestId)), { ...options, resume: plan.action === 'queue' || !!options.resume })
    return { dryRun: true, scheduler: plan, ...invocation }
  }
  const admitted = scheduler.admit(store, r, { resume: !!options.resume, validate: resume => claude.workerInvocation(r, store.file(store.run(requestId)), { ...options, resume }) })
  if (admitted.action === 'duplicate') return { ...E.state(store, requestId), duplicate: true }
  if (admitted.action === 'queue') return { ...E.state(store, requestId), queued: true }
  return launchClaimed(store, r, admitted.token)
}
function attachRun(store, requestId, runId, options = {}) {
  const r = E.load(store, requestId); E.assertActive(store, r)
  C.ensure(C.id(runId) && runId.startsWith('wf_'), 'invalid-reference', '需要真实 Workflow run ID')
  let record
  try { record = workflow.readRun(r, runId, options) } catch (e) { if (!['workflow-unavailable', 'ENOENT', 'missing-path'].includes(e.code)) throw e }
  return store.transact(`request:${requestId}`, () => {
    const state = E.state(store, requestId)
    C.ensure(!state.workflowRunId || state.workflowRunId === runId, 'run-conflict', '本 request 已绑定另一个 Workflow')
    C.ensure(!store.maybe(store.run(requestId, 'result.json')), 'already-completed', '已终态的任务不能重新绑定 run')
    require('./hooks.cjs').register(store, r, runId)
    E.setState(store, requestId, { workflowRunId: runId, workflowFile: record?.file || null, runVerification: record ? 'snapshot' : 'awaiting-snapshot', workStatus: 'running' })
    return { workflowRunId: runId, scriptPath: record?.run.scriptPath || null, terminalFingerprint: record?.terminalFingerprint || null, workStatus: record?.workStatus || 'running' }
  })
}
function completeVerified(store, requestId, result, options = {}) {
  const r = E.load(store, requestId, { allowExpired: true })
  const s = E.state(store, requestId)
  C.ensure(s.workflowRunId === result.workflowRunId, 'run-conflict', '结果 run 未经本任务绑定')
  const record = workflow.verifyResult(r, result, options)
  E.setState(store, requestId, { workflowFile: record.file, runVerification: 'terminal-snapshot', terminalFingerprint: record.terminalFingerprint })
  return E.complete(store, requestId, result)
}
async function runWorker(store, requestId, token, options = {}) {
  const r = E.load(store, requestId); const state = E.assertActive(store, r)
  C.ensure(state.launchToken === token && state.runnerStatus === 'starting', 'owner-mismatch', 'runner 启动身份不匹配')
  scheduler.ensureClaim(store, r, token)
  let sessionLock, worktreeLock, heartbeat
  try {
    sessionLock = store.lock(`session:${C.identity(r.worker)}`)
    worktreeLock = store.lock(`worktree:${C.real(r.worker.cwd)}`)
    sessionLock.update({ requestId, launchToken: token }); worktreeLock.update({ requestId, launchToken: token })
    const startedAt = new Date().toISOString()
    E.setState(store, requestId, { runnerStatus: 'running', runnerPid: process.pid, runnerStartedAt: startedAt })
    heartbeat = setInterval(() => { try { E.setState(store, requestId, { heartbeatAt: new Date().toISOString() }) } catch {} }, 10000)
    E.checkDrift(r)
    verifySourceFiles(store, r)
    const invocation = claude.workerInvocation(r, store.file(store.run(requestId)), { resume: state.resumeRequested })
    const maxMs = r.control.maxRuntimeMs || 60 * 60 * 1000
    C.ensure(Number.isInteger(maxMs) && maxMs >= 1000 && maxMs <= 12 * 60 * 60 * 1000, 'invalid-contract', 'maxRuntimeMs 必须为 1秒..12小时')
    const result = await (options.run || run)(options.command || 'claude', invocation.args, {
      cwd: invocation.cwd, stdin: invocation.stdin, timeoutMs: maxMs, maxBytes: 16 * 1024 * 1024,
      env: { ...process.env, WORKFLOW_BRIDGE_REQUEST_FILE: store.file(store.run(requestId)) },
      onChild: child => {
        E.setState(store, requestId, { childPid: child.pid, childStartedAt: new Date().toISOString() })
        sessionLock.update({ relatedPids: [child.pid] }); worktreeLock.update({ relatedPids: [child.pid] })
      },
    })
    store.write(store.run(requestId, 'worker-output.jsonl'), result.stdout)
    // Do not persist arbitrary auth/error HTML in the public status surface.
    let info
    try { info = claude.validateWorkerEvents(result, r.worker.sessionId) } catch (e) { info = { error: e.code, sessionId: null } }
    E.setState(store, requestId, { runnerStatus: 'exited', sessionBound: info.sessionId === r.worker.sessionId, workerExitCode: result.exitCode, errorCode: info.error, childExitKnown: !result.timedOut && !result.overflow })
    let s = E.state(store, requestId)
    if (!s.workflowRunId) {
      const found = workflow.discover(r, { ...options, startedAt })
      if (found.length === 1) { attachRun(store, requestId, found[0].run.runId, options); s = E.state(store, requestId) }
    }
    if (s.workflowRunId) {
      // The CLI may return before a background workflow finishes. Keep this durable
      // runner alive to collect its terminal snapshot; never equate CLI exit to done.
      const read = () => { try { return workflow.readRun(r, s.workflowRunId, options) } catch (e) { if (['workflow-unavailable', 'missing-path', 'ENOENT'].includes(e.code)) return { terminal: false, workStatus: null }; throw e } }
      let record = read()
      const deadline = Math.min(Date.parse(r.control.requestExpiry), Date.now() + (r.control.terminalWaitMs || 10 * 60 * 1000))
      while (!record.terminal && Date.now() < deadline && !E.state(store, requestId).cancelRequested) {
        await new Promise(resolve => setTimeout(resolve, 2000)); record = read()
      }
      if (record.workStatus) {
        if (!store.maybe(store.run(requestId, 'result.json'))) {
          const candidate = store.maybe(store.run(requestId, 'candidate-result.json'))
          if (candidate) completeVerified(store, requestId, candidate, options)
          else E.setState(store, requestId, { workStatus: 'blocked', errorCode: 'needs-result-evidence', terminalFingerprint: record.terminalFingerprint })
        }
      } else if (record.terminal) E.setState(store, requestId, { workStatus: 'blocked', errorCode: 'workflow-result-uninterpretable', terminalFingerprint: record.terminalFingerprint })
      else E.setState(store, requestId, { workStatus: 'blocked', errorCode: 'workflow-still-running', runnerStatus: 'waiting-external' })
    } else E.setState(store, requestId, { workStatus: 'blocked', errorCode: info.error || 'workflow-not-started' })
    if (store.maybe(store.run(requestId, 'result.json')) && !E.state(store, requestId).cancelRequested && r.intent.requestedActions.includes('notify-terminal')) {
      try { await E.drain(store, requestId, options) }
      catch (e) { E.setState(store, requestId, { deliveryErrorCode: e.code || 'delivery-error' }) }
    }
    return E.state(store, requestId)
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    // A timed-out process may have surviving Workflow children. Keep ownership
    // locks until explicit recovery proves the work is no longer running.
    const s = E.state(store, requestId)
    const noWriterStarted = !!(sessionLock && !worktreeLock && !s.childPid)
    const releasable = !!(sessionLock && worktreeLock && s.childExitKnown && s.errorCode !== 'workflow-still-running')
    if (releasable) { worktreeLock.release(); sessionLock.release() }
    else if (noWriterStarted) sessionLock.release()
    else {
      if (worktreeLock) worktreeLock.update({ workflowUnresolved: true })
      if (sessionLock) sessionLock.update({ workflowUnresolved: true })
    }
    const next = scheduler.finish(store, r, { unresolved: !releasable && !noWriterStarted, canResume: s.sessionBound === true })
    if (next) (options.launchNext || launchClaimed)(next.store, next.request, next.token)
  }
}
async function dispatchRelay(store, requestId, options = {}) {
  const r = E.load(store, requestId); C.authorize(r, 'dispatch-work'); E.assertActive(store, r)
  C.ensure(r.control.workerTransport === 'relay', 'action-not-authorized', '本契约未选择 relay')
  verifyArtifact(store, r.context, r)
  const text = `workflow ${r.work.requirement}\n这是用户明确授权的 Codex→Claude Code CLI 协作请求。请读取 request=${store.file(store.run(requestId))} 与 context=${r.context.path}，校验 sha256=${r.context.sha256}。先读插件 references/session-bridge.md，按 contract 执行 Ultracode，终态在外层 complete 并 drain 回绑定的 Codex 会话。不得转发给其他人或扩大授权。`
  C.ensure(Buffer.byteLength(text) <= 4096, 'context-too-large', 'relay 通知过长')
  if (options.dryRun) return { dryRun: true, to: r.worker, text, transport: 'relay' }
  const lock = store.lock(`dispatch:${requestId}`)
  try {
    const s = E.assertActive(store, r)
    if (s.dispatchStatus) return { ...s, duplicate: true }
    E.setState(store, requestId, { dispatchStatus: 'sending', runnerStatus: 'external', workStatus: 'running' })
    let receipt
    try { receipt = await (options.relay || claude.relay)(r.worker, text, { ...options, explicit: true, maxBudgetUsd: r.control.maxBudgetUsd }) }
    catch (e) { receipt = { deliveryStatus: e.code === 'unsupported' ? 'unsupported' : 'delivery-unknown', errorCode: e.code } }
    E.setState(store, requestId, { dispatchStatus: receipt.deliveryStatus, dispatchReceipt: receipt })
    return E.state(store, requestId)
  } finally { lock.release() }
}
function reconcileWorker(store, requestId, options = {}) {
  const ledger = E.reconcile(store, requestId)
  const r = E.load(store, requestId, { allowExpired: true })
  const scheduled = scheduler.reconcile(store, r)
  if (scheduled.next) (options.launchNext || launchClaimed)(scheduled.next.store, scheduled.next.request, scheduled.next.token)
  return { ...E.state(store, requestId), reclaimed: ledger.reclaimed, schedulerStatus: scheduled.schedulerStatus, nextRequestId: scheduled.next?.request.requestId || null, note: '只对账已知状态；不会重复发送或重跑当前 request' }
}
module.exports = { dispatch, dispatchRelay, attachRun, completeVerified, runWorker, launchClaimed, reconcileWorker }
