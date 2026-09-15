// Recovery only: author from the failed run's approved plan and original args.
export const meta = {
  name: 'recover-verify', description: '检查已有实现，仅补缺失部分并恢复验证',
  phases: [{ title: 'Recon' }, { title: 'Implement' }, { title: 'Verify' }],
}
const input = args || {}
function textPath(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\x00\r\n]/.test(value) || /^["'`]|["'`]$/.test(value)) throw new Error(`${label}: invalid path/name`)
  return value
}
const repo = textPath(input.worktree || input.repo, 'worktree')
const index = textPath(input.gitnexusRepo, 'gitnexusRepo')
if (/[\\/]/.test(index) || index === repo) throw new Error('gitnexusRepo must be an index name')
const plan = input.approvedPlan
if (!plan || !Array.isArray(plan.whitelist) || !plan.whitelist.length || !Array.isArray(plan.testCommands) || !plan.testCommands.length) throw new Error('recovery requires the original approvedPlan with whitelist and testCommands')
for (const p of plan.whitelist) textPath(p, 'whitelist')
const maxRepair = input.maxRepairRounds ?? 2
if (!Number.isInteger(maxRepair) || maxRepair < 0 || maxRepair > 5) throw new Error('maxRepairRounds must be 0..5')
const strings = { type: 'array', items: { type: 'string' } }
const stateSchema = { type: 'object', additionalProperties: false,
  required: ['state', 'evidence', 'missing'], properties: {
    state: { type: 'string', enum: ['complete', 'partial', 'not-started', 'unknown'] }, evidence: strings, missing: strings,
  } }
const verifySchema = { type: 'object', additionalProperties: false,
  required: ['status', 'commands', 'gitnexus', 'evidence'], properties: {
    status: { type: 'string', enum: ['green', 'red'] }, evidence: strings,
    gitnexus: { type: 'string', enum: ['verified', 'unavailable', 'mismatch'] },
    commands: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['command', 'exitCode', 'output'],
      properties: { command: { type: 'string' }, exitCode: { type: 'number' }, output: { type: 'string' } } } },
  } }
// recovery-effort-policy is synchronized by sync-workflow-policy.mjs.
// recovery-effort:start
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const MODEL_EFFORT_KEYS = ['haiku', 'sonnet', 'opus', 'fable']
const PHASE_EFFORT_KEYS = ['Recon', 'Plan', 'Review', 'SpecSync', 'Preflight', 'Implement', 'Verify', 'Audit', 'Commit']
function normalizeEffortOverrides(raw, kind, allowedKeys) {
  if (raw == null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${kind} 必须是对象`)
  const out = {}
  for (const [inputKey, value] of Object.entries(raw)) {
    const key = allowedKeys.find(k => k.toLowerCase() === String(inputKey).toLowerCase())
    if (!key) throw new Error(`${kind} 包含未知键: ${inputKey}`)
    if (value !== null && !EFFORT_LEVELS.has(value)) throw new Error(`${kind}.${key} 的 effort 无效: ${value}`)
    out[key] = value
  }
  return out
}
const MODEL_EFFORTS = normalizeEffortOverrides(args?.modelEfforts, 'modelEfforts', MODEL_EFFORT_KEYS)
const PHASE_EFFORTS = normalizeEffortOverrides(args?.phaseEfforts, 'phaseEfforts', PHASE_EFFORT_KEYS)
function resolveAgentEffortFrom(modelEfforts, phaseEfforts, opts) {
  const role = opts.effortRole ?? opts.phase ?? null
  const modelKey = MODEL_EFFORT_KEYS.find(k => k === String(opts.model ?? '').toLowerCase())
  const hasRole = role != null && Object.prototype.hasOwnProperty.call(phaseEfforts, role)
  const hasModel = modelKey != null && Object.prototype.hasOwnProperty.call(modelEfforts, modelKey)
  if (hasRole && phaseEfforts[role] !== null) return { effort: phaseEfforts[role], source: `phase:${role}` }
  if (hasRole) return { effort: opts.effort, source: `phase:${role}:default` }
  if (hasModel && modelEfforts[modelKey] !== null) return { effort: modelEfforts[modelKey], source: `model:${modelKey}` }
  if (hasModel) return { effort: opts.effort, source: `model:${modelKey}:default` }
  return { effort: opts.effort, source: Object.prototype.hasOwnProperty.call(opts, 'effort') ? 'call-default' : 'omitted' }
}
function resolveAgentEffort(opts) { return resolveAgentEffortFrom(MODEL_EFFORTS, PHASE_EFFORTS, opts) }
function llmAgent(prompt, opts = {}) {
  const { effortRole, ...agentOpts } = opts
  const resolved = resolveAgentEffort(opts)
  if (resolved.effort === undefined) delete agentOpts.effort
  else agentOpts.effort = resolved.effort
  log(`[agent-config] label=${opts.label ?? '-'} phase=${opts.phase ?? '-'} role=${effortRole ?? opts.phase ?? '-'} model=${opts.model ?? '-'} requestedEffort=${resolved.effort ?? 'default'} source=${resolved.source} actualModel=unknown effectiveEffort=unknown`)
  return agent(prompt, {
    ...agentOpts,
    disallowedTools: [...new Set([...(agentOpts.disallowedTools ?? []), 'SendMessage', 'ListAgents'])],
  })
}
// recovery-effort:end
const call = (prompt, opts) => llmAgent([
  `worktree=${repo}; gitnexusRepo=${index}; approvedPlan=${JSON.stringify(plan)}`,
  '所有路径来自上述结构化输入，禁止从自由文本推导路径。不覆盖无关 dirty/未跟踪内容，不 commit/push/deploy/数据库写入/勾选任务。', prompt,
].join('\n'), opts)
phase('Recon')
const state = await call('只读：读取失败运行证据、git status --short、git diff、未跟踪文件和目标文件。逐项核实原计划是否已实现。complete 必须有逐项证据；partial 列缺失项；无法判定 unknown。',
  { label: 'recovery:state', phase: 'Recon', model: input.reconModel || 'haiku', schema: stateSchema })
if (!state) return { status: 'failed', at: 'RecoveryState' }
if (state.state === 'unknown' || !state.evidence.length) return { status: 'blocked', at: 'RecoveryState', state }
const history = []
let needsRepair = state.state !== 'complete'
let verification = null
let repairCount = 0
for (;;) {
  if (needsRepair) {
    if (repairCount >= maxRepair) return { status: 'needs-rework', state, verification, history }
    repairCount++
    phase('Implement')
    const repair = await call(`只补缺失项或修真实失败，不整文件覆盖、不重放已完成补丁/复制。改 symbol 前 GitNexus impact，改前/改后 Read。超出计划返回 unknown。状态=${JSON.stringify(state)}；失败=${JSON.stringify(verification)}`,
      { label: `recovery:repair:${repairCount}`, phase: 'Implement', model: input.defaultModel || 'sonnet', effort: 'high', schema: stateSchema })
    history.push({ repair, verification })
    if (!repair || repair.state !== 'complete' || !repair.evidence.length) return { status: repair ? 'needs-rework' : 'failed', at: 'Repair', state, repair, history }
  }
  phase('Verify')
  verification = await call('独立执行 approvedPlan.testCommands 中每条原命令，并运行 git diff --check、git diff --cached --check。commands 逐条保留原命令、退出码和原始输出。用准确索引/工作树执行 GitNexus detect_changes(scope=all)，不可用如实标记，mismatch 不得换仓库冒充。',
    { label: `recovery:verify:${repairCount}`, phase: 'Verify', model: input.verifyModel || 'haiku', schema: verifySchema })
  if (!verification) return { status: 'failed', at: 'Verify', state, history }
  const required = [...plan.testCommands, 'git diff --check', 'git diff --cached --check']
  const passed = verification.status === 'green' && verification.gitnexus !== 'mismatch' && verification.evidence.length > 0 &&
    required.every(command => verification.commands.some(c => c.command === command && c.exitCode === 0)) &&
    verification.commands.every(c => c.exitCode === 0)
  if (passed) return { status: 'green', state, verification, repairCount, history }
  if (verification.gitnexus === 'mismatch') return { status: 'blocked', at: 'GitNexus', state, verification, history }
  needsRepair = true
}
