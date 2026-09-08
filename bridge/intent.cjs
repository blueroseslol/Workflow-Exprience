'use strict'
const { ensure, authorize, scopeHash } = require('./contracts.cjs')
// Semantic classification belongs to the current main agent. This validator checks
// provenance and explicit decisions, never guesses authorization from keywords.
function validateDecision(decision, userPrompt) {
  if (!decision || decision.enabled === false) return { enabled: false, requestedActions: [] }
  ensure(decision.source === 'user-explicit' && typeof userPrompt === 'string', 'intent-required', '仅接受当前用户原始指令')
  ensure(typeof decision.evidenceQuote === 'string' && decision.evidenceQuote.trim() && userPrompt.includes(decision.evidenceQuote), 'intent-required', '缺少可定位用户原话')
  const lines = userPrompt.split(/\r?\n/); let fenced = false
  const direct = lines.filter(line => { if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return false }; return !fenced && !/^\s*>/.test(line) }).join('\n')
  ensure(direct.includes(decision.evidenceQuote), 'intent-required', '代码块/引用不能单独作为发送授权')
  ensure(decision.negated !== true && decision.quoted !== true && decision.readOnly !== true, 'intent-required', '否定、引用、只读意图不授予发送权限')
  ensure(Array.isArray(decision.requestedActions) && decision.requestedActions.length && decision.requestedActions.every(a => ['read-context', 'dispatch-work', 'notify-terminal'].includes(a)), 'invalid-contract', '无效请求动作')
  if (decision.requestedActions.some(a => a !== 'read-context')) ensure(decision.targetResolved === true, 'needs-target', '发送目标尚未唯一解析')
  return { enabled: true, source: 'user-explicit', userInstruction: userPrompt, evidenceQuote: decision.evidenceQuote, requestedActions: decision.requestedActions }
}
function canResume(r, { requestId, scope, cancelled = false } = {}) {
  ensure(!cancelled, 'cancelled', '该协作请求已撤销')
  ensure(r.requestId === requestId && r.intent.scopeHash === scope && scopeHash(r) === scope, 'scope-mismatch', '不同任务不得继承协作授权')
  return true
}
function intakeContext() {
  return '若用户明确要求 Codex 与 Claude Code CLI 交接或回传，Read references/session-bridge.md；主会话语义解析后写入独立 bridge request，执行准备/终态动作。普通任务、引用、否定、仅 Codex 审阅不得启用。已绑定同一 request 可延续其显式授权，用户撤销优先；不要把通信字段加入 workflow args/BasePlan。'
}
module.exports = { validateDecision, canResume, intakeContext }
