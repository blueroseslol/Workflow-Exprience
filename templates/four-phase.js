// 四阶段开发模板：Plan(opus) → Review(fable) → Preflight(haiku) → Implement(sonnet) → Verify(haiku)
// 用法：复制本文件内容，替换 CONFIG 段与各 prompt 中的 <占位>，通过 Workflow({script}) 或 scriptPath 运行。
// 沙箱禁 import/require，故本文件是「可粘贴模板」而非可引用的库。

export const meta = {
  name: '<kebab-case-name>',
  description: '<一句话，会显示在权限对话框>',
  phases: [
    { title: 'Plan', model: 'opus' },
    { title: 'Review', model: 'fable' },
    { title: 'Preflight', model: 'haiku' },
    { title: 'Implement', model: 'sonnet' },
    { title: 'Verify', model: 'haiku' },
  ],
}

// effort-policy:start — 模板沙箱禁 import，五个成品模板保持同一份小型纯 JS policy。
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const MODEL_EFFORT_KEYS = ['haiku', 'sonnet', 'opus', 'fable']
const PHASE_EFFORT_KEYS = ['Plan', 'Review', 'Advisor', 'Preflight', 'Implement', 'Verify']
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
// effort-policy:end

// ---------- CONFIG（改这里） ----------
const REPO = '<D:/path/to/repo>'
const TASKS = REPO + '/<openspec/changes/xxx/tasks.md>'
const MILESTONE = '<5.4>'
const TS = args?.ts ?? 'unknown-ts'                 // 时间戳必须外部注入：脚本内 Date.now() 会 throw
const MODEL_PLAN = args?.planModel ?? 'opus'
const MODEL_REVIEW = args?.reviewModel ?? 'fable'
const MODEL_PREFLIGHT = args?.preflightModel ?? 'haiku'
const MODEL_IMPLEMENT = args?.implementModel ?? 'sonnet'
const MODEL_VERIFY = args?.verifyModel ?? 'haiku'
const ADVISOR_MODEL = args?.advisorModel ?? 'fable' // 传 'opus' 可切换
const ADVISOR_MAX = args?.advisorMax ?? 5

// 用户已拍板的决议（不得当成 blocker 再问）
const DECIDED = args?.decisions ?? {
  // '开 5.4 改 y3': true,
}

// ---------- 复用常量 ----------
const S_STR_ARR = { type: 'array', items: { type: 'string' } }

const K_FILE_LINE = '每条结论必须引用你亲自 Read 到的 file:line，禁止凭摘要、记忆或他人转述。'
const K_WHITELIST = '只允许修改 whitelist 内的文件；mustNotTouch 内的一律不动。越界即失败。'
const K_READ_BEFORE_EDIT = '改前先 Read 目标文件确认现状，改后再 Read 一次确认落盘符合预期。'
const K_TICK_ONLY = '没有测试输出或命令退出码作证据，不得勾选任何 checkbox。只允许勾选本次交付的条目。'
const K_GIT_SAFE = '禁止 git add . 与 git add -A，逐文件 add；feat 与 docs 分两笔提交；不 push。'
const K_FAIL_LOUD = '如实报告。测试失败就写失败并附原始输出，不得伪造成功、不得吞掉错误。'

// ---------- Schemas ----------
const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'rootCause', 'slices', 'whitelist', 'mustNotTouch', 'testCommands', 'openQuestionsForUser'],
  properties: {
    verdict: { type: 'string', enum: ['implementable', 'blocked'] },
    rootCause: { type: 'string', description: '根因，必须含 file:line' },
    slices: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'files', 'rationale'],
        properties: {
          title: { type: 'string' },
          files: S_STR_ARR,
          rationale: { type: 'string', description: '含 file:line' },
        },
      },
    },
    whitelist: S_STR_ARR,
    mustNotTouch: S_STR_ARR,
    testCommands: S_STR_ARR,
    rollback: { type: 'string' },
    openQuestionsForUser: S_STR_ARR,
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'blockers', 'concerns'],
  properties: {
    verdict: { type: 'string', enum: ['approve', 'approve-with-changes', 'block'] },
    blockers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['issue', 'evidence'],
        properties: {
          issue: { type: 'string' },
          evidence: { type: 'string', description: 'file:line 或计划原文' },
        },
      },
    },
    concerns: S_STR_ARR,
  },
}

const PREFLIGHT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ready', 'baseline', 'blockers'],
  properties: {
    ready: { type: 'boolean' },
    baseline: {
      type: 'object',
      additionalProperties: false,
      required: ['testTotal', 'testPassed', 'testFailed', 'typecheckExit'],
      properties: {
        testTotal: { type: 'number' },
        testPassed: { type: 'number' },
        testFailed: { type: 'number' },
        typecheckExit: { type: 'number' },
      },
    },
    blockers: S_STR_ARR,
  },
}

const IMPLEMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['done', 'filesChanged', 'notImplemented', 'honesty'],
  properties: {
    done: { type: 'boolean' },
    filesChanged: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'what'],
        properties: { path: { type: 'string' }, what: { type: 'string' } },
      },
    },
    notImplemented: { type: 'array', items: { type: 'string' }, description: '计划里有但本轮没做的，必须诚实列出' },
    honesty: { type: 'string', description: '有什么是你没验证的' },
  },
}

// 取证型：要退出码与原始输出尾巴，而不是一个「是否通过」的布尔值
const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'vitestTail', 'testTotal', 'testPassed', 'testFailed', 'typecheckSrcExit', 'baselineDelta', 'commits', 'scanFindings'],
  properties: {
    status: { type: 'string', enum: ['green', 'red'] },
    vitestTail: { type: 'string', description: 'vitest 真实尾部输出，原样粘贴' },
    testTotal: { type: 'number' },
    testPassed: { type: 'number' },
    testFailed: { type: 'number' },
    typecheckSrcExit: { type: 'number' },
    baselineDelta: { type: 'string', description: '与 Preflight 基线对比；低于基线视为回退' },
    commits: S_STR_ARR,
    scanFindings: S_STR_ARR,
  },
}

const ADVISOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reasoning', 'nextStep'],
  properties: {
    verdict: { type: 'string', enum: ['proceed', 'change-approach', 'stop-and-ask'] },
    reasoning: { type: 'string' },
    nextStep: { type: 'string' },
  },
}

// ---------- advisor ----------
let advisorCalls = 0
async function askAdvisor(question, context) {
  if (advisorCalls >= ADVISOR_MAX) {
    log(`advisor 已达上限 ${ADVISOR_MAX}，不再求助`)
    return null
  }
  advisorCalls++ // ★ 调用前自增：agent() 失败会返回 null，放调用后会死循环
  return await llmAgent(
    `你是 advisor，任务是给出裁决而非附和。\n\n问题：${question}\n\n上下文：\n${context}\n\n` +
      '如果方案有问题就说 change-approach 并给出具体替代；如果需要用户拍板就说 stop-and-ask。',
    { label: `advisor:${advisorCalls}`, phase: 'Review', effortRole: 'Advisor', model: ADVISOR_MODEL, effort: 'high', schema: ADVISOR_SCHEMA }
  )
}

// ---------- Plan ----------
phase('Plan')
const plan = await llmAgent(
  [
    `你是 ${MILESTONE} 的规划者。只规划，不改代码，不 commit。`,
    '',
    '必读（亲自 Read，禁止凭摘要）：',
    `- ${TASKS} 中 ${MILESTONE} 原文及其冻结条款`,
    '- <列出实现相关的源码文件>',
    '',
    '用户已拍板（不得当成 blocker 再问）：',
    ...Object.entries(DECIDED).map(([k, v]) => `- ${k}：${JSON.stringify(v)}`),
    '',
    '硬规则：',
    `- ${K_FILE_LINE}`,
    `- ${K_TICK_ONLY}`,
    '- whitelist 要精确到文件；凡不在 whitelist 的都要进 mustNotTouch。',
    '- 若存在你无法自行决定的问题，写进 openQuestionsForUser，不要自作主张。',
  ].join('\n'),
  { label: 'plan', phase: 'Plan', model: MODEL_PLAN, effort: 'high', schema: PLAN_SCHEMA }
)

if (!plan) return { status: 'failed', at: 'Plan' }
if (plan.verdict === 'blocked') return { status: 'blocked', reason: plan.rootCause, questions: plan.openQuestionsForUser }
if (plan.openQuestionsForUser.length) {
  return { status: 'need-decision', milestone: MILESTONE, questions: plan.openQuestionsForUser, plan }
}

const planDigest = [
  `根因：${plan.rootCause}`,
  `切片：\n${plan.slices.map(s => `- ${s.title}（${s.files.join(', ')}）— ${s.rationale}`).join('\n')}`,
  `whitelist：${plan.whitelist.join(', ')}`,
  `mustNotTouch：${plan.mustNotTouch.join(', ')}`,
  `测试命令：${plan.testCommands.join(' && ')}`,
].join('\n\n')

// ---------- Review ----------
phase('Review')
const review = await llmAgent(
  `你是 advisor，只审计划不写代码。尽力找出这份计划会失败的地方，不要附和。\n\n${planDigest}\n\n` +
    'block 条件：根因无 file:line 支撑 / whitelist 与切片文件不一致 / 缺回滚路径 / 把未验证的假设当事实。',
  { label: 'review:plan', phase: 'Review', model: MODEL_REVIEW, effort: 'high', schema: REVIEW_SCHEMA }
)

if (review?.verdict === 'block') {
  return { status: 'blocked', at: 'Review', blockers: review.blockers, plan }
}

// ---------- Preflight ----------
phase('Preflight')
const pre = await llmAgent(
  [
    '你是环境与基线层。装依赖、建目录、跑一次基线测试，不改业务代码。',
    `基线命令：${plan.testCommands.join(' && ')}`,
    '把真实的测试数字与 typecheck 退出码填进 schema。',
    K_FAIL_LOUD,
  ].join('\n'),
  { label: 'preflight', phase: 'Preflight', model: MODEL_PREFLIGHT, schema: PREFLIGHT_SCHEMA }
)

if (pre && !pre.ready) return { status: 'blocked', at: 'Preflight', blockers: pre.blockers }

// ---------- Implement ----------
phase('Implement')
const impl = await llmAgent(
  [
    '你是实现层。按计划逐切片实现。',
    '',
    planDigest,
    '',
    '硬规则：',
    `- ${K_WHITELIST}`,
    `- ${K_READ_BEFORE_EDIT}`,
    `- ${K_FAIL_LOUD}`,
    '- 不要 commit，不要 push（Verify 层负责）。',
    '- 计划里有而你没做的，必须写进 notImplemented，不许假装做了。',
  ].join('\n'),
  { label: 'implement', phase: 'Implement', model: MODEL_IMPLEMENT, effort: 'xhigh', schema: IMPLEMENT_SCHEMA }
)

// 实现受阻时求助 advisor
if (impl && !impl.done) {
  const adv = await askAdvisor(
    '实现未完成，是继续、换方案，还是需要用户拍板？',
    `未实现项：\n${impl.notImplemented.join('\n')}\n\n诚实声明：${impl.honesty}`
  )
  if (adv?.verdict === 'stop-and-ask') {
    return { status: 'need-decision', milestone: MILESTONE, questions: [adv.nextStep], impl }
  }
}

// ---------- Verify ----------
phase('Verify')
const verify = await llmAgent(
  [
    '你是独立验证 + 提交层。不要相信上一层的自述，自己跑一遍。',
    `测试命令：${plan.testCommands.join(' && ')}`,
    pre ? `Preflight 基线：${pre.baseline.testPassed}/${pre.baseline.testTotal} 通过，typecheck exit=${pre.baseline.typecheckExit}` : '（无基线）',
    '低于基线视为回退，status 填 red。',
    '',
    `全绿后提交：${K_GIT_SAFE}`,
    `commit message 引用 ${MILESTONE}；证据不足不得勾选 tasks.md 的 checkbox（${K_TICK_ONLY}）。`,
    K_FAIL_LOUD,
  ].join('\n'),
  { label: 'verify', phase: 'Verify', model: MODEL_VERIFY, schema: VERIFY_SCHEMA }
)

return {
  status: verify?.status ?? 'unknown',
  milestone: MILESTONE,
  ts: TS,
  plan,
  review,
  impl,
  verify,
  advisorCalls,
  broadcast: `[${MILESTONE}] ${verify?.status ?? '?'} · ${verify?.testPassed ?? '?'}/${verify?.testTotal ?? '?'} 测试 · ${(verify?.commits ?? []).length} 次提交`,
}
