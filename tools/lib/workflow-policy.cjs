// Embedded in the two development templates by sync-workflow-policy.mjs.
const VERIFY_COMMANDS_SCHEMA = { type: 'array', items: { type: 'object', additionalProperties: false,
  required: ['command', 'exitCode', 'output'], properties: {
    command: { type: 'string' }, exitCode: { type: 'number' }, output: { type: 'string' },
  } } }
function validateWorkflowArgs(input) {
  if (input?.reviewMode !== undefined && !['auto', 'always'].includes(input.reviewMode)) throw new Error('reviewMode must be auto or always')
  if (input?.alwaysReview !== undefined && typeof input.alwaysReview !== 'boolean') throw new Error('alwaysReview must be boolean')
  if (input?.reviewMode === 'auto' && input?.alwaysReview === true) throw new Error('reviewMode conflicts with alwaysReview')
  if (input?.advisorModel !== undefined && !['auto', 'opus', 'fable'].includes(input.advisorModel)) throw new Error('advisorModel must be auto, opus or fable')
  if (input?.advisorMax !== undefined && (!Number.isInteger(input.advisorMax) || input.advisorMax < 0 || input.advisorMax > 5)) throw new Error('advisorMax must be an integer from 0 to 5')
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
    const impl = await llmAgent([prompt, ADVISOR_TRIGGER, '继续前先读取当前 git diff，保留已完成修改。', `顾问历史=${JSON.stringify(history)}`].join('\n'),
      { label: config.label && attempt === 0 ? config.label : `${config.label ?? 'implement'}:${attempt}`, phase: 'Implement', model: config.model, effort: 'xhigh', schema: config.schema })
    if (!impl) return { status: 'failed', at: 'Implement', implementationAdvisor: summary() }
    const error = advisorRequestError(impl)
    if (error) return { status: 'failed', at: 'ImplementAdvisor', reason: error, impl, implementationAdvisor: summary() }
    if (impl.done) return { status: 'completed', impl, implementationAdvisor: summary() }
    if (!impl.needsAdvisor || history.length >= limit) return { status: 'needs-rework', at: 'Implement', reason: impl.needsAdvisor ? '顾问预算耗尽，保留当前工作树' : impl.honesty, impl, implementationAdvisor: summary() }
    const model = selectAdvisorModel(config.args, impl)
    const entry = { call: history.length + 1, model, question: impl.advisorQuestion, blockingEvidence: impl.blockingEvidence }
    history.push(entry)
    const advice = await llmAgent(['你是 Implement Advisor，只读顾问。亲自核对源码、caller 和 git diff；禁止写文件、提交或执行有副作用命令。只提供证据和下一步，不接管实现。', prompt, JSON.stringify(impl),
      '局部可解选 continue/change-approach；计划失效选 replan；需要新用户决定选 stop-and-ask。禁止自行扩大范围。'].join('\n'),
      { label: `implement-advisor:${entry.call}`, phase: 'Review', effortRole: 'Advisor', model, effort: 'high', disallowedTools: ['Edit','Write'], schema: {
        type: 'object', additionalProperties: false, required: ['verdict','reasoning','nextStep','evidence'], properties: {
          verdict: { type: 'string', enum: ['continue','change-approach','replan','stop-and-ask'] }, reasoning: { type: 'string' }, nextStep: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } },
        } } })
    if (!advice) return { status: 'failed', at: 'ImplementAdvisor', impl, implementationAdvisor: summary() }
    Object.assign(entry, advice)
    if (['replan','stop-and-ask'].includes(advice.verdict)) return { status: advice.verdict === 'replan' ? 'replan-required' : 'need-decision', at: 'ImplementAdvisor', reason: advice.nextStep, dirtyWorktree: true, impl, implementationAdvisor: summary() }
  }
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
