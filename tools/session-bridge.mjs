#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const C = require('../bridge/contracts.cjs')
const { Store, readJson } = require('../bridge/store.cjs')
const E = require('../bridge/engine.cjs')
const worker = require('../bridge/worker.cjs')
const workflow = require('../bridge/workflow.cjs')
const P = require('../bridge/process.cjs')
const claude = require('../bridge/adapters/claude.cjs')
const { validateDecision } = require('../bridge/intent.cjs')
const COMMANDS = ['help', 'doctor', 'bind', 'export-context', 'dispatch', 'complete', 'drain', 'send', 'receive', 'status', 'cancel', 'attach-run', 'inspect-run', 'acknowledge', 'resolve-target', 'validate-intent', 'retry-delivery', 'reconcile']
export function parseArgs(argv) {
  const [first, ...rest] = argv
  const command = first === '--help' || !first ? 'help' : first
  C.ensure(COMMANDS.includes(command), 'usage', `命令：${COMMANDS.join(', ')}`)
  const options = {}
  const flags = new Set(['dry-run', 'read-history', 'resume'])
  const values = new Set(['cwd', 'store-root', 'request-id', 'request-file', 'result-file', 'message-file', 'bundle-file', 'session-id', 'run-id', 'verdict', 'evidence', 'name', 'decision-file', 'prompt-file'])
  for (let i = 0; i < rest.length; i++) {
    C.ensure(rest[i].startsWith('--'), 'usage', '参数必须为 --key value')
    const key = rest[i].slice(2)
    C.ensure(!(key in options) && (flags.has(key) || values.has(key)), 'usage', `未知或重复参数 ${key}`)
    if (flags.has(key)) options[key] = true
    else { C.ensure(typeof rest[i + 1] === 'string' && !rest[i + 1].startsWith('--'), 'usage', `缺少 ${key} 值`); options[key] = rest[++i] }
  }
  const allowed = {
    help: [], doctor: [], bind: ['request-file', 'dry-run'], 'export-context': ['read-history', 'bundle-file'], dispatch: ['dry-run', 'resume'], complete: ['result-file'], drain: ['dry-run'], send: ['message-file', 'dry-run'], receive: ['message-file', 'session-id'], status: [], cancel: [], 'attach-run': ['run-id'], 'inspect-run': ['run-id'], acknowledge: ['session-id', 'verdict', 'evidence'], 'resolve-target': ['name'], 'validate-intent': ['decision-file', 'prompt-file'], 'retry-delivery': [], reconcile: [],
  }
  for (const key of Object.keys(options)) C.ensure(['cwd', 'store-root', 'request-id', 'request-file', ...allowed[command]].includes(key), 'usage', `${command} 不支持 --${key}`)
  return { command, options }
}
export async function main(argv) {
  const { command, options: o } = parseArgs(argv)
  const cwd = path.resolve(o.cwd || process.cwd())
  if (command === 'help') return { commands: COMMANDS, common: ['--cwd <worker-dir>', '--request-id <id>'], guide: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs/codex-controller.md') }
  if (command === 'doctor') {
    const capabilities = {}
    for (const name of ['codex', 'claude']) {
      try {
        const executable = P.resolveExecutable(name)
        const v = await P.run(executable, ['--version'], { cwd })
        const h = await P.run(executable, name === 'codex' ? ['queue', '--help'] : ['--help'], { cwd })
        capabilities[name] = { ...executable, version: v.stdout.trim(), available: v.exitCode === 0, queue: name === 'codex' && /--thread/.test(h.stdout), print: name === 'claude' && /--print/.test(h.stdout), runtimeVerified: false }
      } catch (e) { capabilities[name] = { available: false, error: e.code } }
    }
    return { node: process.version, platform: process.platform, capabilities, note: '版本/帮助探测，不启动模型；queue 不等于自动唤醒' }
  }
  if (command === 'resolve-target') {
    C.ensure(o.name, 'usage', '需要 --name 与 --cwd')
    return C.resolveName(o.name, 'claude', cwd, await claude.candidates(cwd))
  }
  if (command === 'validate-intent') {
    const fs = require('node:fs')
    return validateDecision(readJson(o['decision-file']), fs.readFileSync(o['prompt-file'], 'utf8'))
  }
  const store = new Store(cwd, o['store-root'], { create: command === 'bind' && !o['dry-run'] })
  if (command === 'bind') {
    const input = readJson(o['request-file'])
    return o['dry-run'] ? { dryRun: true, request: C.createRequest(input) } : E.bind(store, input)
  }
  let requestId = o['request-id']
  if (o['request-file']) { const requested = readJson(o['request-file']); requestId ||= requested.requestId; C.ensure(requestId === requested.requestId, 'identity-mismatch', 'request 参数冲突') }
  if (o['message-file']) { const value = readJson(o['message-file']); const message = value.message || value; requestId ||= message.requestId; const r = E.load(store, requestId); C.validateMessage(message, r); C.ensure(message.messageId === E.state(store, requestId).messageId, 'identity-mismatch', '不是本任务待发送消息') }
  C.ensure(C.id(requestId), 'usage', '需要 --request-id 或 --request-file')
  if (command === 'status') { E.load(store, requestId, { allowExpired: true }); return E.state(store, requestId) }
  if (command === 'export-context') return E.exportContext(store, requestId, { readHistory: o['read-history'], bundleFile: o['bundle-file'] })
  if (command === 'dispatch') {
    const r = E.load(store, requestId)
    return r.control.workerTransport === 'relay' ? worker.dispatchRelay(store, requestId, { dryRun: o['dry-run'] }) : worker.dispatch(store, requestId, { dryRun: o['dry-run'], resume: o.resume })
  }
  if (command === 'complete') return worker.completeVerified(store, requestId, readJson(o['result-file']))
  if (command === 'drain' || command === 'send') return E.drain(store, requestId, { dryRun: o['dry-run'] })
  if (command === 'receive') return E.receive(store, requestId, o['session-id'] || process.env.CODEX_THREAD_ID)
  if (command === 'acknowledge') return E.acknowledge(store, requestId, o['session-id'] || process.env.CODEX_THREAD_ID, o.verdict, o.evidence)
  if (command === 'cancel') return E.cancel(store, requestId)
  if (command === 'retry-delivery') return E.retryDelivery(store, requestId)
  if (command === 'reconcile') return worker.reconcileWorker(store, requestId)
  if (command === 'attach-run') return worker.attachRun(store, requestId, o['run-id'])
  if (command === 'inspect-run') {
    const r = E.load(store, requestId); const record = workflow.readRun(r, o['run-id'] || E.state(store, requestId).workflowRunId)
    return { workflowRunId: record.run.runId, scriptPath: record.run.scriptPath, terminalFingerprint: record.terminalFingerprint, workStatus: record.workStatus, sourceRef: record.file }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(e => { console.error(JSON.stringify({ error: e.code || 'bridge-error', message: e.message })); process.exitCode = 1 })
}
