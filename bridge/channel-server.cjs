#!/usr/bin/env node
'use strict'
const { Server, StdioServerTransport, ListToolsRequestSchema, CallToolRequestSchema } = require('./vendor/mcp-sdk.cjs')
const { Store } = require('./store.cjs')
const { Receiver } = require('./channel.cjs')
const C = require('./contracts.cjs')

async function main() {
  // These values come from the Claude parent, never from tool arguments.
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID
  C.ensure(C.id(sessionId), 'identity-mismatch', 'Channel 必须由 Claude Code 启动并提供 CLAUDE_CODE_SESSION_ID')
  const store = new Store(process.env.CLAUDE_PROJECT_DIR || process.cwd(), process.env.WORKFLOW_BRIDGE_STORE_ROOT)
  const receiver = new Receiver(store, sessionId)
  const server = new Server({ name: 'workflow-bridge', version: '1.0.0' }, {
    capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
    instructions: '仅在用户要求接入 Workflow Bridge 时调用 bridge_connect 激活当前连接；普通会话不激活。每条 Channel 消息先 bridge_ack；仅 execute:true 可开始，execute:false 表示重复，禁止重跑。外层主会话按 request/context 与 session-bridge.md 执行 Workflow，用 bridge_attach_run 绑定 run。真实终态后把完整 Result v1 写入 request 同目录 candidate-result.json，再调用 bridge_complete：插件验证结果并自动回传 Codex。失败只用 bridge_drain 补通知并报告 deliveryErrorCode/diagnostic，禁止重新开发。不要让 Workflow 子代理直接调用 codex queue。',
  })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: 'bridge_connect', description: '用户要求接入协作时，激活当前 Claude 会话的 Bridge 收件连接。返回真实 session ID；每次连接重建需重新激活。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'bridge_ack', description: '确认当前 Claude 会话收到指定消息。只在 execute:true 时执行，重复 ACK 不重跑。', inputSchema: { type: 'object', properties: { requestId: { type: 'string' }, messageId: { type: 'string' }, sha256: { type: 'string' } }, required: ['requestId', 'messageId', 'sha256'], additionalProperties: false } },
    { name: 'bridge_pending', description: '查询绑定到当前会话的消息和回执；查询本身不执行任务。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'bridge_reject', description: '目标明确拒绝尚未 ACK/启动的任务，记录原因并释放收件队列。已 ACK 的任务必须用真实 Workflow 终态关闭。', inputSchema: { type: 'object', properties: { requestId: { type: 'string' }, messageId: { type: 'string' }, sha256: { type: 'string' }, reason: { type: 'string' } }, required: ['requestId', 'messageId', 'sha256', 'reason'], additionalProperties: false } },
    { name: 'bridge_attach_run', description: '由外层主会话绑定当前请求的真实 Workflow run，要求已 ACK。', inputSchema: { type: 'object', properties: { requestId: { type: 'string' }, runId: { type: 'string' } }, required: ['requestId', 'runId'], additionalProperties: false } },
    { name: 'bridge_complete', description: '读取 request 同目录 candidate-result.json，验证真实 Workflow 终态并自动通过 Codex CLI 回传结果。查看 deliveryStatus/error；重复调用不重跑开发。', inputSchema: { type: 'object', properties: { requestId: { type: 'string' } }, required: ['requestId'], additionalProperties: false } },
    { name: 'bridge_drain', description: '只回传已经验证的结果，不重跑开发。仅已证明未提交的预检/启动失败允许 retryPreflight=true；未知发送结果禁止盲目重发。', inputSchema: { type: 'object', properties: { requestId: { type: 'string' }, retryPreflight: { type: 'boolean' } }, required: ['requestId'], additionalProperties: false } },
  ] }))
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const { name, arguments: args = {} } = request.params
      C.ensure(['bridge_ack', 'bridge_pending', 'bridge_connect', 'bridge_reject', 'bridge_attach_run', 'bridge_complete', 'bridge_drain'].includes(name), 'unknown-tool', '未知工具')
      let result
      if (name === 'bridge_ack') result = receiver.acknowledge(args)
      else if (name === 'bridge_connect') result = receiver.connect()
      else if (name === 'bridge_reject') result = receiver.reject(args)
      else if (name === 'bridge_attach_run') result = receiver.attachRun(args.requestId, args.runId)
      else if (name === 'bridge_complete') result = await receiver.complete(args.requestId)
      else if (name === 'bridge_drain') result = await receiver.drain(args.requestId, { retryPreflight: args.retryPreflight === true })
      else result = receiver.pending()
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (e) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: e.code || 'channel-error', message: e.message }) }] } }
  })
  let timer, busy = false, closed = false, lastError
  const tick = async () => {
    if (busy || closed) return
    busy = true
    try {
      await receiver.pump(params => server.notification({ method: 'notifications/claude/channel', params }))
      if (lastError) receiver.reportError(null)
      lastError = null
    }
    catch (e) {
      // No protocol pollution and no log flood for a persistent blocker.
      const error = `${e.code || 'channel-error'}: ${e.message}`
      if (error !== lastError) process.stderr.write(`${error}\n`)
      try { receiver.reportError(e.code || 'channel-error') } catch {}
      lastError = error
    } finally { busy = false }
  }
  const close = () => { if (closed) return; closed = true; clearInterval(timer); receiver.close() }
  server.oninitialized = () => { timer = setInterval(tick, 1000); void tick() }
  server.onclose = close
  process.once('SIGTERM', () => { close(); process.exit(0) })
  process.once('SIGINT', () => { close(); process.exit(0) })
  try { await server.connect(new StdioServerTransport()) } catch (e) { close(); throw e }
}
if (require.main === module) main().catch(e => { process.stderr.write(`${e.code || 'channel-error'}: ${e.message}\n`); process.exitCode = 1 })
module.exports = { main }
