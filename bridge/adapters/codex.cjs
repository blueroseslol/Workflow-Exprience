'use strict'
const { spawnCommand, run } = require('../process.cjs')
const { ensure, samePath, real, fail } = require('../contracts.cjs')
const { StringDecoder } = require('node:string_decoder')
const READ_METHODS = new Set(['thread/read', 'thread/list', 'thread/turns/list', 'thread/items/list', 'thread/queue/list'])
class ReadClient {
  constructor({ command = 'codex', cwd, mode = process.platform === 'win32' ? 'stdio-readonly' : 'proxy', timeoutMs = 10000, maxBytes = 8 * 1024 * 1024 } = {}) {
    ensure(['proxy', 'stdio-readonly'].includes(mode), 'unsupported', '未知 app-server 连接模式')
    this.mode = mode; this.timeoutMs = timeoutMs; this.seq = 0; this.pending = new Map()
    this.child = spawnCommand(command, mode === 'proxy' ? ['app-server', 'proxy'] : ['app-server', '--stdio'], { cwd })
    let buffer = '', total = 0
    const decoder = new StringDecoder('utf8')
    this.child.stdout.on('data', b => {
      total += b.length
      if (total > maxBytes) { this.abort('context-too-large', 'history RPC 超预算'); return }
      buffer += decoder.write(b)
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        let row; try { row = JSON.parse(line) } catch { continue }
        const p = this.pending.get(row.id)
        if (p) { this.pending.delete(row.id); clearTimeout(p.timer); row.error ? p.reject(Object.assign(new Error(row.error.message || 'RPC rejected'), { code: 'rpc-error', rpcCode: row.error.code })) : p.resolve(row.result) }
        // Approval/server requests are deliberately not answered by a history reader.
      }
    })
    this.child.stderr.on('data', () => {})
    this.child.stdin.on('error', () => {})
    this.child.on('error', () => this.abort('rpc-unavailable', '无法启动 Codex history reader'))
    this.child.on('close', () => this.abort('rpc-unavailable', 'Codex history 连接已关闭'))
  }
  abort(code, message) { this.closed = true; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Object.assign(new Error(message), { code })) }; this.pending.clear(); this.child.kill() }
  async initialize() {
    await this._call('initialize', { clientInfo: { name: 'workflow-session-bridge', version: '1' }, capabilities: { experimentalApi: true } })
    this.child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
    return this
  }
  _call(method, params) {
    if (this.closed) return Promise.reject(Object.assign(new Error('history 连接不可用'), { code: 'rpc-unavailable' }))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error('history RPC timeout'), { code: 'rpc-timeout' })) }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer }); this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }
  call(method, params) { ensure(READ_METHODS.has(method), 'read-only', 'history reader 禁止写入会话'); return this._call(method, params) }
  close() { this.abort('rpc-closed', 'history reader 已关闭') }
}
async function withReader(options, fn) { const c = new ReadClient(options); try { await c.initialize(); return await fn(c) } finally { c.close() } }
async function metadata(endpoint, options = {}) {
  return withReader({ cwd: endpoint.cwd, ...options }, async c => {
    const result = await c.call('thread/read', { threadId: endpoint.sessionId, includeTurns: false })
    ensure(result?.thread?.id === endpoint.sessionId, 'identity-mismatch', 'Codex 返回了其他会话')
    ensure(samePath(real(result.thread.cwd), real(endpoint.cwd)), 'workspace-mismatch', 'Codex 会话工作区不一致')
    return { ...result.thread, bridgeReaderMode: c.mode }
  })
}
async function history(endpoint, options = {}) {
  return withReader({ cwd: endpoint.cwd, ...options }, async c => {
    const meta = await c.call('thread/read', { threadId: endpoint.sessionId, includeTurns: false })
    ensure(meta?.thread?.id === endpoint.sessionId && samePath(real(meta.thread.cwd), real(endpoint.cwd)), 'identity-mismatch', 'history 目标不匹配')
    let cursor = null; const turns = [], gaps = []; const seen = new Set()
    for (let page = 0; page < 3; page++) {
      let result
      try { result = await c.call('thread/turns/list', { threadId: endpoint.sessionId, limit: 10, itemsView: 'full', sortDirection: 'desc', ...(cursor ? { cursor } : {}) }) }
      catch (e) {
        if (page || e.code !== 'rpc-error') throw e
        const legacy = await c.call('thread/read', { threadId: endpoint.sessionId, includeTurns: true })
        ensure(Array.isArray(legacy.thread?.turns), 'history-unavailable', '此安装不支持分页或完整历史')
        return { endpoint, turns: legacy.thread.turns.slice(-30), gaps: legacy.thread.turns.length > 30 ? ['earlier-turns-truncated'] : [], source: 'thread/read' }
      }
      ensure(Array.isArray(result.data), 'invalid-response', '无法解析 history page')
      turns.push(...result.data); cursor = result.nextCursor
      if (!cursor) break
      ensure(!seen.has(cursor), 'invalid-response', 'history cursor 循环'); seen.add(cursor)
    }
    if (cursor) gaps.push('earlier-turns-truncated')
    return { endpoint, turns: turns.reverse(), gaps, source: 'thread/turns/list' }
  })
}
async function queue(endpoint, message, options = {}) {
  ensure(Buffer.byteLength(message) <= 4096, 'context-too-large', '通知正文必须小于 4 KiB')
  const exec = options.run || run
  try {
    const check = await exec(options.command || 'codex', ['queue', '--help'], { cwd: endpoint.cwd })
    ensure(check.exitCode === 0 && /--thread/.test(check.stdout) && /--message/.test(check.stdout), 'unsupported', 'Codex queue 不可用')
    await (options.metadata || metadata)(endpoint, { command: options.command })
  } catch (e) { e.beforeSubmission = true; throw e }
  const result = await exec(options.command || 'codex', ['queue', '--thread', endpoint.sessionId, '--message', message, '-C', endpoint.cwd], { cwd: endpoint.cwd, timeoutMs: 20000 })
  // Only known queue acknowledgment text is treated as queued. A zero exit alone is unknown.
  const acknowledgment = result.stdout.trim().match(/^Queued message ([a-zA-Z0-9_-]+) for thread ([a-zA-Z0-9_-]+)\.$/)
  const queued = result.exitCode === 0 && acknowledgment?.[2] === endpoint.sessionId && !result.timedOut && !result.overflow
  return { deliveryStatus: queued ? 'queued' : 'delivery-unknown', transportMessageId: queued ? acknowledgment[1] : null, exitCode: result.exitCode, timedOut: result.timedOut, detail: queued ? 'CLI acknowledged queue; receiver receipt still required' : 'CLI did not provide a verified queue acknowledgment' }
}
async function resume(endpoint, message, options = {}) {
  try {
    ensure(options.explicit === true, 'action-not-authorized', 'resume 必须显式选择')
    const meta = await (options.metadata || metadata)(endpoint, { command: options.command })
    ensure(meta.status?.type === 'idle' && meta.bridgeReaderMode === 'proxy', 'owner-unknown', '只有已验证空闲的所属 daemon 会话可 resume')
    // CLI cannot atomically reserve an externally owned idle thread. Do not race its TUI.
    ensure(options.exclusiveOwner === true, 'owner-unknown', 'resume 需要桥接独占的主控运行者')
  } catch (e) { e.beforeSubmission = true; throw e }
  const result = await (options.run || run)(options.command || 'codex', ['exec', 'resume', endpoint.sessionId, '--json', '-'], { cwd: endpoint.cwd, stdin: message, timeoutMs: 120000 })
  const rows = result.stdout.split('\n').flatMap(s => { try { return [JSON.parse(s)] } catch { return [] } })
  ensure(rows.some(r => r.type === 'thread.started' && r.thread_id === endpoint.sessionId), 'identity-mismatch', 'resume 未返回原目标身份')
  return { deliveryStatus: 'delivery-unknown', exitCode: result.exitCode, detail: 'Resumed; receipt required' }
}
module.exports = { ReadClient, withReader, metadata, history, queue, resume }
