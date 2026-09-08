#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const C = require('../bridge/contracts.cjs')
const { Store, readJson } = require('../bridge/store.cjs')
const E = require('../bridge/engine.cjs')
const P = require('../bridge/process.cjs')
const X = require('../bridge/context.cjs')
const codex = require('../bridge/adapters/codex.cjs')
const claude = require('../bridge/adapters/claude.cjs')
const W = require('../bridge/worker.cjs')
const workflow = require('../bridge/workflow.cjs')
const scheduler = require('../bridge/scheduler.cjs')
const intent = require('../bridge/intent.cjs')
const { main, parseArgs } = await import('./session-bridge.mjs')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-bridge-test-'))
process.env.WORKFLOW_BRIDGE_RUNTIME_DIR = path.join(temp, 'runtime')
const fake = mode => ({ executable: process.execPath, prefix: [path.join(root, 'tools/fixtures/session-bridge/fake-cli.cjs'), mode] })
let seq = 0
function fixture({ git = false } = {}) {
  const cwd = path.join(temp, `场景 ${++seq}`); fs.mkdirSync(cwd)
  fs.writeFileSync(path.join(cwd, 'probe.txt'), 'initial\n')
  fs.writeFileSync(path.join(cwd, '.gitignore'), '.workflow-bridge/\n')
  let baseline = { head: 'abc123', dirtySnapshot: '' }
  if (git) {
    const call = args => { const p = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); assert.equal(p.status, 0, p.stderr) }
    call(['init', '-q']); call(['add', 'probe.txt', '.gitignore']); call(['-c', 'user.name=Bridge Test', '-c', 'user.email=bridge-test@example.invalid', 'commit', '-qm', 'fixture'])
    baseline = P.gitSnapshot(cwd)
  }
  const input = { schemaVersion: 1, requestId: crypto.randomUUID(), bindingId: crypto.randomUUID(), origin: { provider: 'codex', hostId: 'local', sessionId: 'codex-test', cwd }, worker: { provider: 'claude', hostId: 'local', sessionId: crypto.randomUUID(), displayName: 'worker', cwd }, workspace: { repoRoot: cwd, worktreeRoot: cwd, baselineHead: baseline.head, dirtySnapshot: baseline.dirtySnapshot, allowedPaths: ['probe.txt'] }, work: { requirement: '修改 probe.txt 并验证', taskIds: ['1.1'], acceptance: ['内容正确'], stopConditions: ['范围外修改需停止'] }, intent: { enabled: true, source: 'user-explicit', userInstruction: '请用 Claude CLI 开发并回传当前 Codex 会话', requestedActions: ['read-context', 'dispatch-work', 'notify-terminal'] }, notify: { when: 'terminal', required: true, transport: 'queue', deadlineAt: new Date(Date.now() + 3600000).toISOString() }, control: { mode: 'supervised', maxRevisionRounds: 2, requestExpiry: new Date(Date.now() + 3600000).toISOString(), allowCreateWorker: true } }
  const store = new Store(cwd, undefined, { create: true })
  const r = E.bind(store, input).request
  return { cwd, store, r, input }
}
function resultFor(f) {
  const script = path.join(f.cwd, 'probe.workflow.js'); fs.writeFileSync(script, 'return {status:"completed"}\n')
  return { schemaVersion: 1, requestId: f.r.requestId, workflowRunId: 'wf_test', scriptPath: script, terminalFingerprint: 'f'.repeat(64), workStatus: 'completed', summary: 'probe 实施结果', baselineHead: f.r.workspace.baselineHead, currentHead: f.r.workspace.baselineHead, completedTaskIds: ['1.1'], remainingTaskIds: [], changedFiles: ['probe.txt'], commits: [], tests: [{ command: 'node --test probe.test.cjs', cwd: f.cwd, exitCode: 0, evidence: 'fixture:pass' }], blockers: [], nextActions: [], sourceRefs: ['fixture:run'] }
}
const error = (fn, code) => assert.throws(fn, e => e.code === code)
const rejects = (fn, code) => assert.rejects(fn, e => e.code === code)
const tests = []
const test = (group, name, fn) => tests.push({ group, name, fn })

test('contract', '严格解析 URI，不从任意文本抽 UUID', () => {
  assert.equal(C.parseReference('codex://threads/abc-123', 'codex'), 'abc-123')
  for (const ref of ['https://threads/abc', 'codex://threads/a?prompt=send', 'codex://threads/a/b', '请找 abc-123']) error(() => C.parseReference(ref, 'codex'), 'invalid-reference')
})
test('contract', '拒绝未知版本、错误端点和变更授权范围', () => {
  const { r } = fixture()
  error(() => C.validateRequest({ ...r, schemaVersion: 2 }), 'unsupported-version')
  error(() => C.validateRequest({ ...r, replyTo: { ...r.origin, sessionId: 'other' } }), 'identity-mismatch')
  error(() => C.validateRequest({ ...r, work: { ...r.work, requirement: '扩大范围' } }), 'scope-mismatch')
})
test('contract', '名称只作唯一解析，绑定 ID 不随改名变化', () => {
  const { r, cwd } = fixture(); const e = r.worker
  assert.equal(C.resolveName('worker', 'claude', cwd, [e]).sessionId, e.sessionId)
  error(() => C.resolveName('worker', 'claude', cwd, [e, { ...e, sessionId: 'other' }]), 'needs-target')
  assert(C.sameEndpoint(e, { ...e, displayName: 'renamed' }))
})
test('contract', '跨 worktree 必须有映射', () => {
  const a = fixture(); const b = fixture()
  const input = { ...a.input, origin: { ...a.input.origin, cwd: b.cwd } }
  error(() => C.createRequest(input), 'workspace-mismatch')
  input.workspace = { ...input.workspace, worktreeMapping: { origin: b.cwd, worker: a.cwd } }
  assert(C.createRequest(input))
})
test('contract', '过期与缺失授权被拒绝', () => {
  const { r } = fixture()
  error(() => C.createRequest({ ...r, notify: { ...r.notify, deadlineAt: '2000-01-01' } }), 'expired')
  error(() => C.validateRequest({ ...r, intent: { ...r.intent, enabled: false } }), 'intent-required')
})
test('contract', '结果 task 与测试证据必须完整', () => {
  const f = fixture(); const v = resultFor(f)
  error(() => C.validateResult({ ...v, completedTaskIds: ['9.9'] }, f.r), 'scope-mismatch')
  error(() => C.validateResult({ ...v, tests: [{ command: 'test', cwd: f.cwd, exitCode: null }] }, f.r), 'invalid-contract')
})
test('contract', 'CLI 拒绝未知和重复参数', () => {
  error(() => parseArgs(['status', '--last']), 'usage')
  error(() => parseArgs(['status', '--request-id', 'a', '--request-id', 'b']), 'usage')
})
test('store', '原子文件不消费未发布 tmp', () => {
  const { store } = fixture(); store.write('test.json', { old: true }); fs.writeFileSync(store.file('test.json.fake.tmp'), '{')
  assert.deepEqual(store.read('test.json'), { old: true }); store.write('test.json', { newer: true }); assert(store.read('test.json').newer)
})
test('store', '路径越界与 junction 被拒绝', () => {
  const a = fixture(); const b = fixture()
  error(() => a.store.file('../escape.json'), 'path-outside-root')
  fs.symlinkSync(b.cwd, a.store.file('linked'), process.platform === 'win32' ? 'junction' : 'dir')
  error(() => a.store.write('linked/secret.json', {}), 'unsafe-store')
  error(() => C.boundedPath(a.cwd, path.join(a.store.root, 'linked/probe.txt')), 'path-outside-root')
})
test('store', '自定义 store 仍共享 worktree lease', () => {
  const f = fixture(); const other = new Store(f.cwd, path.join(f.cwd, 'custom-store'), { create: true })
  const l = f.store.lock('writer')
  error(() => other.lock('writer'), 'busy'); error(() => other.reclaim('writer'), 'owner-unknown')
  l.release(); other.lock('writer').release()
})
test('store', '同一 Claude session 的 lease 跨 worktree 互斥', () => {
  const a = fixture(); const b = fixture(); const key = 'session:claude:local:shared-worker'
  const lock = a.store.lock(key)
  error(() => b.store.lock(key), 'busy')
  lock.release(); b.store.lock(key).release()
})
test('store', '陈旧 lease 不能掩盖仍运行的子进程/Workflow', () => {
  const { store } = fixture(); const l = store.lock('unknown')
  l.update({ pid: 2147483647, workflowUnresolved: true })
  error(() => store.reclaim('unknown'), 'owner-unknown')
  l.update({ workflowUnresolved: false, relatedPids: [process.pid] }); error(() => store.reclaim('unknown'), 'owner-unknown')
  l.release()
})
test('store', '同 request bind 幂等但不允许修改契约', () => {
  const { r, store } = fixture()
  assert(E.bind(store, r).existing)
  error(() => E.bind(store, { ...r, work: { ...r.work, requirement: 'new' } }), 'request-conflict')
})
test('store', '中文与 shell 字符按字面传输', async () => {
  const { cwd } = fixture(); const marker = path.join(cwd, 'unexpected')
  const literal = `中文 空格\n\"quoted\" & echo bad > ${marker} \u0060echo bad\u0060 $(echo bad)`
  const r = await P.run(fake('echo'), [literal], { cwd, stdin: literal })
  assert.equal(r.exitCode, 0); const echo = JSON.parse(r.stdout)
  assert.deepEqual(echo.args, [literal]); assert.equal(echo.input, literal); assert(!fs.existsSync(marker))
})
test('store', '进程有超时和输出预算', async () => {
  const { cwd } = fixture()
  assert((await P.run(fake('timeout'), [], { cwd, timeoutMs: 100 })).timedOut)
  assert((await P.run(fake('overflow'), [], { cwd, maxBytes: 100 })).overflow)
})
test('context', '上下文包保留约束并裁剪历史', () => {
  const { r } = fixture()
  const b = X.buildContext(r, { source: 'fixture', gaps: [], messages: Array.from({ length: 100 }, (_, i) => ({ role: 'assistant', text: '中'.repeat(2000), sourceRef: String(i) })) })
  assert(b.json.truncated); assert.equal(b.json.work.requirement, r.work.requirement); assert(Buffer.byteLength(b.markdown) <= 32768)
})
test('context', '必要契约超限直接拒绝', () => {
  const f = fixture(); const r = C.createRequest({ ...f.r, work: { ...f.r.work, requirement: '大'.repeat(50000) } })
  error(() => X.buildContext(r), 'context-too-large')
})
test('context', '旧 rollout 仅选文本并标记自述', async () => {
  const { r, cwd } = fixture(); const file = path.join(cwd, 'rollout.jsonl')
  fs.writeFileSync(file, [
    { type: 'session_meta', payload: { id: r.origin.sessionId, cwd } },
    { type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'hidden' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'API_KEY=secret-value 只修改 probe' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '全部完成（待验证）' } },
    { type: 'compacted' },
  ].map(JSON.stringify).join('\n'))
  const h = await X.transcript({ ...r.origin, transcriptPath: file })
  assert.equal(h.messages.length, 2); assert(h.messages[0].text.includes('[REDACTED]')); assert.equal(h.messages[1].kind, 'unverified-claim'); assert(h.gaps.some(x => x.startsWith('compacted')))
})
test('context', 'Claude transcript 身份及巨大行预算', async () => {
  const { r, cwd } = fixture(); const file = path.join(cwd, 'claude.jsonl')
  const row = { sessionId: r.worker.sessionId, cwd, message: { role: 'user', content: '明确请求' } }
  fs.writeFileSync(file, `${JSON.stringify(row)}\n${JSON.stringify({ tool: 'x'.repeat(400000) })}\n${JSON.stringify({ ...row, message: { role: 'assistant', content: [{ type: 'text', text: 'summary' }, { type: 'thinking', thinking: 'hidden' }] } })}`)
  const h = await X.transcript({ ...r.worker, transcriptPath: file }); assert.equal(h.messages.length, 2); assert(h.gaps.some(g => g.startsWith('oversized')))
  await rejects(() => X.transcript({ ...r.worker, sessionId: 'wrong', transcriptPath: file }), 'identity-mismatch')
})
test('context', '分页 RPC 不启动 turn 并排除推理', async () => {
  const { r } = fixture()
  const h = await codex.history(r.origin, { command: fake('rpc') })
  const selected = X.fromHistory(h); assert.equal(selected.messages.length, 1); assert(!JSON.stringify(selected).includes('hidden-do-not-export'))
  const reader = new codex.ReadClient({ command: fake('rpc'), cwd: r.origin.cwd })
  try { error(() => reader.call('turn/start', {}), 'read-only') } finally { reader.close() }
})
test('context', '发布 hash 可验证，替换包被拒绝', async () => {
  const f = fixture(); const out = await E.exportContext(f.store, f.r.requestId)
  assert(X.verifyArtifact(f.store, out.artifact, f.r))
  fs.appendFileSync(out.artifact.path, ' '); error(() => X.verifyArtifact(f.store, out.artifact, f.r), 'integrity-mismatch')
})
test('codex', '精确 queue 回执仍只是 queued', async () => {
  const { r } = fixture()
  const out = await codex.queue(r.origin, 'test', { command: fake('codex'), metadata: async () => ({}) })
  assert.equal(out.deliveryStatus, 'queued'); assert.equal(out.transportMessageId, 'fake-queue-id')
})
test('codex', '零退出码与错误目标不冒充 queued', async () => {
  const { r } = fixture(); let count = 0
  const runner = async () => (++count % 2 ? { exitCode: 0, stdout: '--thread --message' } : { exitCode: 0, stdout: 'ok' })
  assert.equal((await codex.queue(r.origin, 'test', { run: runner, metadata: async () => ({}) })).deliveryStatus, 'delivery-unknown')
})
test('codex', 'queue 不存在不降级；未知 owner 不 resume', async () => {
  const { r } = fixture()
  await rejects(() => codex.queue(r.origin, 'test', { run: async () => ({ exitCode: 1, stdout: '' }) }), 'unsupported')
  await rejects(() => codex.resume(r.origin, 'test', { explicit: true, metadata: async () => ({ status: { type: 'notLoaded' }, bridgeReaderMode: 'stdio-readonly' }) }), 'owner-unknown')
})
test('codex', '通知正文限定 4KiB', async () => { const { r } = fixture(); await rejects(() => codex.queue(r.origin, '中'.repeat(4096)), 'context-too-large') })
test('recovery', '重复 terminal 只产生一条消息', () => {
  const f = fixture(); const v = resultFor(f)
  const a = E.complete(f.store, f.r.requestId, v); const b = E.complete(f.store, f.r.requestId, v)
  assert.equal(a.messageId, b.messageId); assert.equal(fs.readdirSync(f.store.file('outbox')).length, 1)
})
test('recovery', '重复完成不能替换其他终态', () => {
  const f = fixture(); const v = resultFor(f); E.complete(f.store, f.r.requestId, v)
  error(() => E.complete(f.store, f.r.requestId, { ...v, terminalFingerprint: 'other' }), 'terminal-conflict')
})
test('recovery', '发送崩溃窗口未知且禁止自动重发', async () => {
  const f = fixture(); const s = E.complete(f.store, f.r.requestId, resultFor(f)); const p = `outbox/${s.messageId}.json`
  f.store.write(p, { ...f.store.read(p), deliveryStatus: 'sending' })
  let calls = 0; const out = await E.drain(f.store, f.r.requestId, { send: async () => { calls++; return {} } })
  assert.equal(out.deliveryStatus, 'delivery-unknown'); assert.equal(calls, 0)
})
test('recovery', '投递、接收、验收各自独立且去重', async () => {
  const f = fixture(); E.complete(f.store, f.r.requestId, resultFor(f))
  let calls = 0; const send = async () => { calls++; return { deliveryStatus: 'queued' } }
  await E.drain(f.store, f.r.requestId, { send }); await E.drain(f.store, f.r.requestId, { send })
  assert.equal(calls, 1); assert.equal(E.state(f.store, f.r.requestId).controllerStatus, 'awaiting-result')
  const got = E.receive(f.store, f.r.requestId, f.r.origin.sessionId); assert(!got.duplicate)
  assert(E.receive(f.store, f.r.requestId, f.r.origin.sessionId).duplicate)
  E.acknowledge(f.store, f.r.requestId, f.r.origin.sessionId, 'accepted', 'fixture test passed')
  assert.equal(E.state(f.store, f.r.requestId).controllerStatus, 'accepted')
})
test('recovery', '拒绝错误会话收件与取消后发送', async () => {
  const f = fixture(); E.complete(f.store, f.r.requestId, resultFor(f))
  error(() => E.receive(f.store, f.r.requestId, 'other'), 'identity-mismatch')
  E.cancel(f.store, f.r.requestId); await rejects(() => E.drain(f.store, f.r.requestId), 'cancelled')
})
test('recovery', 'dry-run 不调用发送器且保留 pending', async () => {
  const f = fixture(); E.complete(f.store, f.r.requestId, resultFor(f)); const out = await E.drain(f.store, f.r.requestId, { dryRun: true, send: () => assert.fail('must not send') })
  assert(out.dryRun); assert.equal(E.state(f.store, f.r.requestId).deliveryStatus, 'pending')
})
test('claude', 'worker CLI 显式身份与 authoring，保留模型默认', async () => {
  const f = fixture(); await E.exportContext(f.store, f.r.requestId); const r = E.load(f.store, f.r.requestId)
  const invocation = claude.workerInvocation(r, f.store.file(f.store.run(r.requestId)))
  assert(invocation.args.includes('--session-id')); assert(invocation.stdin.includes('必须显式加载')); assert(invocation.stdin.includes('顶层 status 必须明确为 completed、blocked 或 failed')); assert(!invocation.args.includes('--model')); assert(!invocation.args.includes('--bare'))
})
test('claude', 'CLI 成功不等于 Workflow 终态，错误 session 拒绝', () => {
  const r = { exitCode: 0, stdout: JSON.stringify({ type: 'result', session_id: 'worker', result: 'done' }) }
  assert.equal(claude.validateWorkerEvents(r, 'worker').workflowToolSeen, false)
  error(() => claude.validateWorkerEvents(r, 'other'), 'identity-mismatch')
})
test('claude', '模型不可用/403/超时分别记录', () => {
  assert.equal(claude.classifyFailure({ exitCode: 1, stdout: JSON.stringify({ type: 'result', result: 'selected model may not exist' }) }), 'model-unavailable')
  assert.equal(claude.classifyFailure({ exitCode: 1, stderr: 'HTTP 403' }), 'authentication-failed')
  assert.equal(claude.classifyFailure({ timedOut: true }), 'worker-timeout')
})
test('claude', 'relay 只认工具回执，忽略自然语言成功声明', async () => {
  const { r } = fixture()
  const out = await claude.relay(r.worker, 'notify', { explicit: true, maxBudgetUsd: 1, candidates: async () => [r.worker], run: async () => ({ exitCode: 0, stdout: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '发送成功' }] } }) }) })
  assert.equal(out.deliveryStatus, 'delivery-unknown')
})
test('claude', 'relay 重名拒绝且 held 如实返回', async () => {
  const { r } = fixture()
  await rejects(() => claude.relay(r.worker, 'test', { explicit: true, maxBudgetUsd: 1, candidates: async () => [r.worker, { ...r.worker, sessionId: 'other' }] }), 'needs-target')
  const events = [ { message: { content: [{ type: 'tool_use', name: 'SendMessage', id: 't', input: { recipient: 'worker', content: 'test' } }] } }, { message: { content: [{ type: 'tool_result', tool_use_id: 't', content: '{"status":"held"}' }] } } ]
  const out = await claude.relay(r.worker, 'test', { explicit: true, maxBudgetUsd: 1, candidates: async () => [r.worker], run: async () => ({ exitCode: 0, stdout: events.map(JSON.stringify).join('\n') }) })
  assert.equal(out.deliveryStatus, 'held')
})
test('claude', 'terminal 状态必须包含可解释业务结果', () => {
  assert.equal(workflow.terminal({ status: 'completed', result: {} }), true)
  assert.equal(workflow.terminalStatus({ status: 'completed', result: {} }), null)
  assert.equal(workflow.terminalStatus({ status: 'completed', result: { status: 'blocked' } }), 'blocked')
  assert.equal(workflow.terminalStatus({ status: 'failed' }), 'failed')
})
test('claude', '已终结但业务结果不可解释时立即阻塞', async () => {
  const f = fixture({ git: true }); await E.exportContext(f.store, f.r.requestId)
  E.setState(f.store, f.r.requestId, { runnerStatus: 'starting', launchToken: 'test-token', workStatus: 'running' })
  const projects = f.store.file('fixture-projects'); const runId = 'wf_uninterpretable'; const script = f.store.file(f.store.run(f.r.requestId, 'uninterpretable.js'))
  fs.writeFileSync(script, 'return {}')
  const dir = path.join(projects, 'project', f.r.worker.sessionId, 'workflows'); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${runId}.json`), JSON.stringify({ runId, status: 'completed', scriptPath: script, result: {} }))
  W.attachRun(f.store, f.r.requestId, runId, { projects })
  const out = await W.runWorker(f.store, f.r.requestId, 'test-token', { projects, run: async () => ({ exitCode: 0, stdout: JSON.stringify({ type: 'result', session_id: f.r.worker.sessionId, result: 'done' }), stderr: '', timedOut: false, overflow: false }) })
  assert.equal(out.workStatus, 'blocked'); assert.equal(out.errorCode, 'workflow-result-uninterpretable'); assert.equal(out.runnerStatus, 'exited')
})
test('claude', '绑定 Workflow 快照后才接受完成', () => {
  const f = fixture(); const v = resultFor(f); const projects = path.join(f.cwd, 'projects')
  const dir = path.join(projects, 'project', f.r.worker.sessionId, 'workflows'); fs.mkdirSync(dir, { recursive: true })
  const run = { runId: 'wf_test', status: 'completed', scriptPath: v.scriptPath, result: { status: 'completed' } }
  fs.writeFileSync(path.join(dir, 'wf_test.json'), JSON.stringify(run))
  error(() => W.completeVerified(f.store, f.r.requestId, v, { projects }), 'run-conflict')
  W.attachRun(f.store, f.r.requestId, 'wf_test', { projects }); v.terminalFingerprint = workflow.fingerprint(run)
  assert.equal(W.completeVerified(f.store, f.r.requestId, v, { projects }).workStatus, 'completed')
})
test('claude', '同一 Workflow run 不能跨 request 复用', async () => {
  const f = fixture(); const projects = path.join(f.cwd, 'projects')
  const runId = 'wf_owned'; const script = path.join(f.cwd, 'owned.workflow.js'); fs.writeFileSync(script, 'return {}')
  const dir = path.join(projects, 'p', f.r.worker.sessionId, 'workflows'); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${runId}.json`), JSON.stringify({ runId, status: 'completed', scriptPath: script, result: { status: 'completed' } }))
  W.attachRun(f.store, f.r.requestId, runId, { projects })
  const input = structuredClone(f.r); delete input.context
  input.requestId = crypto.randomUUID(); input.bindingId = crypto.randomUUID(); input.work = { ...input.work, requirement: '独立新 request' }
  input.control = { ...input.control, allowCreateWorker: false, resumeFromRequestId: f.r.requestId }
  const second = E.bind(f.store, input).request; await E.exportContext(f.store, second.requestId)
  error(() => W.attachRun(f.store, second.requestId, runId, { projects }), 'run-conflict')
})
test('intent', '普通需求与明确禁用默认不启用', () => { assert.equal(intent.validateDecision(null, '修一个 bug').enabled, false); assert.equal(intent.validateDecision({ enabled: false }, '不要通知').enabled, false) })
test('intent', '原话证据、否定和引用边界', () => {
  const decision = { enabled: true, source: 'user-explicit', evidenceQuote: '完成后通知', requestedActions: ['notify-terminal'], targetResolved: true }
  assert(intent.validateDecision(decision, '请完成后通知指定主会话').enabled)
  error(() => intent.validateDecision(decision, '```text\n完成后通知\n```'), 'intent-required')
  error(() => intent.validateDecision({ ...decision, negated: true }, '不要在完成后通知'), 'intent-required')
  error(() => intent.validateDecision({ ...decision, targetResolved: false }, '完成后通知'), 'needs-target')
})
test('intent', '同任务授权可恢复，不同任务/撤销不能继承', () => {
  const { r } = fixture()
  assert(intent.canResume(r, { requestId: r.requestId, scope: r.intent.scopeHash }))
  error(() => intent.canResume(r, { requestId: 'different', scope: r.intent.scopeHash }), 'scope-mismatch')
  error(() => intent.canResume(r, { requestId: r.requestId, scope: r.intent.scopeHash, cancelled: true }), 'cancelled')
})
test('integration', '真实 git 漂移使派发失败', async () => {
  const f = fixture({ git: true }); await E.exportContext(f.store, f.r.requestId)
  assert(E.checkDrift(f.r)); fs.appendFileSync(path.join(f.cwd, 'probe.txt'), 'unrelated')
  error(() => W.dispatch(f.store, f.r.requestId), 'workspace-drift')
})
test('integration', 'CLI 无效 status 不创建运行目录', async () => {
  const cwd = path.join(temp, 'empty'); fs.mkdirSync(cwd)
  await rejects(() => main(['status', '--cwd', cwd, '--request-id', 'absent']), 'ENOENT')
  assert(!fs.existsSync(path.join(cwd, '.workflow-bridge')))
})
test('integration', '完整离线请求/上下文/完成/回传/验收闭环', async () => {
  const f = fixture({ git: true }); await E.exportContext(f.store, f.r.requestId)
  assert((await main(['dispatch', '--cwd', f.cwd, '--request-id', f.r.requestId, '--dry-run'])).dryRun)
  E.complete(f.store, f.r.requestId, resultFor(f)); await E.drain(f.store, f.r.requestId, { send: async () => ({ deliveryStatus: 'queued' }) })
  const got = await main(['receive', '--cwd', f.cwd, '--request-id', f.r.requestId, '--session-id', f.r.origin.sessionId])
  assert.equal(got.result.completedTaskIds[0], '1.1')
  assert.equal((await main(['acknowledge', '--cwd', f.cwd, '--request-id', f.r.requestId, '--session-id', f.r.origin.sessionId, '--verdict', 'accepted', '--evidence', 'fixture verified'])).controllerStatus, 'accepted')
})

test('recovery', '仅明确发送前失败可重置投递', async () => {
  const f = fixture(); E.complete(f.store, f.r.requestId, resultFor(f))
  await E.drain(f.store, f.r.requestId, { send: async () => { throw Object.assign(new Error('missing'), { code: 'unsupported', beforeSubmission: true }) } })
  assert.equal(E.retryDelivery(f.store, f.r.requestId).deliveryStatus, 'pending')
  await E.drain(f.store, f.r.requestId, { send: async () => { throw Object.assign(new Error('lost'), { code: 'identity-mismatch' }) } })
  error(() => E.retryDelivery(f.store, f.r.requestId), 'unsafe-retry')
})
test('recovery', '收件发生在发送返回前也保留 received', async () => {
  const f = fixture(); E.complete(f.store, f.r.requestId, resultFor(f))
  const out = await E.drain(f.store, f.r.requestId, { send: async () => { E.receive(f.store, f.r.requestId, f.r.origin.sessionId); return { deliveryStatus: 'queued' } } })
  assert.equal(out.deliveryStatus, 'received'); assert.equal(E.state(f.store, f.r.requestId).deliveryStatus, 'received')
})
test('contract', '结果不能遗漏任务或包含范围外路径', () => {
  const f = fixture(); const v = resultFor(f)
  error(() => C.validateResult({ ...v, completedTaskIds: [], remainingTaskIds: [] }, f.r), 'scope-mismatch')
  error(() => C.validateResult({ ...v, changedFiles: ['other.txt'] }, f.r), 'scope-mismatch')
  error(() => C.validateResult({ ...v, tests: [{ command: 'test', cwd: f.cwd, exitCode: 1, evidence: 'failed' }] }, f.r), 'verification-incomplete')
})
test('claude', '受控 runner 的 CLI 失败不冒充开发完成', async () => {
  const f = fixture({ git: true }); await E.exportContext(f.store, f.r.requestId)
  E.setState(f.store, f.r.requestId, { runnerStatus: 'starting', launchToken: 'test-token', workStatus: 'running' })
  const out = await W.runWorker(f.store, f.r.requestId, 'test-token', { run: async () => ({ exitCode: 1, stdout: JSON.stringify({ type: 'result', session_id: f.r.worker.sessionId, is_error: true, result: 'selected model may not exist' }), stderr: '', timedOut: false, overflow: false }) })
  assert.equal(out.workStatus, 'blocked'); assert.equal(out.errorCode, 'model-unavailable'); assert(!f.store.maybe(f.store.run(f.r.requestId, 'result.json')))
  f.store.lock(`session:${C.identity(f.r.worker)}`).release()
})
test('claude', '受控 runner 收集真实快照契约并只回传一次', async () => {
  const f = fixture({ git: true }); await E.exportContext(f.store, f.r.requestId)
  E.setState(f.store, f.r.requestId, { runnerStatus: 'starting', launchToken: 'test-token', workStatus: 'running' })
  const projects = path.join(f.cwd, 'fixture-projects'); let sent = 0
  const out = await W.runWorker(f.store, f.r.requestId, 'test-token', { projects, send: async () => { sent++; return { deliveryStatus: 'queued' } }, run: async () => {
    const v = resultFor(f); const run = { runId: v.workflowRunId, status: 'completed', scriptPath: v.scriptPath, result: { status: 'completed' } }
    const dir = path.join(projects, 'project', f.r.worker.sessionId, 'workflows'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${run.runId}.json`), JSON.stringify(run))
    W.attachRun(f.store, f.r.requestId, run.runId, { projects }); v.terminalFingerprint = workflow.fingerprint(run); f.store.write(f.store.run(f.r.requestId, 'candidate-result.json'), v)
    return { exitCode: 0, stdout: JSON.stringify({ type: 'result', session_id: f.r.worker.sessionId, result: 'done' }), stderr: '', timedOut: false, overflow: false }
  } })
  assert.equal(out.workStatus, 'completed'); assert.equal(out.deliveryStatus, 'queued'); assert.equal(sent, 1)
  await E.drain(f.store, f.r.requestId, { send: async () => { sent++; return { deliveryStatus: 'queued' } } }); assert.equal(sent, 1)
})
test('claude', '外层已 complete 的终态不被 runner 覆盖', async () => {
  const f = fixture({ git: true }); await E.exportContext(f.store, f.r.requestId)
  E.setState(f.store, f.r.requestId, { runnerStatus: 'starting', launchToken: 'test-token', workStatus: 'running' })
  const projects = path.join(f.cwd, 'fixture-projects')
  const out = await W.runWorker(f.store, f.r.requestId, 'test-token', { projects, send: async () => ({ deliveryStatus: 'queued' }), run: async () => {
    const v = resultFor(f); const run = { runId: v.workflowRunId, status: 'completed', scriptPath: v.scriptPath, result: { status: 'completed' } }
    const dir = path.join(projects, 'project', f.r.worker.sessionId, 'workflows'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${run.runId}.json`), JSON.stringify(run))
    W.attachRun(f.store, f.r.requestId, run.runId, { projects }); v.terminalFingerprint = workflow.fingerprint(run); W.completeVerified(f.store, f.r.requestId, v, { projects })
    return { exitCode: 0, stdout: JSON.stringify({ type: 'result', session_id: f.r.worker.sessionId, result: 'done' }), stderr: '', timedOut: false, overflow: false }
  } })
  assert.equal(out.workStatus, 'completed'); assert(!out.errorCode)
  E.setState(f.store, f.r.requestId, { workStatus: 'blocked', errorCode: 'stale-runner-error' })
  E.complete(f.store, f.r.requestId, f.store.read(f.store.run(f.r.requestId, 'result.json')))
  assert.equal(E.state(f.store, f.r.requestId).workStatus, 'completed'); assert.equal(E.state(f.store, f.r.requestId).errorCode, null)
})
test('integration', '未启用 bridge 的 harvest 不创建目录', () => {
  const cwd = path.join(temp, 'plain-workflow'); fs.mkdirSync(cwd)
  const out = require('../bridge/hooks.cjs').onHarvest({ cwd, sessionId: 'plain-session', runId: 'wf_plain', run: { status: 'completed', result: { status: 'completed' } } })
  assert.equal(out.enabled, false); assert(!fs.existsSync(path.join(cwd, '.workflow-bridge')))
})
test('integration', 'harvest 只接受绑定 session/run，且不发送', () => {
  const f = fixture(); const projects = path.join(f.cwd, 'projects'); const run = { runId: 'wf_hook', status: 'completed', scriptPath: path.join(f.cwd, 'script.js'), result: { status: 'completed' } }
  fs.writeFileSync(run.scriptPath, 'return {}')
  const dir = path.join(projects, 'p', f.r.worker.sessionId, 'workflows'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'wf_hook.json'), JSON.stringify(run))
  W.attachRun(f.store, f.r.requestId, run.runId, { projects })
  const hooks = require('../bridge/hooks.cjs')
  assert.equal(hooks.onHarvest({ cwd: f.cwd, sessionId: 'other', runId: run.runId, run }).enabled, false)
  assert(hooks.onHarvest({ cwd: f.cwd, sessionId: f.r.worker.sessionId, runId: run.runId, run }).terminalRecorded)
  assert(!fs.existsSync(f.store.file('outbox')))
})
test('integration', '不会静默忽略不支持的 dry-run', () => { error(() => parseArgs(['cancel', '--request-id', 'x', '--dry-run']), 'usage') })

test('contract', '授权摘要覆盖工具权限与通知策略，bind 拒绝未知版本', () => {
  const f = fixture()
  error(() => C.createRequest({ ...f.input, schemaVersion: 2 }), 'unsupported-version')
  error(() => C.validateRequest({ ...f.r, control: { ...f.r.control, allowedTools: ['Bash'] } }), 'scope-mismatch')
  error(() => C.validateRequest({ ...f.r, notify: { ...f.r.notify, transport: 'resume' } }), 'scope-mismatch')
})
test('recovery', 'dry-run 不修改 sending，对账不重发', async () => {
  const f = fixture(); E.complete(f.store, f.r.requestId, resultFor(f))
  const p = `outbox/${E.state(f.store, f.r.requestId).messageId}.json`
  f.store.write(p, { ...f.store.read(p), deliveryStatus: 'sending' })
  await E.drain(f.store, f.r.requestId, { dryRun: true })
  assert.equal(f.store.read(p).deliveryStatus, 'sending')
  assert.equal(E.reconcile(f.store, f.r.requestId).deliveryStatus, 'delivery-unknown')
  error(() => E.retryDelivery(f.store, f.r.requestId), 'unsafe-retry')
})
test('integration', '已有 dirty 文件内容变化也使上下文失效', async () => {
  const f = fixture(); await E.exportContext(f.store, f.r.requestId)
  fs.appendFileSync(path.join(f.cwd, 'probe.txt'), 'same porcelain status, different content')
  error(() => X.verifySourceFiles(f.store, E.load(f.store, f.r.requestId)), 'workspace-drift')
})
test('integration', '只排除 Workflow 自身的未跟踪状态文件', async () => {
  const f = fixture({ git: true })
  for (const name of ['.claude/progress/session.jsonl', 'docs/ultracode/raw/run.json']) {
    const file = path.join(f.cwd, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{}')
  }
  assert(E.checkDrift(f.r))
  fs.writeFileSync(path.join(f.cwd, 'docs/unrelated.txt'), 'must be detected')
  error(() => E.checkDrift(f.r), 'workspace-drift')
})

test('claude', '实测 peer success/msg_id 格式只认匹配原文的工具回执', async () => {
  const { r } = fixture()
  const events = [{ message: { content: [{ type: 'tool_use', name: 'SendMessage', id: 'native', input: { to: 'worker', message: 'exact probe' } }] } }, { message: { content: [{ type: 'tool_result', tool_use_id: 'native', content: [{ type: 'text', text: JSON.stringify({ success: true, msg_id: 'peer-message-1' }) }] }] } }]
  const opts = { explicit: true, maxBudgetUsd: 1, candidates: async () => [r.worker], run: async () => ({ exitCode: 0, stdout: events.map(JSON.stringify).join('\n') }) }
  assert.equal((await claude.relay(r.worker, 'exact probe', opts)).transportMessageId, 'peer-message-1')
  assert.equal((await claude.relay(r.worker, 'different', opts)).deliveryStatus, 'delivery-unknown')
})
test('claude', '实测 peer success=false 格式映射为 refused', async () => {
  const { r } = fixture()
  const events = [{ message: { content: [{ type: 'tool_use', name: 'SendMessage', id: 'native-fail', input: { to: 'worker', message: 'exact probe' } }] } }, { message: { content: [{ type: 'tool_result', tool_use_id: 'native-fail', content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'No agent is reachable' }) }] }] } }]
  const out = await claude.relay(r.worker, 'exact probe', { explicit: true, maxBudgetUsd: 1, candidates: async () => [r.worker], run: async () => ({ exitCode: 0, stdout: events.map(JSON.stringify).join('\n') }) })
  assert.equal(out.deliveryStatus, 'refused'); assert.equal(out.exitCode, 0)
})

test('contract', '回执校验版本、来源会话与结果 hash', () => {
  const f = fixture(); E.complete(f.store, f.r.requestId, resultFor(f))
  const got = E.receive(f.store, f.r.requestId, f.r.origin.sessionId)
  const m = f.store.read(`outbox/${got.receipt.messageId}.json`).message
  error(() => C.validateReceipt({ ...got.receipt, schemaVersion: 2 }, f.r, m), 'unsupported-version')
  error(() => C.validateReceipt({ ...got.receipt, sessionId: 'other' }, f.r, m), 'identity-mismatch')
})
test('claude', '允许真实 session 的内联脚本目录，拒绝其他 session', () => {
  const f = fixture(); const projects = path.join(f.cwd, 'projects')
  const dir = path.join(projects, 'p', f.r.worker.sessionId, 'workflows')
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  const script = path.join(dir, 'scripts', 'native.js'); fs.writeFileSync(script, 'return {}')
  const run = { runId: 'wf_native', status: 'completed', result: { status: 'completed' }, scriptPath: script }
  fs.writeFileSync(path.join(dir, 'wf_native.json'), JSON.stringify(run))
  assert.equal(workflow.readRun(f.r, 'wf_native', { projects }).workStatus, 'completed')
  const other = path.join(temp, 'other-session-script.js'); fs.writeFileSync(other, 'return {}')
  fs.writeFileSync(path.join(dir, 'wf_native.json'), JSON.stringify({ ...run, scriptPath: other }))
  error(() => workflow.readRun(f.r, 'wf_native', { projects }), 'path-outside-root')
})

test('claude', '活跃受控 worker 将同 session 请求串行入 inbox', async () => {
  const f = fixture({ git: true }); await E.exportContext(f.store, f.r.requestId)
  const input = structuredClone(f.r)
  delete input.context
  input.requestId = crypto.randomUUID(); input.bindingId = crypto.randomUUID()
  input.control = { ...input.control, allowCreateWorker: false }
  input.control.resumeFromRequestId = f.r.requestId
  input.work = { ...input.work, requirement: '串行执行第二个无副作用测试任务' }
  const second = E.bind(f.store, input).request; await E.exportContext(f.store, second.requestId)
  const first = scheduler.admit(f.store, E.load(f.store, f.r.requestId), { validate: () => {} })
  const queued = W.dispatch(f.store, second.requestId)
  assert.equal(queued.runnerStatus, 'queued'); assert.equal(queued.activeRequestId, f.r.requestId)
  const launched = []
  await W.runWorker(f.store, f.r.requestId, first.token, {
    run: async () => ({ exitCode: 1, stdout: JSON.stringify({ type: 'result', session_id: f.r.worker.sessionId, is_error: true, result: 'first stopped safely' }), stderr: '', timedOut: false, overflow: false }),
    launchNext: (...args) => launched.push(args),
  })
  assert.equal(launched.length, 1); assert.equal(launched[0][1].requestId, second.requestId)
  assert.equal(E.state(f.store, second.requestId).resumeRequested, true)
  assert.equal(scheduler.readSlot(f.store, second).requestId, second.requestId)
})
test('recovery', '确认 runner 和子进程退出后对账推进串行 inbox', async () => {
  const f = fixture({ git: true }); await E.exportContext(f.store, f.r.requestId)
  const input = structuredClone(f.r); delete input.context
  input.requestId = crypto.randomUUID(); input.bindingId = crypto.randomUUID()
  input.control = { ...input.control, allowCreateWorker: false, resumeFromRequestId: f.r.requestId }
  input.work = { ...input.work, requirement: '对账后执行的第二个切片' }
  const second = E.bind(f.store, input).request; await E.exportContext(f.store, second.requestId)
  scheduler.admit(f.store, E.load(f.store, f.r.requestId), { validate: () => {} })
  W.dispatch(f.store, second.requestId)
  E.setState(f.store, f.r.requestId, { runnerStatus: 'exited', sessionBound: true, childExitKnown: true, runnerPid: 2147483646, childPid: 2147483647 })
  const reconciled = scheduler.reconcile(f.store, E.load(f.store, f.r.requestId))
  assert.equal(reconciled.schedulerStatus, 'reconciled'); assert.equal(reconciled.next.request.requestId, second.requestId)
  assert.equal(E.state(f.store, second.requestId).resumeRequested, true); assert.equal(scheduler.readSlot(f.store, second).requestId, second.requestId)
})
test('claude', '新 request 只恢复已终态前序的原 Claude session', async () => {
  const f = fixture({ git: true }); await E.exportContext(f.store, f.r.requestId)
  E.setState(f.store, f.r.requestId, { runnerStatus: 'exited', sessionBound: true, childExitKnown: true, runnerPid: 2147483646, childPid: 2147483647 })
  E.complete(f.store, f.r.requestId, resultFor(f))
  fs.unlinkSync(path.join(f.cwd, 'probe.workflow.js'))
  const input = structuredClone(f.r); delete input.context
  input.requestId = crypto.randomUUID(); input.bindingId = crypto.randomUUID(); input.work = { ...input.work, requirement: '恢复前序 session 的新切片' }
  input.control = { ...input.control, allowCreateWorker: false, resumeFromRequestId: f.r.requestId }
  const second = E.bind(f.store, input).request; await E.exportContext(f.store, second.requestId)
  const preview = W.dispatch(f.store, second.requestId, { resume: true, dryRun: true })
  assert(preview.args.includes('--resume')); assert(preview.stdin.includes('必须创建新的 Workflow run ID'))
  const wrong = structuredClone(input); wrong.requestId = crypto.randomUUID(); wrong.bindingId = crypto.randomUUID(); wrong.control.resumeFromRequestId = 'missing-request'
  const invalid = E.bind(f.store, wrong).request; await E.exportContext(f.store, invalid.requestId)
  error(() => W.dispatch(f.store, invalid.requestId, { resume: true, dryRun: true }), 'ENOENT')
})
test('claude', '同 session 跨 worktree 请求不并发启动', async () => {
  const a = fixture({ git: true }); const b = fixture({ git: true })
  b.input.worker.sessionId = a.r.worker.sessionId
  b.input.requestId = crypto.randomUUID(); b.input.bindingId = crypto.randomUUID()
  const rebound = E.bind(b.store, b.input).request
  await E.exportContext(a.store, a.r.requestId); await E.exportContext(b.store, rebound.requestId)
  scheduler.admit(a.store, E.load(a.store, a.r.requestId), { validate: () => {} })
  error(() => W.dispatch(b.store, rebound.requestId), 'workspace-mismatch')
  assert.equal(E.state(b.store, rebound.requestId).workStatus, 'prepared')
})
test('recovery', '部分建档可重建，丢失 outbox 不把已投递结果恢复为待发', async () => {
  const f = fixture()
  fs.unlinkSync(f.store.file(f.store.run(f.r.requestId, 'state.json')))
  E.bind(f.store, f.r)
  assert.equal(E.state(f.store, f.r.requestId).workStatus, 'prepared')
  const result = resultFor(f); E.complete(f.store, f.r.requestId, result)
  await E.drain(f.store, f.r.requestId, { send: async () => ({ deliveryStatus: 'queued' }) })
  const messageId = E.state(f.store, f.r.requestId).messageId
  fs.unlinkSync(f.store.file(`outbox/${messageId}.json`))
  E.complete(f.store, f.r.requestId, result)
  assert.equal(f.store.read(`outbox/${messageId}.json`).deliveryStatus, 'queued')
})

const argv = process.argv.slice(2)
const group = argv.length === 2 && argv[0] === '--group' ? argv[1] : null
if ((argv.length && !group) || (group && !tests.some(t => t.group === group))) { console.error('无效 group'); process.exitCode = 1 }
else {
  let passed = 0; let failed = 0
  for (const t of tests.filter(t => !group || t.group === group)) {
    try { await t.fn(); passed++; console.log(`PASS [${t.group}] ${t.name}`) }
    catch (e) { failed++; console.error(`FAIL [${t.group}] ${t.name}\n${e.stack}`) }
  }
  console.log(JSON.stringify({ passed, failed, group: group || 'all', liveModelCalls: 0 }))
  if (failed) process.exitCode = 1
}
// Only remove the exact newly-created test directory, never any caller path.
assert(path.isAbsolute(temp) && path.dirname(temp) === fs.realpathSync(os.tmpdir()) && path.basename(temp).startsWith('wf-bridge-test-'))
fs.rmSync(temp, { recursive: true, force: true })
