'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { Store, readJson } = require('./store.cjs')
const C = require('./contracts.cjs')
const E = require('./engine.cjs')
const W = require('./worker.cjs')
const workflow = require('./workflow.cjs')
function register(store, r, runId) {
  const markers = new Store(store.cwd, undefined, { create: true })
  const claim = { schemaVersion: 1, requestId: r.requestId, runId, sessionId: r.worker.sessionId, scopeHash: r.intent.scopeHash, storeRoot: store.root }
  markers.transact(`workflow-run:${r.worker.sessionId}:${runId}`, () => {
    const file = `workflow-runs/${r.worker.sessionId}/${runId}.json`
    const prior = markers.maybe(file)
    C.ensure(!prior || C.hash(prior) === C.hash(claim), 'run-conflict', '该 Workflow run 已绑定其他 request')
    if (!prior) markers.write(file, claim)
    markers.write(`sessions/${r.worker.sessionId}.json`, { requestId: r.requestId, runId, storeRoot: store.root })
  })
  return claim
}
function resolveContract(cwd, sessionId, runId, requestFile = process.env.WORKFLOW_BRIDGE_REQUEST_FILE) {
  if (!C.id(sessionId)) return null
  let store, requestId
  if (requestFile) {
    const input = readJson(requestFile)
    requestId = input.requestId
    store = new Store(cwd, path.resolve(path.dirname(requestFile), '../..'))
    C.ensure(C.samePath(store.file(store.run(requestId)), path.resolve(requestFile)), 'identity-mismatch', 'request 环境变量位置不匹配')
  } else {
    const markers = new Store(cwd)
    const marker = markers.maybe(`sessions/${sessionId}.json`)
    if (!marker || marker.runId !== runId) return null
    store = new Store(cwd, marker.storeRoot); requestId = marker.requestId
  }
  const r = E.load(store, requestId, { allowExpired: true })
  if (r.worker.sessionId !== sessionId || !C.samePath(C.real(r.worker.cwd), C.real(cwd))) return null
  const s = E.state(store, requestId)
  if (s.workflowRunId !== runId) return null
  return { store, r }
}
function onHarvest({ cwd, sessionId, runId, run }) {
  const contract = resolveContract(cwd, sessionId, runId)
  if (!contract || !workflow.terminalStatus(run)) return { enabled: false }
  const { store, r } = contract
  const evidence = { schemaVersion: 1, requestId: r.requestId, workflowRunId: runId, workStatus: workflow.terminalStatus(run), terminalFingerprint: workflow.fingerprint({ ...run, runId }), observedAt: new Date().toISOString() }
  store.write(store.run(r.requestId, 'terminal.json'), evidence)
  const candidate = store.maybe(store.run(r.requestId, 'candidate-result.json'))
  if (candidate && !store.maybe(store.run(r.requestId, 'result.json'))) return W.completeVerified(store, r.requestId, candidate)
  return { enabled: true, terminalRecorded: true }
}
module.exports = { register, resolveContract, onHarvest }
