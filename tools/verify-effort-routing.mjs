#!/usr/bin/env node
// 离线执行五个模板内的真实 effort-policy wrapper；stub agent 只捕获 opts，不调用模型。

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const templates = [
  'templates/four-phase.js',
  'templates/gitnexus-routed.js',
  'templates/openspec-incremental.js',
  'templates/stage-with-gates.js',
  'templates/readonly-recon.js',
]

function loadPolicy(relative, args) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8')
  const match = source.match(/\/\/ effort-policy:start[^\n]*\n([\s\S]*?)\/\/ effort-policy:end/)
  assert.ok(match, `${relative}: effort policy 标记缺失`)
  const calls = []
  const logs = []
  const agent = (_prompt, opts) => { calls.push(opts); return { ok: true } }
  const log = row => logs.push(String(row))
  const policy = Function('args', 'agent', 'log', `${match[1]}\nreturn { llmAgent, PHASE_EFFORT_KEYS, normalizeEffortOverrides, resolveAgentEffort, resolveAgentEffortFrom, MODEL_EFFORT_KEYS }`)(args, agent, log)
  return { ...policy, calls, logs }
}

for (const relative of templates) {
  const defaults = loadPolicy(relative, {})
  const phase = defaults.PHASE_EFFORT_KEYS[0]
  defaults.llmAgent('x', { label: 'default', phase, model: 'opus', effort: 'high', disallowedTools: ['Bash'] })
  assert.equal(defaults.calls[0].effort, 'high', `${relative}: 未覆盖时保持调用点默认 effort`)
  assert.deepEqual(defaults.calls[0].disallowedTools, ['Bash', 'SendMessage', 'ListAgents'], `${relative}: 工具禁用项必须合并`)
  assert.equal('effortRole' in defaults.calls[0], false, `${relative}: 内部 effortRole 不得传给 runtime`)

  const model = loadPolicy(relative, { modelEfforts: { opus: 'max', sonnet: 'low' } })
  model.llmAgent('x', { label: 'opus', phase, model: 'opus', effort: 'high' })
  model.llmAgent('x', { label: 'sonnet', phase, model: 'sonnet', effort: 'xhigh' })
  assert.equal(model.calls[0].effort, 'max', `${relative}: opus 模型覆盖`)
  assert.equal(model.calls[1].effort, 'low', `${relative}: opus 覆盖不得污染 sonnet`)

  const phased = loadPolicy(relative, { modelEfforts: { opus: 'max' }, phaseEfforts: { [phase]: 'xhigh' } })
  phased.llmAgent('x', { label: 'phase', phase, model: 'opus', effort: 'high' })
  assert.equal(phased.calls[0].effort, 'xhigh', `${relative}: 阶段覆盖优先于模型覆盖`)

  const reset = loadPolicy(relative, { modelEfforts: { opus: 'max' }, phaseEfforts: { [phase]: null } })
  reset.llmAgent('x', { label: 'reset', phase, model: 'opus', effort: 'high' })
  assert.equal(reset.calls[0].effort, 'high', `${relative}: null 恢复调用点默认`)

  const omitted = loadPolicy(relative, {})
  omitted.llmAgent('x', { label: 'omitted', phase, model: 'haiku' })
  assert.equal('effort' in omitted.calls[0], false, `${relative}: 原本省略 effort 时继续省略`)
  assert.match(omitted.logs[0], /actualModel=unknown effectiveEffort=unknown/, `${relative}: 未观测字段必须标 unknown`)

  if (defaults.PHASE_EFFORT_KEYS.includes('Advisor')) {
    const roles = loadPolicy(relative, { phaseEfforts: { Review: 'low', Advisor: 'max' } })
    roles.llmAgent('x', { label: 'advisor', phase: 'Review', effortRole: 'Advisor', model: 'fable', effort: 'high' })
    roles.llmAgent('x', { label: 'review', phase: 'Review', model: 'fable', effort: 'high' })
    assert.equal(roles.calls[0].effort, 'max', `${relative}: Advisor 独立覆盖`)
    assert.equal(roles.calls[1].effort, 'low', `${relative}: Review 独立覆盖`)
  }

  assert.throws(() => loadPolicy(relative, { modelEfforts: { opus: 'extreme' } }), /effort 无效/, `${relative}: 非法 effort fail-fast`)
  assert.throws(() => loadPolicy(relative, { modelEfforts: { astra: 'max' } }), /未知键/, `${relative}: 未知逻辑模型 fail-fast`)
  assert.throws(() => loadPolicy(relative, { phaseEfforts: { UnknownPhase: 'high' } }), /未知键/, `${relative}: 未知阶段 fail-fast`)
}

for (const relative of ['templates/gitnexus-routed.js', 'templates/openspec-incremental.js']) {
  const current = loadPolicy(relative, { modelEfforts: { opus: 'max', sonnet: 'high' }, phaseEfforts: { Review: 'xhigh' } })
  const priorModels = current.normalizeEffortOverrides({ opus: 'max', sonnet: 'high' }, 'prior.modelEfforts', current.MODEL_EFFORT_KEYS)
  const priorPhases = current.normalizeEffortOverrides({ Review: 'high' }, 'prior.phaseEfforts', current.PHASE_EFFORT_KEYS)
  const currentPlan = current.resolveAgentEffort({ phase: 'Plan', model: 'opus', effort: 'high' }).effort
  const priorPlan = current.resolveAgentEffortFrom(priorModels, priorPhases, { phase: 'Plan', model: 'opus', effort: 'high' }).effort
  const currentReview = current.resolveAgentEffort({ phase: 'Review', model: 'fable', effort: 'high' }).effort
  const priorReview = current.resolveAgentEffortFrom(priorModels, priorPhases, { phase: 'Review', model: 'fable', effort: 'high' }).effort
  assert.equal(currentPlan, priorPlan, `${relative}: 只提高 Review 时 Plan effort 不变，可保留 BasePlan`)
  assert.notEqual(currentReview, priorReview, `${relative}: Review effort 改变，必须使 Review 输入失效`)
  const source = fs.readFileSync(path.join(root, relative), 'utf8')
  assert.match(source, /reconArtifactHit[^\n]*samePriorAgentEffort|reconArtifactHit[\s\S]{0,150}samePriorAgentEffort/, `${relative}: Recon hit 必须比较 effort`)
  assert.match(source, /basePlanArtifactHit[\s\S]{0,350}samePriorAgentEffort/, `${relative}: BasePlan hit 必须比较 Plan effort`)
  assert.match(source, /reviewEffort:/, `${relative}: Review canonical 必须包含 requested effort`)
}

const auditTemplates = ['templates/gitnexus-routed.js', 'templates/openspec-incremental.js']
for (const relative of auditTemplates) {
  const audit = loadPolicy(relative, { phaseEfforts: { Review: 'low', Audit: 'max' } })
  audit.llmAgent('x', { label: 'audit', phase: 'Audit', effortRole: 'Audit', model: 'fable', effort: 'high' })
  assert.equal(audit.calls[0].effort, 'max', `${relative}: Audit 独立覆盖`)
}

// 代表性整模板执行：不是只测抽出的 helper，确认 readonly workflow 实际把覆盖传给 stub agent。
{
  const relative = 'templates/readonly-recon.js'
  const source = fs.readFileSync(path.join(root, relative), 'utf8').replace('export const meta =', 'const meta =')
  const calls = []
  const agent = async (_prompt, opts) => {
    calls.push(opts)
    if (opts.label === 'synthesize') return '# stub synthesis'
    return { topic: opts.label, findings: [], evidence: [], unknowns: [] }
  }
  const phase = () => {}
  const parallel = fns => Promise.all(fns.map(fn => fn()))
  const log = () => {}
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const run = new AsyncFunction('args', 'agent', 'phase', 'parallel', 'log', source)
  const result = await run(
    { repo: 'D:/stub', gitnexusRepo: 'stub', phaseEfforts: { Recon: 'low', Synthesize: 'max' } },
    agent, phase, parallel, log,
  )
  assert.ok(result.reconCount > 0, `${relative}: 代表性 workflow 应完成 Recon`)
  assert.ok(calls.filter(x => x.phase === 'Recon').every(x => x.effort === 'low'), `${relative}: 整模板 Recon 覆盖应传入 stub agent`)
  assert.equal(calls.find(x => x.phase === 'Synthesize')?.effort, 'max', `${relative}: 整模板 Synthesize 覆盖应传入 stub agent`)
}

// 入口 hook 只负责要求 authoring 结构化自然语言，不在正则中猜用户意图。
{
  const out = execFileSync(process.execPath, [path.join(root, 'hooks/workflow-intake.cjs')], {
    input: JSON.stringify({ session_id: 'effort-hook-test', cwd: root, prompt: 'workflow 修复登录，opus 使用 max' }),
    encoding: 'utf8',
  })
  const parsed = JSON.parse(out)
  const context = parsed.hookSpecificOutput.additionalContext
  assert.match(context, /args\.modelEfforts\/args\.phaseEfforts/, 'workflow intake 必须要求结构化 effort args')
  assert.match(context, /阶段覆盖优先/, 'workflow intake 必须声明覆盖优先级')
}

console.log(`effort routing 验证通过：${templates.length} 个模板，默认/模型/阶段/角色/null/非法值均已执行`)
