// Embedded in the two development templates by sync-workflow-policy.mjs.
const VERIFY_COMMANDS_SCHEMA = { type: 'array', items: { type: 'object', additionalProperties: false,
  required: ['command', 'exitCode', 'output'], properties: {
    command: { type: 'string' }, exitCode: { type: 'number' }, output: { type: 'string' },
  } } }
function validateWorkflowArgs(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('Workflow args must be a structured object')
  if (input?.reviewMode !== undefined && !['auto', 'always'].includes(input.reviewMode)) throw new Error('reviewMode must be auto or always')
  if (input?.alwaysReview !== undefined && typeof input.alwaysReview !== 'boolean') throw new Error('alwaysReview must be boolean')
  if (input?.reviewMode === 'auto' && input?.alwaysReview === true) throw new Error('reviewMode conflicts with alwaysReview')
  if (input?.advisorModel !== undefined && !['auto', 'opus', 'fable'].includes(input.advisorModel)) throw new Error('advisorModel must be auto, opus or fable')
  if (input?.advisorMax !== undefined && (!Number.isInteger(input.advisorMax) || input.advisorMax < 0 || input.advisorMax > 5)) throw new Error('advisorMax must be an integer from 0 to 5')
  if (input.parallelMode !== undefined && !['auto', 'off'].includes(input.parallelMode)) throw new Error('parallelMode must be auto or off')
  if (input.reviewTiming !== undefined && !['milestone', 'plan'].includes(input.reviewTiming)) throw new Error('reviewTiming must be milestone or plan')
  if (input.maxParallel !== undefined && (!Number.isInteger(input.maxParallel) || input.maxParallel < 1 || input.maxParallel > 4)) throw new Error('maxParallel must be an integer from 1 to 4')
  if (input.workflowSliceId !== undefined && (typeof input.workflowSliceId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.workflowSliceId))) throw new Error('workflowSliceId must be a stable identifier (letters, digits, _ or -)')
  if (input.checkpointKey !== undefined && (typeof input.checkpointKey !== 'string' || !input.checkpointKey.trim() || /[\x00\r\n]/.test(input.checkpointKey))) throw new Error('checkpointKey must be non-empty text')
  for (const key of ['repo', 'worktree', 'changeDir', 'proposalDoc', 'designDoc', 'tasksDoc', 'planDoc', 'specsGlob', 'gitnexusRepo']) {
    const value = input?.[key]
    if (value === undefined || (key === 'planDoc' && value === '')) continue
    if (typeof value !== 'string' || !value.trim() || /[\x00\r\n]/.test(value) || /^["'`]|["'`]$/.test(value)) throw new Error(`args.${key}: invalid path/name`)
  }
  if (input?.gitnexusRepo && (/[\\/]/.test(input.gitnexusRepo) || input.gitnexusRepo === input.repo || input.gitnexusRepo === input.worktree)) throw new Error('gitnexusRepo must be an index name, not a worktree path')
  for (const key of ['maxPatchRounds', 'maxReviewRounds', 'maxRepairRounds']) {
    if (input?.[key] !== undefined && (!Number.isInteger(input[key]) || input[key] < 0 || input[key] > 5)) throw new Error(`${key} must be an integer from 0 to 5`)
  }
}
const REVIEW_ASSESSMENT_SCHEMA = { type: 'object', additionalProperties: false,
  description: '亲自读码后评估难度、风险、不确定性；证据必须具体。LOW/MEDIUM 且低风险、验收充分才可跳过 Review。',
  required: ['difficulty', 'risk', 'uncertainty', 'evidence', 'unknowns', 'validationAdequate'],
  properties: {
    difficulty: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
    risk: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
    uncertainty: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
    evidence: { type: 'array', items: { type: 'string' } },
    unknowns: { type: 'array', items: { type: 'string' } }, validationAdequate: { type: 'boolean' },
  } }
function decideReview(input, recon, plan, route, forced = false) {
  const reasons = []
  const a = plan?.reviewAssessment
  if (input?.reviewMode === 'always' || input?.alwaysReview === true) reasons.push('用户要求始终审查')
  if (forced) reasons.push('架构决议或恢复修订')
  if (['HIGH', 'CRITICAL'].includes(route) || ['HIGH', 'CRITICAL'].includes(plan?.predictedImpact?.risk)) reasons.push('路由或计划高风险')
  if (!a || !['LOW','MEDIUM'].includes(a.difficulty) || a.risk !== 'LOW' || a.uncertainty !== 'LOW' || a.validationAdequate !== true || !a.evidence?.some(x => typeof x === 'string' && x.trim()) || !Array.isArray(a.unknowns) || a.unknowns.length) reasons.push('难度、风险、不确定性或验证证据未满足跳过条件')
  if (['security','migration','concurrency','stateMachine','persistence'].some(k => recon?.riskFlags?.[k])) reasons.push('安全/迁移/并发/状态/持久化语义')
  if (recon?.contracts?.publicApi || recon?.contracts?.schemaChange || recon?.modules?.crossRepo || recon?.openspec?.architectureGap || recon?.openspec?.semanticSpecChange || plan?.openspecEdits?.some(e => e.semantic)) reasons.push('公共契约或架构变更')
  if (!recon?.uncertainty || Object.values(recon.uncertainty).some(Boolean) || !Array.isArray(recon?.unknowns) || recon.unknowns.length) reasons.push('Recon 证据不完整')
  return { mode: input?.reviewMode ?? (input?.alwaysReview ? 'always' : 'auto'), required: reasons.length > 0, reasons: reasons.length ? reasons : ['低/中难度、低风险、证据与验收充分'], assessment: a ?? null }
}
function extendImplementationSchema(schema) {
  const fields = {
    needsAdvisor: { type: 'boolean' }, advisorQuestion: { type: 'string' },
    blockingEvidence: { type: 'array', items: { type: 'string' } },
    advisorTier: { type: 'string', enum: ['fable', 'opus'], description: '局部疑难/方案裁决选 fable；架构、公共契约、并发状态所有权推理选 opus；无求助时填 fable' },
  }
  for (const [key, value] of Object.entries(fields)) { if (!schema.required.includes(key)) schema.required.push(key); schema.properties[key] = value }
}
function decideOpenSpecReview(input, recon, plan, route, architectureDecision = false) {
  if (input.reviewTiming === 'plan' || input.reviewMode === 'always' || input.alwaysReview === true) return decideReview(input, recon, plan, route, architectureDecision)
  const reasons = []
  const spec = recon?.openspec
  if (architectureDecision || spec?.architectureGap || spec?.semanticSpecChange || plan.openspecEdits?.some(e => e.semantic)) reasons.push('新增架构/需求语义需要提前审查')
  if (!spec || spec.coverage !== 'complete' || spec.drift || spec.missingArtifacts?.length) reasons.push('OpenSpec 设计缺失或已漂移')
  if (!recon?.uncertainty || Object.values(recon.uncertainty).some(Boolean) || recon.unknowns?.length || plan.reviewAssessment?.unknowns?.length || plan.reviewAssessment?.uncertainty !== 'LOW') reasons.push('关键假设或证据未确认')
  return { mode: 'milestone', required: reasons.length > 0, reasons: reasons.length ? reasons : ['复用完整 OpenSpec，Review 延至里程碑完成'], assessment: plan.reviewAssessment ?? null }
}
function milestoneReviewState(recon, verify) {
  const spec = recon?.openspec
  const ids = spec?.milestoneTaskIds
  const previous = spec?.completedTaskIds
  const observed = verify?.milestoneTaskIds
  const validIds = xs => Array.isArray(xs) && xs.length > 0 && xs.every(id => typeof id === 'string' && id.trim()) && new Set(xs).size === xs.length
  const evidence = xs => Array.isArray(xs) && xs.some(e => typeof e === 'string' && e.trim())
  if (!validIds(ids) || !Array.isArray(previous) || previous.some(id => !ids.includes(id)) || !validIds(observed) || !evidence(spec.milestoneEvidence) || !evidence(verify?.milestoneEvidence)) return { status: 'unconfirmed', complete: false, reason: '缺少里程碑任务全集或 tasks.md 核对证据，不能宣称里程碑完成' }
  if (ids.length !== observed.length || ids.some(id => !observed.includes(id))) return { status: 'unconfirmed', complete: false, reason: '里程碑任务全集在 Recon 与 Verify 之间发生变化' }
  const completed = new Set([...previous, ...(verify.completedTaskIds ?? [])])
  const remainingTaskIds = ids.filter(id => !completed.has(id))
  return { status: remainingTaskIds.length ? 'pending' : 'required', complete: !remainingTaskIds.length, taskIds: ids, remainingTaskIds }
}
const ADVISOR_TRIGGER = '实现 Agent 自己判断：普通编译/类型/格式错误自行修复；取证后仍根因不明、关键假设冲突、跨模块高风险或多个方案难取舍时，done=false、needsAdvisor=true，提供具体 advisorQuestion 和非空 blockingEvidence。advisorTier：局部诊断/独立裁决用 fable，架构/公共契约/并发状态所有权推理用 opus。done=true 必须 needsAdvisor=false。不得越出 whitelist 或修改 requirement/design；顾问只给建议，由你核对并实现。'
function advisorRequestError(impl) {
  if (impl.done && impl.needsAdvisor) return 'done 与 needsAdvisor 冲突'
  if (impl.needsAdvisor && (!impl.advisorQuestion?.trim() || !impl.blockingEvidence?.some(x => typeof x === 'string' && x.trim()) || !['opus','fable'].includes(impl.advisorTier))) return '顾问请求缺少问题、证据或有效档位'
  return null
}
function selectAdvisorModel(input, impl) { return input?.advisorModel && input.advisorModel !== 'auto' ? input.advisorModel : impl.advisorTier }
async function implementWithAdvisor(prompt, config) {
  const history = config.history ?? []
  const limit = config.args?.advisorMax ?? 3
  const summary = () => ({ calls: history.length, outcomes: history })
  for (let attempt = 0; attempt <= limit; attempt++) {
    phase('Implement')
    const localHistory = config.sliceId ? history.filter(h => h.sliceId === config.sliceId) : history
    const impl = attempt === 0 && Object.prototype.hasOwnProperty.call(config, 'initialImpl') ? config.initialImpl : await llmAgent([prompt, ADVISOR_TRIGGER, '继续前先读取当前 git diff，保留已完成修改。', `顾问历史=${JSON.stringify(localHistory)}`].join('\n'),
      { label: config.label && attempt === 0 ? config.label : `${config.label ?? 'implement'}:${attempt}`, phase: 'Implement', model: config.model, effort: 'xhigh', schema: config.schema, disallowedTools: config.disallowedTools ?? [] })
    if (!impl) return { status: 'failed', at: 'Implement', implementationAdvisor: summary() }
    const error = config.slice ? sliceResultError(config.slice, impl) : advisorRequestError(impl)
    if (error) return { status: 'failed', at: 'ImplementAdvisor', reason: error, impl, implementationAdvisor: summary() }
    if (impl.done) return { status: 'completed', impl, implementationAdvisor: summary() }
    if (!impl.needsAdvisor || history.length >= limit) return { status: 'needs-rework', at: 'Implement', reason: impl.needsAdvisor ? '顾问预算耗尽，保留当前工作树' : impl.honesty, impl, implementationAdvisor: summary() }
    const model = selectAdvisorModel(config.args, impl)
    const entry = { call: history.length + 1, model, question: impl.advisorQuestion, blockingEvidence: impl.blockingEvidence }
    if (config.sliceId) entry.sliceId = config.sliceId
    history.push(entry)
    const advice = await llmAgent(['你是 Implement Advisor，只读顾问。亲自核对源码、caller 和 git diff；禁止写文件、提交或执行有副作用命令。只提供证据和下一步，不接管实现。', prompt, JSON.stringify(impl),
      '局部可解选 continue/change-approach；计划失效选 replan；需要新用户决定选 stop-and-ask。禁止自行扩大范围。'].join('\n'),
      { label: `implement-advisor:${entry.call}`, phase: 'Review', effortRole: 'Advisor', model, effort: 'high', disallowedTools: ['Edit','Write', ...(config.disallowedTools ?? [])], schema: {
        type: 'object', additionalProperties: false, required: ['verdict','reasoning','nextStep','evidence'], properties: {
          verdict: { type: 'string', enum: ['continue','change-approach','replan','stop-and-ask'] }, reasoning: { type: 'string' }, nextStep: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } },
        } } })
    if (!advice) return { status: 'failed', at: 'ImplementAdvisor', impl, implementationAdvisor: summary() }
    Object.assign(entry, advice)
    if (['replan','stop-and-ask'].includes(advice.verdict)) return { status: advice.verdict === 'replan' ? 'replan-required' : 'need-decision', at: 'ImplementAdvisor', reason: advice.nextStep, dirtyWorktree: true, impl, implementationAdvisor: summary() }
  }
}
function extendSliceExecutionSchema(schema) {
  const strings = { type: 'array', items: { type: 'string' } }
  const slice = schema.properties.slices.items
  slice.required.push('execution')
  slice.properties.execution = { type: 'object', additionalProperties: false,
    description: '只为有实质独立工作量的切片启用 parallelSafe；不为凑并发拆微小任务。依赖/共享写资源/读取文件必须完整；契约不确定则 false。contextFiles 也须列入计划 evidenceDependencies 或 whitelist，以便恢复时核对指纹。',
    required: ['parallelSafe', 'dependsOn', 'resources', 'contextFiles', 'acceptance'], properties: {
      parallelSafe: { type: 'boolean' }, dependsOn: { ...strings, description: '必须先完成的 slice id；无依赖填 []' },
      resources: { ...strings, description: '非文件共享可变资源标识（数据库、生成目录、测试服务等）；无则 []' },
      contextFiles: { ...strings, description: '实现需要读取的精确 repo 相对路径；包含相关契约/调用方，不重复传全仓库' },
      acceptance: { ...strings, description: '本切片具体行为验收；全量测试交最终 Verify，切片只做必要局部检查' },
    } }
}
function workflowCheckpointKey(base, input) {
  const key = input.checkpointKey ?? base
  const suffix = input.workflowSliceId ? `::slice:${input.workflowSliceId}` : ''
  return suffix && !key.endsWith(suffix) ? key + suffix : key
}
// Conservative Windows-compatible comparison. Ambiguous paths disable fan-out.
function executionPath(value) {
  if (typeof value !== 'string' || !value.trim() || /[\x00\r\n:*?\[\]{}]/.test(value)) return null
  const p = value.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '')
  if (!p || p.startsWith('/') || p.split('/').some(s => !s || s === '.' || s === '..' || /[. ]$/.test(s))) return null
  return p.toLowerCase()
}
function executionPathsOverlap(a, b) { return a === b || a.startsWith(b + '/') || b.startsWith(a + '/') }
function buildImplementationSchedule(plan, input) {
  const serial = reason => ({ mode: 'serial', reason, waves: [] })
  const blocked = reason => ({ mode: 'blocked', reason, waves: [] })
  const limit = input.maxParallel ?? 2
  if (input.parallelMode === 'off' || limit === 1 || plan.slices.length < 2) return serial('单实现者或显式串行')
  if (plan.slices.some(s => !s.execution)) return serial('旧计划或缺少并行证据，保留单实现者')
  const ids = new Set(plan.slices.map(s => s.id))
  if (ids.size !== plan.slices.length || [...ids].some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id))) return blocked('切片 id 无效或重复')
  const whitelist = plan.whitelist.map(executionPath)
  const forbidden = plan.mustNotTouch.map(executionPath)
  const evidence = (plan.evidenceDependencies ?? []).map(executionPath)
  if ([...whitelist, ...forbidden, ...evidence].some(p => !p)) return serial('路径不是精确 repo 相对路径')
  const entries = []
  for (const slice of plan.slices) {
    const e = slice.execution
    if (typeof e.parallelSafe !== 'boolean' || ['dependsOn', 'resources', 'contextFiles', 'acceptance'].some(k => !Array.isArray(e[k]) || e[k].some(v => typeof v !== 'string' || !v.trim()))) return blocked(`切片 ${slice.id} 并行元数据不完整`)
    if (e.dependsOn.some(id => !ids.has(id) || id === slice.id)) return blocked(`切片 ${slice.id} 依赖不存在或依赖自身`)
    if (!e.acceptance.length || !slice.files.length) return serial(`切片 ${slice.id} 缺少验收或文件归属`)
    const writes = slice.files.map(executionPath), reads = e.contextFiles.map(executionPath)
    if ([...writes, ...reads].some(p => !p)) return serial('切片路径含目录通配符或不明确路径')
    if (writes.some(p => !whitelist.includes(p) || forbidden.some(f => executionPathsOverlap(p, f)))) return blocked(`切片 ${slice.id} 越出白名单或触碰保护路径`)
    if (reads.some(p => !whitelist.includes(p) && !evidence.includes(p))) return serial(`切片 ${slice.id} 读取依赖未纳入计划指纹`)
    entries.push({ slice, writes, reads, resources: e.resources.map(r => r.trim().toLowerCase()) })
  }
  if (whitelist.some(p => !entries.some(e => e.writes.includes(p)))) return serial('白名单存在未分配文件，保留单实现者避免漏项')
  const conflict = (a, b) => !a.slice.execution.parallelSafe || !b.slice.execution.parallelSafe ||
    a.writes.some(p => [...b.writes, ...b.reads].some(q => executionPathsOverlap(p, q))) ||
    b.writes.some(p => a.reads.some(q => executionPathsOverlap(p, q))) ||
    a.resources.some(r => b.resources.includes(r))
  const done = new Set(), waves = []
  while (done.size < entries.length) {
    const ready = entries.filter(e => !done.has(e.slice.id) && e.slice.execution.dependsOn.every(id => done.has(id)))
    if (!ready.length) return blocked('切片依赖存在循环')
    const wave = []
    for (const e of ready) if (wave.length < limit && wave.every(other => !conflict(e, other))) wave.push(e)
    waves.push(wave.map(e => e.slice.id))
    for (const e of wave) done.add(e.slice.id)
  }
  return waves.some(w => w.length > 1) ? { mode: 'parallel', reason: '依赖与文件/资源冲突检查通过', waves } : serial('依赖或共享资源要求串行')
}
function sliceResultError(slice, impl) {
  if (!impl || typeof impl.done !== 'boolean' || !Array.isArray(impl.filesChanged) || !Array.isArray(impl.notImplemented)) return '切片缺少结构化结果'
  const allowed = slice.files.map(executionPath)
  if (impl.filesChanged.some(f => { const p = executionPath(typeof f === 'string' ? f : f?.path); return !p || !allowed.includes(p) })) return `切片 ${slice.id} 报告了归属外修改`
  if (impl.done && impl.notImplemented.length) return `切片 ${slice.id} 声称完成但仍有未实现项`
  return advisorRequestError(impl)
}
async function runParallelImplementation(plan, config, schedule) {
  const history = config.history ?? []
  const outcomes = []
  const summary = () => ({ calls: history.length, outcomes: history })
  const finish = (status, extra = {}) => ({ status, at: 'Implement', dirtyWorktree: true,
    implementationAdvisor: summary(), execution: { ...schedule, outcomes }, ...extra })
  const leafTools = ['Agent', 'Task', 'Workflow']
  const promptFor = slice => [
    '你是切片实现者。仅完成下列切片；其他切片由调度器负责。', config.context,
    `依据=${plan.executionBasis ?? plan.rootCause ?? ''}`, config.decided ?? '',
    `切片=${JSON.stringify(slice)}`, `禁止触碰=${JSON.stringify(plan.mustNotTouch)}`,
    `前置结果=${JSON.stringify(outcomes.filter(o => slice.execution.dependsOn.includes(o.sliceId)).map(o => ({ sliceId: o.sliceId, filesChanged: o.impl?.filesChanged, honesty: o.impl?.honesty })))}`,
    '只写本切片 files 中的精确文件；先 Read/git diff 确认已有修改，保留已完成内容。文件路径按 repo 相对路径返回。改业务 symbol 前做 GitNexus impact，改后 Read 核实。',
    '按 contextFiles 定向读取相关契约与 caller；若缺失关键上下文或发现未声明依赖/共享资源，停止并返回证据，不能猜测或越界。',
    '只做必要局部验证；不运行全量测试、不装依赖、不改共享生成产物，不改 OpenSpec、tasks 勾选，不 commit/push/deploy/写共享数据库，不派发子代理。最终集成 Verify 由脚本统一执行。',
    ADVISOR_TRIGGER,
  ].filter(Boolean).join('\n')
  for (const ids of schedule.waves) {
    const slices = ids.map(id => plan.slices.find(s => s.id === id))
    // Materialize prompts before dispatch so sibling completion order cannot affect cache inputs.
    const prompts = slices.map(promptFor)
    phase('Implement')
    const batch = await parallel(slices.map((slice, i) => async () => {
      try {
        const impl = await llmAgent(prompts[i], { label: `implement:slice:${slice.id}:0`, phase: 'Implement', model: config.model, effort: 'xhigh', schema: config.schema, disallowedTools: leafTools })
        return { sliceId: slice.id, impl, error: sliceResultError(slice, impl) }
      } catch (error) { return { sliceId: slice.id, impl: null, error: String(error?.message ?? error) } }
    }))
    // Do not filter null results or return before all writers in this wave settle.
    for (let i = 0; i < slices.length; i++) outcomes.push(batch?.[i] ?? { sliceId: slices[i].id, impl: null, error: '切片结果缺失' })
    const failed = outcomes.find(o => o.error || (!o.impl?.done && !o.impl?.needsAdvisor))
    if (failed) return finish('needs-rework', { reason: failed.error || failed.impl?.honesty || '切片未完成' })
    // Advisors run at the barrier, in stable slice order, sharing one run-wide budget.
    for (let i = 0; i < slices.length; i++) {
      const outcome = outcomes.find(o => o.sliceId === slices[i].id)
      if (outcome.impl.done) continue
      let result
      try {
        result = await implementWithAdvisor(prompts[i], { ...config, history, initialImpl: outcome.impl,
          slice: slices[i], sliceId: slices[i].id, label: `implement:slice:${slices[i].id}`, disallowedTools: leafTools })
      } catch (error) {
        outcome.error = String(error?.message ?? error)
        return finish('failed', { at: 'ImplementAdvisor', reason: outcome.error })
      }
      outcome.impl = result.impl ?? outcome.impl
      outcome.status = result.status
      if (result.status !== 'completed') return finish(result.status, { reason: result.reason, at: result.at })
    }
  }
  const changed = outcomes.flatMap(o => o.impl.filesChanged)
  const filesChanged = changed.filter((f, i) => changed.findIndex(other => executionPath(typeof other === 'string' ? other : other.path) === executionPath(typeof f === 'string' ? f : f.path)) === i)
  return finish('completed', { impl: { done: true, filesChanged, notImplemented: [], needsAdvisor: false, advisorQuestion: '', advisorTier: 'fable', blockingEvidence: [],
    honesty: outcomes.map(o => `${o.sliceId}: ${o.impl.honesty || '待集成验证'}`).join('\n'), execution: { ...schedule, outcomes } } })
}
function reviewPlanError(before, after, review, decisions) {
  if (!after || after.verdict !== 'implementable') return '修订计划不可执行'
  if (JSON.stringify(before.decisionPoints) !== JSON.stringify(after.decisionPoints)) return '修订不得改变已拍板 decisionPoints；需要新决策时返回 block'
  if (before.mustNotTouch.some(p => !after.mustNotTouch.includes(p))) return '修订不得移除 mustNotTouch'
  const ids = new Set()
  for (const slice of after.slices) {
    if (ids.has(slice.id)) return '重复 slice id'
    ids.add(slice.id)
    if (slice.files.some(p => !after.whitelist.includes(p) || after.mustNotTouch.includes(p))) return 'slice 文件不在 whitelist 或命中 mustNotTouch'
  }
  for (const slice of before.slices) {
    if (!review.affectedSliceIds.includes(slice.id) && JSON.stringify(slice) !== JSON.stringify(after.slices.find(s => s.id === slice.id))) return '修订修改了未声明受影响的 slice'
  }
  for (const value of [...after.whitelist, ...after.mustNotTouch, ...(after.evidenceDependencies || []), ...after.slices.flatMap(s => s.files)]) {
    if (typeof value !== 'string' || !value.trim() || /[\x00\r\n]/.test(value)) return '修订计划含非法路径'
  }
  if ((after.openspecEdits || []).some(e => e.semantic && (!e.decisionId || !Object.prototype.hasOwnProperty.call(decisions, e.decisionId)))) return '语义编辑未绑定已拍板 decisionId'
  return null
}
async function reviewRepairPlan(initial, config) {
  const arr = { type: 'array', items: { type: 'string' } }
  const schema = { type: 'object', additionalProperties: false,
    required: ['verdict', 'scope', 'requiresArchitect', 'affectedSliceIds', 'findings', 'revisedPlan'],
    properties: {
      verdict: { type: 'string', enum: ['approve', 'revise', 'block'] },
      scope: { type: 'string', enum: ['none', 'mechanical', 'slice', 'architecture'] },
      requiresArchitect: { type: 'boolean' }, affectedSliceIds: arr, findings: arr,
      revisedPlan: { anyOf: [PLAN_SCHEMA, { type: 'null' }] },
    } }
  const history = []
  let current = initial
  let rounds = 0
  const limit = config.maxRounds ?? 2
  const context = `任务=${config.task}; repo=${config.repo}; decisions=${JSON.stringify(config.decisions)}。只读源码，输出结构化计划，不写业务代码/文件，不 commit/push/deploy。`
  for (;;) {
    phase('Review')
    const review = await llmAgent([
      '你是 Plan Reviewer。亲自检查源码、caller、契约与测试。明确局部问题直接在 revisedPlan 返回修订后的完整计划，不只提意见。',
      'findings 必须含 file:line/命令输出/具体计划字段证据及修改原因；affectedSliceIds 列出全部需修改/删除的原 slice。保留未变 slice、decisionPoints 和 mustNotTouch。',
      '机械/单 slice 修正：revise + revisedPlan。跨模块方案分歧或新增架构推理：revise + revisedPlan=null，准确填写 scope/requiresArchitect；由外层组织讨论。',
      '需要用户决定新的范围、架构取舍或外部资源时 block 并说明所需决策。通过时 approve + revisedPlan=null，不得一边修改一边自我放行。',
      context, `当前计划=${JSON.stringify(current)}`, `前轮证据=${JSON.stringify(history)}`,
    ].join('\n'), { label: `review:plan:${rounds}`, phase: 'Review', model: config.reviewModel, effort: 'high', schema })
    if (!review) return { status: 'failed', at: 'Review', plan: current, rounds, history }
    history.push({ role: 'review', ...review })
    if (review.verdict === 'approve') {
      if (review.revisedPlan) return { status: 'blocked', at: 'Review', reason: 'approve 不得携带未复审的修改', plan: current, review, rounds, history }
      return { status: 'approved', plan: current, review, rounds, history }
    }
    if (review.verdict === 'block' || !review.findings.length || rounds >= limit) return { status: 'blocked', at: 'Review', reason: review.verdict === 'block' ? review.findings.join('\n') : '修订无证据或达到轮次上限', plan: current, review, rounds, history }
    rounds++
    let next = review.revisedPlan
    const complex = review.requiresArchitect || review.scope === 'architecture' || review.affectedSliceIds.length > 1
    if (complex || !next) {
      const model = review.requiresArchitect || review.scope === 'architecture' ? config.strongModel : config.planModel
      const proposal = await llmAgent([context, '你是 Planner。仅针对以下证据提出局部修订方案，不写文件；保留其余计划及用户决策。', JSON.stringify(current), JSON.stringify(review)].join('\n'),
        { label: `review:proposal:${rounds}`, phase: 'Review', model, effort: 'high', schema: PLAN_SCHEMA })
      if (!proposal) return { status: 'failed', at: 'ReviewDiscussion', plan: current, rounds, history }
      const critique = await llmAgent([context, '你是独立 Challenger。核对提案与原计划/问题证据，输出带证据的残余问题 findings；不写文件。', JSON.stringify({ original: current, review, proposal })].join('\n'),
        { label: `review:challenge:${rounds}`, phase: 'Review', model: config.reviewModel, effort: 'high', schema: { type: 'object', additionalProperties: false, required: ['findings'], properties: { findings: arr } } })
      if (!critique) return { status: 'failed', at: 'ReviewDiscussion', plan: current, rounds, history }
      next = await llmAgent([context, '你是唯一计划汇总者。吸收提案和质疑，输出完整修订计划；只能修改 affectedSliceIds 指定范围，保留已有决策。无法安全收敛输出 verdict=blocked。', JSON.stringify({ original: current, review, proposal, critique })].join('\n'),
        { label: `review:synthesis:${rounds}`, phase: 'Review', model, effort: 'high', schema: PLAN_SCHEMA })
      history.push({ role: 'discussion', proposal, critique, revisedPlan: next })
      if (!next) return { status: 'failed', at: 'ReviewDiscussion', plan: current, rounds, history }
    }
    const error = reviewPlanError(current, next, review, config.decisions || {})
    if (error || JSON.stringify(next) === JSON.stringify(current)) return { status: 'blocked', at: 'ReviewPatch', reason: error || '修订没有进展', plan: current, review, rounds, history }
    current = next
    // A new independent call must approve the changed plan, even for direct repair.
  }
}
function verificationFailure(result, exitKey, evidenceKey, requiredCommands = []) {
  if (!result) return 'Verify 未返回结构化结果'
  if (result.status !== 'green') return 'Verify 未通过'
  if (result[exitKey] !== 0 || result.testFailed !== 0) return 'Verify 声称 green 但退出码/失败计数不通过'
  if (!Number.isInteger(result.testTotal) || result.testTotal < 0 || result.testPassed !== result.testTotal) return 'Verify 测试计数不一致'
  if (typeof result[evidenceKey] !== 'string' || !result[evidenceKey].trim()) return 'Verify 缺少原始输出证据'
  if (result.gitnexus === 'mismatch') return 'GitNexus 索引与工作树不匹配'
  if (!['verified', 'unavailable'].includes(result.gitnexus)) return 'GitNexus 状态未记录'
  if (!Array.isArray(result.commands) || requiredCommands.some(command => !result.commands.some(c => c.command === command && c.exitCode === 0))) return 'Verify 缺少必需命令及零退出码'
  if (result.commands.some(c => c.exitCode !== 0 || typeof c.output !== 'string')) return 'Verify 命令失败或缺少输出字段'
  return null
}
