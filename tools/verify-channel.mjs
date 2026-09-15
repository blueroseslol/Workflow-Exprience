#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test, after } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { main as cli } from './session-bridge.mjs'
const require = createRequire(import.meta.url)
const C = require('../bridge/contracts.cjs')
const E = require('../bridge/engine.cjs')
const W = require('../bridge/worker.cjs')
const P = require('../bridge/process.cjs')
const F = require('../bridge/workflow.cjs')
const H = require('../bridge/channel.cjs')
const { Store } = require('../bridge/store.cjs')
const codex = require('../bridge/adapters/codex.cjs')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-channel-test-'))
process.env.WORKFLOW_BRIDGE_RUNTIME_DIR = path.join(temp, 'runtime')
process.env.ULTRACODE_PROJECTS_DIR = path.join(temp, 'projects')
after(() => { fs.rmSync(temp, { recursive: true, force: true }) })
async function fixture(existing) {
  const cwd = existing?.cwd || fs.mkdtempSync(path.join(temp, '中文 worktree '))
  if (!existing) {
    fs.writeFileSync(path.join(cwd, 'probe.txt'), 'initial\n')
    fs.writeFileSync(path.join(cwd, '.gitignore'), '.workflow-bridge/\n')
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']]) {
      const p = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); assert.equal(p.status, 0, p.stderr)
    }
  }
  const baseline = P.gitSnapshot(cwd)
  const input = {
    requestId: crypto.randomUUID(), origin: { provider: 'codex', hostId: 'local', sessionId: 'test-codex', cwd },
    worker: { provider: 'claude', hostId: 'local', sessionId: existing?.r.worker.sessionId || crypto.randomUUID(), cwd },
    workspace: { repoRoot: cwd, worktreeRoot: cwd, baselineHead: baseline.head, dirtySnapshot: baseline.dirtySnapshot, allowedPaths: ['probe.txt'] },
    work: { requirement: '验证本地 channel', taskIds: ['1'], acceptance: ['协议回执'], stopConditions: ['不得扩大范围'] },
    intent: { enabled: true, source: 'user-explicit', userInstruction: '测试夹具授权', requestedActions: ['read-context', 'dispatch-work', 'notify-terminal'] },
    notify: { when: 'terminal', required: true, transport: 'queue', deadlineAt: new Date(Date.now() + 3600000).toISOString() },
    control: { mode: 'supervised', maxRevisionRounds: 0, workerTransport: 'channel', allowCreateWorker: false, receiptTimeoutMs: 1000, requestExpiry: new Date(Date.now() + 3600000).toISOString() },
  }
  const store = new Store(cwd, undefined, { create: true })
  E.bind(store, input); await E.exportContext(store, input.requestId)
  return { store, cwd, r: E.load(store, input.requestId), input }
}
function receiver(f, t, sessionId = f.r.worker.sessionId) {
  H.sessionEvent(f.store, sessionId, 'SessionStart')
  const value = new H.Receiver(f.store, sessionId)
  value.connect()
  t.after(() => value.close())
  return value
}
const ackArgs = f => {
  const m = E.state(f.store, f.r.requestId).channelMessage
  return { requestId: m.requestId, messageId: m.messageId, sha256: m.sha256 }
}
const error = (fn, code) => assert.throws(fn, e => e.code === code)

test('父会话目录非 Git：子仓库导出、派发、ACK、结果路径及漂移校验', async t => {
  const seed = await fixture()
  const session = fs.mkdtempSync(path.join(temp, 'session-parent-'))
  const repo = path.join(session, 'backend'); fs.renameSync(seed.cwd, repo)
  fs.writeFileSync(path.join(session, 'probe.txt'), 'outside-repository')
  const input = { ...seed.input, requestId: crypto.randomUUID(), origin: { ...seed.input.origin, cwd: session }, worker: { ...seed.input.worker, cwd: session }, workspace: { ...seed.input.workspace, repoRoot: repo, worktreeRoot: repo } }
  const store = new Store(session, undefined, { create: true })
  E.bind(store, input); await E.exportContext(store, input.requestId)
  const r = E.load(store, input.requestId); const f = { store, cwd: session, r }
  const context = store.read(store.run(r.requestId, 'context.json'))
  assert.equal(context.files[0].sha256, C.hash(fs.readFileSync(path.join(repo, 'probe.txt'))))
  assert.equal(H.dispatch(store, r.requestId, { dryRun: true }).message.cwd, session)
  H.dispatch(store, r.requestId)
  const a = receiver(f, t); let sent = 0
  await a.pump(async () => sent++); assert.equal(sent, 1)
  assert.equal(a.acknowledge(ackArgs(f)).receipt.cwd, session)
  const result = { schemaVersion: 1, requestId: r.requestId, workflowRunId: 'wf_scope', scriptPath: path.join(repo, 'probe.txt'), terminalFingerprint: 'fixture', workStatus: 'blocked', summary: 'fixture', baselineHead: r.workspace.baselineHead, currentHead: r.workspace.baselineHead, completedTaskIds: [], remainingTaskIds: ['1'], changedFiles: ['probe.txt'], commits: [], tests: [], blockers: ['fixture'], nextActions: [], sourceRefs: [] }
  C.validateResult(result, r)
  error(() => C.validateResult({ ...result, changedFiles: ['../probe.txt'] }, r), 'path-outside-root')
  fs.writeFileSync(path.join(repo, 'probe.txt'), 'changed')
  error(() => E.checkDrift(r), 'workspace-drift')
  error(() => C.createRequest({ ...input, control: { ...input.control, workerTransport: 'worker' } }), 'workspace-mismatch')
  error(() => C.createRequest({ ...input, workspace: { ...input.workspace, worktreeRoot: root } }), 'workspace-mismatch')
})

test('CLI dry-run、离线持久队列、重复派发、上下文冻结和超时', async () => {
  const f = await fixture()
  const args = ['dispatch', '--cwd', f.cwd, '--request-id', f.r.requestId]
  assert.equal((await cli([...args, '--dry-run'])).transport, 'channel')
  assert.equal(E.state(f.store, f.r.requestId).channelMessage, undefined)
  const first = await cli(args)
  assert.equal(first.dispatchStatus, 'queued'); assert.equal(first.channelOnline, false)
  assert.equal((await cli(args)).duplicate, true)
  assert.equal(E.state(f.store, f.r.requestId).channelMessage.messageId, first.channelMessage.messageId)
  assert.equal(H.status(f.store, f.r.requestId, Date.now() + 2000).dispatchStatus, 'receipt-timeout')
  assert.equal(H.status(f.store, f.r.requestId, Date.now() + 2000).receiptConfirmed, false)
  await assert.rejects(E.exportContext(f.store, f.r.requestId), e => e.code === 'already-dispatched')
  await assert.rejects(cli([...args, '--resume']), e => e.code === 'usage')
})
test('收到前不得启动 Workflow；ACK 校验目标、哈希与去重', async t => {
  const f = await fixture(); H.dispatch(f.store, f.r.requestId)
  const a = receiver(f, t)
  error(() => a.acknowledge(ackArgs(f)), 'not-delivered')
  error(() => W.attachRun(f.store, f.r.requestId, 'wf_test'), 'receipt-required')
  let sent = 0; await a.pump(async () => sent++)
  assert.equal(sent, 1); assert.equal(H.status(f.store, f.r.requestId).receiptConfirmed, false)
  error(() => a.acknowledge({ ...ackArgs(f), sha256: '0'.repeat(64) }), 'identity-mismatch')
  const wrong = receiver(f, t, 'wrong-session')
  assert.deepEqual(wrong.pending(), [])
  error(() => wrong.acknowledge(ackArgs(f)), 'identity-mismatch')
  assert.equal(a.acknowledge(ackArgs(f)).execute, true)
  assert.equal(a.acknowledge(ackArgs(f)).execute, false)
  assert.equal(H.status(f.store, f.r.requestId).dispatchStatus, 'received')
  assert.equal(H.status(f.store, f.r.requestId, Date.now() + 2000).receiptConfirmed, true)
  await a.pump(async () => sent++); assert.equal(sent, 1)
})
test('通知抛错或连接重启不重复注入；新连接可核对并确认原消息', async t => {
  const f = await fixture(); H.dispatch(f.store, f.r.requestId)
  const a = receiver(f, t)
  await assert.rejects(a.pump(async () => { throw new Error('socket closed') }), /socket closed/)
  a.close()
  const b = new H.Receiver(f.store, f.r.worker.sessionId); t.after(() => b.close())
  b.connect()
  let sent = 0; await b.pump(async () => sent++)
  assert.equal(sent, 0); assert.equal(b.pending().length, 1)
  assert.equal(b.acknowledge(ackArgs(f)).execute, true)
  assert.equal(H.status(f.store, f.r.requestId).workerReceipt.connectionId, b.connectionId)
})
test('SessionEnd / clear 使旧连接失效；同 ID 第二个连接不能抢占', async t => {
  const f = await fixture(); H.dispatch(f.store, f.r.requestId)
  const a = receiver(f, t); await a.pump(async () => {})
  error(() => new H.Receiver(f.store, f.r.worker.sessionId), 'owner-unknown')
  H.sessionEvent(f.store, f.r.worker.sessionId, 'SessionEnd')
  error(() => a.acknowledge(ackArgs(f)), 'identity-mismatch')
  H.sessionEvent(f.store, f.r.worker.sessionId, 'SessionStart')
  assert.equal(a.ready(), false)
})
test('取消未发消息不发布；取消可能已送达消息不冒充已停止', async t => {
  const f = await fixture(); H.dispatch(f.store, f.r.requestId); E.cancel(f.store, f.r.requestId)
  const a = receiver(f, t); let sent = 0; await a.pump(async () => sent++)
  assert.equal(sent, 0); assert.equal(H.status(f.store, f.r.requestId).dispatchStatus, 'cancelled')
  const next = await fixture(f); H.dispatch(next.store, next.r.requestId)
  await a.pump(async () => sent++); assert.equal(sent, 1)
  E.cancel(next.store, next.r.requestId)
  assert.equal(E.state(next.store, next.r.requestId).stopStatus, 'stop-requested')
  error(() => a.acknowledge(ackArgs(next)), 'cancelled')
})
test('消息哈希、工作树漂移均在发布前拒绝', async t => {
  const f = await fixture(); H.dispatch(f.store, f.r.requestId)
  const a = receiver(f, t)
  fs.writeFileSync(path.join(f.cwd, 'probe.txt'), 'changed')
  await assert.rejects(a.pump(async () => assert.fail('不得发出')), e => e.code === 'workspace-drift')
  a.reportError('workspace-drift')
  assert.equal(H.status(f.store, f.r.requestId).channelErrorCode, 'workspace-drift')
  fs.writeFileSync(path.join(f.cwd, 'probe.txt'), 'initial\n')
  const state = E.state(f.store, f.r.requestId)
  E.setState(f.store, f.r.requestId, { channelMessage: { ...state.channelMessage, requirement: 'tampered' } })
  await assert.rejects(a.pump(async () => assert.fail('不得发出')), e => e.code === 'identity-mismatch')
})
test('同会话串行：前一个 ACK 不放行，真实快照验证完成才放行后一个', async t => {
  const f = await fixture(); const a = receiver(f, t)
  H.dispatch(f.store, f.r.requestId); await a.pump(async () => {})
  a.acknowledge(ackArgs(f))
  const next = await fixture(f); H.dispatch(next.store, next.r.requestId)
  let sent = 0; await a.pump(async () => sent++); assert.equal(sent, 0)
  const dir = path.join(process.env.ULTRACODE_PROJECTS_DIR, 'fixture', f.r.worker.sessionId, 'workflows')
  fs.mkdirSync(dir, { recursive: true })
  const script = f.store.file(f.store.run(f.r.requestId, 'workflow.js')); fs.writeFileSync(script, 'return {status:"completed"}')
  const run = { runId: 'wf_test', status: 'completed', scriptPath: script, result: { status: 'completed' } }
  fs.writeFileSync(path.join(dir, 'wf_test.json'), JSON.stringify(run))
  W.attachRun(f.store, f.r.requestId, run.runId)
  assert.equal(E.state(f.store, f.r.requestId).workStatus, 'running')
  W.completeVerified(f.store, f.r.requestId, { schemaVersion: 1, requestId: f.r.requestId, workflowRunId: run.runId, scriptPath: script, terminalFingerprint: F.fingerprint(run), workStatus: 'completed', summary: 'fixture result', baselineHead: f.r.workspace.baselineHead, currentHead: f.r.workspace.baselineHead, completedTaskIds: ['1'], remainingTaskIds: [], changedFiles: [], commits: [], tests: [{ command: 'fixture', cwd: f.cwd, exitCode: 0, evidence: 'synthetic snapshot test' }], blockers: [], nextActions: [], sourceRefs: ['fixture'] })
  await a.pump(async () => sent++, { send: async () => ({ deliveryStatus: 'queued' }) }); assert.equal(sent, 1)
  assert.equal(H.status(f.store, f.r.requestId).dispatchStatus, 'received')
  assert.equal(H.status(f.store, f.r.requestId).deliveryStatus, 'queued')
})
test('真实 stdio MCP 子进程：初始化、Channel 通知、工具 ACK；无需部署 node_modules', { timeout: 20000 }, async t => {
  const f = await fixture(); H.sessionEvent(f.store, f.r.worker.sessionId, 'SessionStart')
  H.dispatch(f.store, f.r.requestId)
  const copy = path.join(temp, 'deployed-plugin')
  fs.cpSync(path.join(root, 'bridge'), path.join(copy, 'bridge'), { recursive: true })
  const client = new Client({ name: 'channel-offline-test', version: '1' })
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(copy, 'bridge/channel-server.cjs')], cwd: f.cwd, stderr: 'pipe', env: { ...process.env, CLAUDE_CODE_SESSION_ID: f.r.worker.sessionId, CLAUDE_PROJECT_DIR: f.cwd } })
  t.after(async () => { await client.close() })
  let resolveNotice
  const notice = new Promise(resolve => { resolveNotice = resolve })
  client.fallbackNotificationHandler = value => { if (value.method === 'notifications/claude/channel') resolveNotice(value) }
  await client.connect(transport)
  assert.deepEqual(client.getServerCapabilities().experimental['claude/channel'], {})
  const tools = await client.listTools(); assert(tools.tools.some(v => v.name === 'bridge_ack'))
  const connected = await client.callTool({ name: 'bridge_connect', arguments: {} })
  assert.equal(JSON.parse(connected.content[0].text).sessionId, f.r.worker.sessionId)
  const event = await notice
  assert.equal(event.params.meta.message_id, ackArgs(f).messageId)
  const reply = await client.callTool({ name: 'bridge_ack', arguments: ackArgs(f) })
  assert.equal(reply.isError, undefined)
  assert.equal(JSON.parse(reply.content[0].text).execute, true)
  const duplicate = await client.callTool({ name: 'bridge_ack', arguments: ackArgs(f) })
  assert.equal(JSON.parse(duplicate.content[0].text).execute, false)
  assert.equal((await cli(['status', '--cwd', f.cwd, '--request-id', f.r.requestId])).receiptConfirmed, true)
})
test('Hook 脚本使用 Claude JSON 身份登记，不输出协议外文本', async () => {
  const f = await fixture()
  const result = spawnSync(process.execPath, [path.join(root, 'hooks/channel-session.cjs')], { env: process.env, encoding: 'utf8', input: JSON.stringify({ session_id: f.r.worker.sessionId, cwd: f.cwd, hook_event_name: 'SessionStart' }), windowsHide: true })
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, '')
  assert.equal(H.registration(f.store, f.r.worker.sessionId).active, true)
})
test('普通 MCP 初始化不会消费队列；必须显式 bridge_connect', async t => {
  const f = await fixture(); H.dispatch(f.store, f.r.requestId)
  H.sessionEvent(f.store, f.r.worker.sessionId, 'SessionStart')
  const a = new H.Receiver(f.store, f.r.worker.sessionId); t.after(() => a.close())
  let sent = 0; await a.pump(async () => sent++)
  assert.equal(sent, 0); assert.equal(H.status(f.store, f.r.requestId).channelOnline, false)
  a.connect(); await a.pump(async () => sent++); assert.equal(sent, 1)
})
test('目标拒收未 ACK 消息可释放队列；已 ACK 的任务不能伪装拒收', async t => {
  const f = await fixture(); H.dispatch(f.store, f.r.requestId)
  const a = receiver(f, t); await a.pump(async () => {})
  const next = await fixture(f); H.dispatch(next.store, next.r.requestId)
  E.cancel(f.store, f.r.requestId)
  const rejection = a.reject({ ...ackArgs(f), reason: '尚未执行，按取消请求关闭' })
  assert.equal(rejection.execute, false)
  assert.equal(H.status(f.store, f.r.requestId).dispatchStatus, 'refused')
  let sent = 0; await a.pump(async () => sent++); assert.equal(sent, 1)
  a.acknowledge(ackArgs(next))
  error(() => a.reject({ ...ackArgs(next), reason: '不能覆盖已有 ACK' }), 'already-received')
})
test('过期请求不会注入或 ACK，仍可由目标明确拒收关闭', async t => {
  const f = await fixture(); H.dispatch(f.store, f.r.requestId)
  const a = receiver(f, t)
  const now = Date.now
  Date.now = () => now() + 7200000
  try {
    await a.pump(async () => assert.fail('过期不得发送'))
    assert.equal(H.status(f.store, f.r.requestId).dispatchStatus, 'expired')
    error(() => a.acknowledge(ackArgs(f)), 'expired')
    assert.equal(a.reject({ ...ackArgs(f), reason: '过期且未执行' }).execute, false)
  } finally { Date.now = now }
})
test('Windows npm shim 中先出现 node.exe 仍选择 package 入口，不误用 PATH 后方 CLI', { skip: process.platform !== 'win32' }, async () => {
  const dir = path.join(temp, 'npm shim 中文 & space'); const later = path.join(temp, 'later-native')
  fs.mkdirSync(path.join(dir, 'node_modules/fake/bin'), { recursive: true }); fs.mkdirSync(later)
  const entry = path.join(dir, 'node_modules/fake/bin/codex.js')
  fs.writeFileSync(entry, 'console.log("fixture npm cli")')
  fs.writeFileSync(path.join(dir, 'codex.cmd'), '@echo off\nIF EXIST "%dp0%\\node.exe" ( SET "_prog=%dp0%\\node.exe" )\n"%_prog%" "%dp0%\\node_modules\\fake\\bin\\codex.js" %*\n')
  fs.writeFileSync(path.join(later, 'codex.exe'), 'never execute')
  const selected = P.resolveExecutable('codex', { env: { PATH: [dir, later].join(path.delimiter) }, platform: 'win32' })
  assert.equal(selected.executable, process.execPath); assert.deepEqual(selected.prefix, [entry])
  assert.equal((await P.run(selected, ['--version'])).stdout.trim(), 'fixture npm cli')
})
test('Codex queue 启动失败保留 ENOENT；非零退出保留脱敏诊断但不得盲目重试', async () => {
  const f = await fixture()
  const run = async (_command, args) => args.includes('--help') ? { exitCode: 0, stdout: '--thread --message', stderr: '' } : { exitCode: 1, stdout: '', stderr: 'permission denied Authorization: Bearer secret-123\n{"token":"secret-json"}\nhttps://user:pass@example.invalid', timedOut: false }
  const result = await codex.queue(f.r.origin, 'fixture result', { run, metadata: async () => f.r.origin })
  assert.equal(result.deliveryStatus, 'delivery-unknown'); assert.equal(result.errorCode, 'queue-exit-nonzero')
  assert(result.diagnostic.stderr.includes('permission denied'))
  assert(!/secret-123|secret-json|user:pass/.test(result.diagnostic.stderr))
  await assert.rejects(codex.queue(f.r.origin, 'fixture', { metadata: async () => f.r.origin, run: async (_command, args) => {
    if (args.includes('--help')) return { exitCode: 0, stdout: '--thread --message' }
    return P.run({ executable: path.join(temp, 'missing-codex.exe'), prefix: [] }, args)
  } }), e => e.code === 'ENOENT' && e.beforeSubmission === true && e.diagnostic.phase === 'spawn')
})
test('只写候选结果也自动验证并回传；失败只补通知，不重复开发或发送', async t => {
  const f = await fixture(); const a = receiver(f, t)
  H.dispatch(f.store, f.r.requestId); await a.pump(async () => {}); a.acknowledge(ackArgs(f))
  const dir = path.join(process.env.ULTRACODE_PROJECTS_DIR, 'fixture', f.r.worker.sessionId, 'workflows')
  fs.mkdirSync(dir, { recursive: true })
  const script = f.store.file(f.store.run(f.r.requestId, 'workflow.js')); fs.writeFileSync(script, 'return {status:"completed"}')
  const run = { runId: 'wf_result_watch', status: 'completed', scriptPath: script, result: { status: 'completed' } }
  fs.writeFileSync(path.join(dir, `${run.runId}.json`), JSON.stringify(run))
  a.attachRun(f.r.requestId, run.runId)
  await a.flushResults({ send: async () => assert.fail('没有结果证据不得发送完成通知') })
  assert.equal(E.state(f.store, f.r.requestId).errorCode, 'needs-result-evidence')
  f.store.write(f.store.run(f.r.requestId, 'candidate-result.json'), { schemaVersion: 1, requestId: f.r.requestId, workflowRunId: run.runId, scriptPath: script, terminalFingerprint: F.fingerprint(run), workStatus: 'completed', summary: 'fixture result', baselineHead: f.r.workspace.baselineHead, currentHead: f.r.workspace.baselineHead, completedTaskIds: ['1'], remainingTaskIds: [], changedFiles: [], commits: [], tests: [{ command: 'fixture', cwd: f.cwd, exitCode: 0, evidence: 'synthetic snapshot test' }], blockers: [], nextActions: [], sourceRefs: ['fixture'] })
  let calls = 0
  const failure = { send: async () => { calls++; throw Object.assign(new Error('not started'), { code: 'ENOENT', beforeSubmission: true, diagnostic: { phase: 'spawn', errorCode: 'ENOENT' } }) } }
  await a.flushResults(failure)
  const s = E.state(f.store, f.r.requestId)
  assert.equal(s.workStatus, 'completed'); assert.equal(s.deliveryStatus, 'unsupported'); assert.equal(s.deliveryDiagnostic.errorCode, 'ENOENT')
  await a.flushResults(failure); assert.equal(calls, 1)
  const fake = { executable: process.execPath, prefix: [path.join(root, 'tools/fixtures/session-bridge/fake-cli.cjs'), 'codex'] }
  const out = await a.drain(f.r.requestId, { retryPreflight: true, codex: { command: fake, metadata: async () => f.r.origin } })
  assert.equal(out.deliveryStatus, 'queued'); assert.equal(out.workStatus, 'completed')
  const hash = C.hash(f.store.read(f.store.run(f.r.requestId, 'result.json')))
  await a.complete(f.r.requestId, { send: async () => assert.fail('重复 complete 不应重发') })
  assert.equal(C.hash(f.store.read(f.store.run(f.r.requestId, 'result.json'))), hash)
  E.receive(f.store, f.r.requestId, f.r.origin.sessionId)
  E.acknowledge(f.store, f.r.requestId, f.r.origin.sessionId, 'accepted', 'fixture protocol validated')
  assert.equal(E.state(f.store, f.r.requestId).controllerStatus, 'accepted')
})
