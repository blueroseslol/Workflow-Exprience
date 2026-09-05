// openspec-incremental.js — OpenSpec-first 增量规划模板（实验，v4）
//
// 有匹配 OpenSpec change 时使用；无 OpenSpec 回退 gitnexus-routed.js。
// 核心：OpenSpec=长期 Plan IR；BasePlan=execution overlay；DecisionApply=JS；
// Review revise=局部 PlanPatch；只有新增架构推理才 Opus；批准后的 delta 经 SpecSync 写回。
//
// 本模板保留动态路由、Preflight、Verify、routeMiss、Final Audit、Commit Gate。
// 若项目强依赖 gitnexus-routed.js 的 Implement Advisor loop，可在 authoring 时把其 Implement/Advisor
// 段原样移植到本模板；Plan/Decision/Review/SpecSync 层不要退回 replanFeedback Full Replan。

export const meta = {
  name: '<kebab-case-name>',
  description: '<一句话>；OpenSpec-first 增量执行',
  phases: [
    { title: 'Recon', model: 'haiku' },
    { title: 'Plan' },
    { title: 'Review' },
    { title: 'SpecSync', model: 'sonnet' },
    { title: 'Preflight', model: 'haiku' },
    { title: 'Implement' },
    { title: 'Verify', model: 'haiku' },
    { title: 'Audit' },
    { title: 'Commit', model: 'haiku' },
  ],
}

// effort-policy:start — 模板沙箱禁 import，五个成品模板保持同一份小型纯 JS policy。
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
// effort-policy:end

const REPO = args?.repo ?? '<D:/path/to/repo>'
const GNX = args?.gitnexusRepo ?? '<indexed-repo-name>'
const WORKTREE = args?.worktree ?? REPO
const TASK = args?.task ?? '<任务描述>'
const CHANGE_DIR = args?.changeDir ?? `${REPO}/openspec/changes/<change-id>`
const PROPOSAL_DOC = args?.proposalDoc ?? `${CHANGE_DIR}/proposal.md`
const DESIGN_DOC = args?.designDoc ?? `${CHANGE_DIR}/design.md`
const TASKS_DOC = args?.tasksDoc ?? `${CHANGE_DIR}/tasks.md`
const PLAN_DOC = args?.planDoc ?? '' // 项目自定义 plan.md，可空
const SPECS_GLOB = args?.specsGlob ?? `${CHANGE_DIR}/specs/**/*.md`
const MILESTONE = args?.milestone ?? '<task/milestone>'
const TS = args?.ts ?? 'unknown-ts'
const DECISIONS = args?.decisions ?? {}
const CHECKPOINT_KEY = args?.checkpointKey ?? `${CHANGE_DIR}::${MILESTONE}`
const PRIOR_STATE = args?.priorState ?? null
const CHECKPOINT_VALIDATION = args?.checkpointValidation ?? null
function samePriorAgentEffort(opts) {
  if (!PRIOR_STATE) return false
  try {
    const priorModels = normalizeEffortOverrides(PRIOR_STATE.resumeArgs?.modelEfforts, 'prior.modelEfforts', MODEL_EFFORT_KEYS)
    const priorPhases = normalizeEffortOverrides(PRIOR_STATE.resumeArgs?.phaseEfforts, 'prior.phaseEfforts', PHASE_EFFORT_KEYS)
    return resolveAgentEffortFrom(priorModels, priorPhases, opts).effort === resolveAgentEffort(opts).effort
  } catch {
    return false
  }
}
const CHECKPOINT_SCHEMA_VERSION = 2
const CHECKPOINT_CACHE_VERSION = 2
const CHECKPOINT_TEMPLATE_KIND = 'openspec-incremental-v5'
const CHECKPOINT_META = {
  kind: CHECKPOINT_TEMPLATE_KIND,
  schemaVersion: CHECKPOINT_SCHEMA_VERSION,
  cacheVersion: CHECKPOINT_CACHE_VERSION,
  key: CHECKPOINT_KEY,
  task: TASK,
  changeDir: CHANGE_DIR,
  milestone: MILESTONE,
  projectRoot: REPO,
  specsGlob: SPECS_GLOB,
}
const STATE_KEY_MATCH = !!(
  PRIOR_STATE && PRIOR_STATE.kind === 'ultracode-semantic-state' &&
  PRIOR_STATE.checkpointKey === CHECKPOINT_KEY
)
const STATE_COMPATIBLE = !!(STATE_KEY_MATCH &&
  PRIOR_STATE.schemaVersion === CHECKPOINT_SCHEMA_VERSION &&
  PRIOR_STATE.cacheVersion === CHECKPOINT_CACHE_VERSION &&
  PRIOR_STATE.templateKind === CHECKPOINT_TEMPLATE_KIND)
const PRIOR_DIRTY = !!(PRIOR_STATE?.dirtyWorktree === true || CHECKPOINT_VALIDATION?.dirtyWorktree === true)
const TRUSTED_ARTIFACT_REUSE = !!(STATE_COMPATIBLE && !PRIOR_STATE?.legacyUnverified && !PRIOR_DIRTY &&
  PRIOR_STATE?.fingerprint?.complete === true && CHECKPOINT_VALIDATION?.valid === true)
const LEGACY_ARTIFACT_CANDIDATE = !!(STATE_KEY_MATCH && !STATE_COMPATIBLE && CHECKPOINT_VALIDATION?.legacyUnverified === true)
const DIRTY_ARTIFACT_CANDIDATE = !!(STATE_COMPATIBLE && !PRIOR_STATE?.legacyUnverified && PRIOR_DIRTY && CHECKPOINT_VALIDATION?.valid === true)
const KINDNONE_ARTIFACT_CANDIDATE = !!(STATE_COMPATIBLE && !PRIOR_STATE?.legacyUnverified && !PRIOR_DIRTY &&
  PRIOR_STATE?.fingerprint?.source?.kind === 'none' && CHECKPOINT_VALIDATION?.dependencyComplete === true &&
  CHECKPOINT_VALIDATION?.codeValid === true && CHECKPOINT_VALIDATION?.sourceValid === false)
const NEEDS_CHECKPOINT_VALIDATE = LEGACY_ARTIFACT_CANDIDATE || DIRTY_ARTIFACT_CANDIDATE || KINDNONE_ARTIFACT_CANDIDATE
const ARTIFACT_REUSE = TRUSTED_ARTIFACT_REUSE || NEEDS_CHECKPOINT_VALIDATE

const MODEL_RECON = args?.reconModel ?? 'haiku'
const MODEL_DEFAULT = args?.defaultModel ?? 'sonnet' // 常规工程角色
const MODEL_STRONG = args?.strongModel ?? 'opus'
const MODEL_REVIEW = args?.reviewModel ?? 'fable'
const MODEL_VERIFY = args?.verifyModel ?? 'haiku'
const MODEL_PREFLIGHT = args?.preflightModel ?? MODEL_VERIFY
const MODEL_COMMIT = args?.commitModel ?? MODEL_VERIFY
const MODEL_SPEC_SYNC = args?.specSyncModel ?? MODEL_DEFAULT
const ALWAYS_REVIEW = args?.alwaysReview ?? true
const REQUIRE_COMMIT = args?.requireCommit ?? true
const MAX_PATCH_ROUNDS = args?.maxPatchRounds ?? 2
const ROUTE_LOW_MAX = args?.routeLowMax ?? 24
const ROUTE_MEDIUM_MAX = args?.routeMediumMax ?? 49
const ROUTE_HIGH_MAX = args?.routeHighMax ?? 74

const S_STR_ARR = { type: 'array', items: { type: 'string' } }
const S_NUM0 = { type: 'number', minimum: 0 }
const K_FILE_LINE = '每条代码事实必须引用你亲自 Read 到的 file:line；OpenSpec 约束引用文档路径+标题/任务号。'
const K_FAIL_LOUD = '如实报告；失败就附原始输出/退出码，禁止把失败包装成成功。'
const K_GIT_SAFE = '禁止 git add . / -A；逐文件 add；不 push。'

const IMPACT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['affectedSymbols','affectedModules','processes','risk'],
  properties: {
    affectedSymbols: S_NUM0, affectedModules: S_NUM0, processes: S_NUM0,
    risk: { type: 'string', enum: ['LOW','MEDIUM','HIGH','CRITICAL'] },
  },
}
const SLICE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['id','title','sourceTaskIds','files','rationale'],
  properties: { id:{type:'string'}, title:{type:'string'}, sourceTaskIds:S_STR_ARR, files:S_STR_ARR, rationale:{type:'string'} },
}
const EDIT_SCHEMA = {
  type:'object', additionalProperties:false,
  required:['path','kind','summary','semantic','decisionId'],
  properties:{
    path:{type:'string'}, kind:{type:'string',enum:['proposal','spec','design','tasks','plan']},
    summary:{type:'string'}, semantic:{type:'boolean'},
    decisionId:{type:'string',description:'semantic=false 时空字符串；semantic=true 时必须引用已拍板 decision id'},
  },
}
const OPTION_SCHEMA = {
  type:'object', additionalProperties:false,
  required:['label','consequence','requiresArchitect','activateSlices','disableSlices','whitelistAdd','mustNotTouchAdd','testCommandsAdd'],
  properties:{
    label:{type:'string'}, consequence:{type:'string'}, requiresArchitect:{type:'boolean'},
    activateSlices:S_STR_ARR, disableSlices:S_STR_ARR, whitelistAdd:S_STR_ARR, mustNotTouchAdd:S_STR_ARR, testCommandsAdd:S_STR_ARR,
  },
}
const DECISION_SCHEMA = {
  type:'object', additionalProperties:false,
  required:['id','question','recommendation','evidence','options'],
  properties:{ id:{type:'string'}, question:{type:'string'}, recommendation:{type:'string'}, evidence:{type:'string'}, options:{type:'array',items:OPTION_SCHEMA} },
}
const RECON_SCHEMA = {
  type:'object', additionalProperties:false,
  required:['entrySymbols','evidence','impact','executionFlows','modules','contracts','riskFlags','uncertainty','unknowns','openspec'],
  properties:{
    entrySymbols:S_STR_ARR,
    evidence:{type:'array',items:{type:'object',additionalProperties:false,required:['claim','fileLine','confidence'],properties:{claim:{type:'string'},fileLine:{type:'string'},confidence:{type:'string',enum:['verified','likely','speculative']}}}},
    impact:{type:'object',additionalProperties:false,required:['depth1','depth2','depth3','affectedSymbols'],properties:{depth1:S_NUM0,depth2:S_NUM0,depth3:S_NUM0,affectedSymbols:S_NUM0}},
    executionFlows:S_NUM0,
    modules:{type:'object',additionalProperties:false,required:['count','crossModule','crossRepo'],properties:{count:S_NUM0,crossModule:{type:'boolean'},crossRepo:{type:'boolean'}}},
    contracts:{type:'object',additionalProperties:false,required:['publicApi','schemaChange','consumerCount','shapeMismatchCount'],properties:{publicApi:{type:'boolean'},schemaChange:{type:'boolean'},consumerCount:S_NUM0,shapeMismatchCount:S_NUM0}},
    riskFlags:{type:'object',additionalProperties:false,required:['concurrency','stateMachine','security','persistence','migration','reflectionOrGeneratedCode'],properties:{concurrency:{type:'boolean'},stateMachine:{type:'boolean'},security:{type:'boolean'},persistence:{type:'boolean'},migration:{type:'boolean'},reflectionOrGeneratedCode:{type:'boolean'}}},
    uncertainty:{type:'object',additionalProperties:false,required:['indexStale','lowerBound','partial','truncated','ambiguous','gitnexusUnavailable'],properties:{indexStale:{type:'boolean'},lowerBound:{type:'boolean'},partial:{type:'boolean'},truncated:{type:'boolean'},ambiguous:{type:'boolean'},gitnexusUnavailable:{type:'boolean'}}},
    unknowns:S_STR_ARR,
    openspec:{type:'object',additionalProperties:false,required:['coverage','relevantTaskIds','drift','architectureGap','semanticSpecChange','missingArtifacts'],properties:{coverage:{type:'string',enum:['complete','partial','weak']},relevantTaskIds:S_STR_ARR,drift:{type:'boolean'},architectureGap:{type:'boolean'},semanticSpecChange:{type:'boolean'},missingArtifacts:S_STR_ARR}},
  },
}
const PLAN_SCHEMA = {
  type:'object', additionalProperties:false,
  required:['verdict','sourceMode','executionBasis','slices','whitelist','mustNotTouch','testCommands','evidenceDependencies','predictedImpact','decisionPoints','openspecEdits'],
  properties:{
    verdict:{type:'string',enum:['implementable','blocked']}, sourceMode:{type:'string',enum:['openspec-reuse','openspec-repair']}, executionBasis:{type:'string'},
    slices:{type:'array',items:SLICE_SCHEMA}, whitelist:S_STR_ARR, mustNotTouch:S_STR_ARR, testCommands:S_STR_ARR,
    evidenceDependencies:{...S_STR_ARR,description:'验证过但不直接修改的 caller/public contract/接口/关键测试文件，用于缓存失效判定'},
    predictedImpact:IMPACT_SCHEMA, decisionPoints:{type:'array',items:DECISION_SCHEMA}, openspecEdits:{type:'array',items:EDIT_SCHEMA},
  },
}
const REVIEW_SCHEMA = {
  type:'object',additionalProperties:false,
  required:['verdict','scope','requiresArchitect','affectedSliceIds','requiredChanges','blockers'],
  properties:{verdict:{type:'string',enum:['approve','revise','block']},scope:{type:'string',enum:['none','mechanical','slice','architecture']},requiresArchitect:{type:'boolean'},affectedSliceIds:S_STR_ARR,requiredChanges:S_STR_ARR,blockers:S_STR_ARR},
}
const PATCH_SCHEMA = {
  type:'object',additionalProperties:false,
  required:['verdict','replaceSlices','addSlices','removeSliceIds','whitelistAdd','whitelistRemove','mustNotTouchAdd','mustNotTouchRemove','testCommandsAdd','testCommandsRemove','evidenceDependenciesAdd','evidenceDependenciesRemove','openspecEditsAdd','predictedImpact'],
  properties:{
    verdict:{type:'string',enum:['patched','blocked']}, replaceSlices:{type:'array',items:SLICE_SCHEMA}, addSlices:{type:'array',items:SLICE_SCHEMA}, removeSliceIds:S_STR_ARR,
    whitelistAdd:S_STR_ARR,whitelistRemove:S_STR_ARR,mustNotTouchAdd:S_STR_ARR,mustNotTouchRemove:S_STR_ARR,testCommandsAdd:S_STR_ARR,testCommandsRemove:S_STR_ARR,
    evidenceDependenciesAdd:S_STR_ARR,evidenceDependenciesRemove:S_STR_ARR,
    openspecEditsAdd:{type:'array',items:EDIT_SCHEMA},predictedImpact:IMPACT_SCHEMA,
  },
}
const SIMPLE_DONE_SCHEMA={type:'object',additionalProperties:false,required:['done','notes'],properties:{done:{type:'boolean'},notes:S_STR_ARR}}
const PREFLIGHT_SCHEMA={type:'object',additionalProperties:false,required:['ready','testTotal','testPassed','testFailed','typecheckExit','blockers'],properties:{ready:{type:'boolean'},testTotal:S_NUM0,testPassed:S_NUM0,testFailed:S_NUM0,typecheckExit:{type:'number'},blockers:S_STR_ARR}}
const IMPLEMENT_SCHEMA={type:'object',additionalProperties:false,required:['done','filesChanged','notImplemented','honesty'],properties:{done:{type:'boolean'},filesChanged:S_STR_ARR,notImplemented:S_STR_ARR,honesty:{type:'string'}}}
const VERIFY_SCHEMA={type:'object',additionalProperties:false,required:['status','testTotal','testPassed','testFailed','typecheckExit','actualImpact','completedTaskIds','rawTail'],properties:{status:{type:'string',enum:['green','red']},testTotal:S_NUM0,testPassed:S_NUM0,testFailed:S_NUM0,typecheckExit:{type:'number'},actualImpact:{type:'object',additionalProperties:false,required:['affectedSymbols','affectedModules','processes'],properties:{affectedSymbols:S_NUM0,affectedModules:S_NUM0,processes:S_NUM0}},completedTaskIds:S_STR_ARR,rawTail:{type:'string'}}}
const AUDIT_SCHEMA={type:'object',additionalProperties:false,required:['verdict','findings'],properties:{verdict:{type:'string',enum:['accept','needs-rework','escalate-to-human']},findings:S_STR_ARR}}
const COMMIT_SCHEMA={type:'object',additionalProperties:false,required:['committed','commits','tickedTaskIds','note'],properties:{committed:{type:'boolean'},commits:S_STR_ARR,tickedTaskIds:S_STR_ARR,note:{type:'string'}}}
const CHECKPOINT_VALIDATE_SCHEMA={type:'object',additionalProperties:false,required:['planStillValid','reviewStillValid','changedSliceIds','reasons','requiresArchitect'],properties:{planStillValid:{type:'boolean'},reviewStillValid:{type:'boolean'},changedSliceIds:S_STR_ARR,reasons:S_STR_ARR,requiresArchitect:{type:'boolean',description:'失效修复涉及架构/public contract/state ownership 时 true；机械/局部修复 false'}}}

const ROUTE_ORDER=['LOW','MEDIUM','HIGH','CRITICAL']
const ROUTE_RANK={LOW:0,MEDIUM:1,HIGH:2,CRITICAL:3}
const maxRoute=(a,b)=>ROUTE_ORDER[Math.max(ROUTE_ORDER.indexOf(a),ROUTE_ORDER.indexOf(b))]
const uniq=xs=>{const out=[];for(const x of xs??[])if(x&&!out.includes(x))out.push(x);return out}
const minus=(xs,ys)=>(xs??[]).filter(x=>!(ys??[]).includes(x))
const canonicalize=value=>{if(Array.isArray(value))return value.map(canonicalize);if(!value||typeof value!=='object')return value;const out={};for(const key of Object.keys(value).sort())if(value[key]!==undefined)out[key]=canonicalize(value[key]);return out}
const stableStringify=value=>JSON.stringify(canonicalize(value))
const decisionKey=o=>stableStringify(o??{})

function computeRouting(r){
  if(!r)return{score:null,route:'HIGH',failsafe:true,reasons:['Recon null → HIGH']}
  const blast=Math.min(30,r.impact.depth1*4+r.impact.depth2*2+r.impact.depth3)
  const flow=Math.min(15,r.executionFlows*3)
  const reach=r.modules.crossRepo?15:r.modules.crossModule?10:r.modules.count>=2?5:1
  let contract=(r.contracts.publicApi?5:0)+(r.contracts.schemaChange?5:0)+Math.min(3,r.contracts.consumerCount)+(r.contracts.shapeMismatchCount>0?2:0);contract=Math.min(15,contract)
  let behavior=0;for(const k of ['concurrency','stateMachine','security','persistence','migration','reflectionOrGeneratedCode'])if(r.riskFlags[k])behavior+=2;behavior=Math.min(10,behavior)
  let uncertainty=0;for(const k of ['indexStale','lowerBound','partial','truncated','ambiguous','gitnexusUnavailable'])if(r.uncertainty[k])uncertainty+=2;uncertainty+=Math.min(3,r.unknowns.length)+(r.openspec.coverage==='complete'?0:2)+(r.openspec.drift?2:0);uncertainty=Math.min(15,uncertainty)
  const score=blast+flow+reach+contract+behavior+uncertainty
  let route=score<=ROUTE_LOW_MAX?'LOW':score<=ROUTE_MEDIUM_MAX?'MEDIUM':score<=ROUTE_HIGH_MAX?'HIGH':'CRITICAL'
  if(r.modules.crossRepo||r.riskFlags.security||r.riskFlags.migration)route=maxRoute(route,'HIGH')
  if(r.contracts.publicApi||r.riskFlags.concurrency||r.riskFlags.stateMachine||r.riskFlags.persistence)route=maxRoute(route,'MEDIUM')
  if((r.uncertainty.partial||r.uncertainty.truncated)&&r.contracts.publicApi)route='CRITICAL'
  return{score,route,failsafe:false,reasons:[`blast=${blast}`,`flow=${flow}`,`reach=${reach}`,`contract=${contract}`,`behavior=${behavior}`,`uncertainty=${uncertainty}`]}
}
function applyDecisions(base,decisions){
  let slices=[...base.slices],whitelist=[...base.whitelist],mustNotTouch=[...base.mustNotTouch],testCommands=[...base.testCommands]
  const unresolved=[],invalid=[],unknown=[],architect=[],known=new Set()
  for(const d of base.decisionPoints){
    if(known.has(d.id)){invalid.push({id:d.id,reason:'duplicate-decision-id'});continue}
    known.add(d.id)
    const labels=d.options.map(o=>o.label)
    if(new Set(labels).size!==labels.length){invalid.push({id:d.id,reason:'duplicate-option-label'});continue}
    if(!(d.id in decisions)){unresolved.push(d);continue}
    const o=d.options.find(x=>x.label===decisions[d.id]);if(!o){invalid.push({id:d.id,selected:decisions[d.id]});continue}
    slices=slices.filter(s=>!o.disableSlices.includes(s.id))
    const missing=o.activateSlices.filter(id=>!slices.some(s=>s.id===id));if(missing.length){invalid.push({id:d.id,missing});continue}
    whitelist=uniq(whitelist.concat(o.whitelistAdd));mustNotTouch=uniq(mustNotTouch.concat(o.mustNotTouchAdd));testCommands=uniq(testCommands.concat(o.testCommandsAdd))
    if(o.requiresArchitect)architect.push({decision:d,option:o})
  }
  for(const id of Object.keys(decisions??{}))if(!known.has(id))unknown.push(id)
  return{unresolved,invalid,unknown,architect,plan:{...base,slices,whitelist,mustNotTouch,testCommands}}
}
function applyPatch(plan,p){
  let slices=plan.slices.filter(s=>!p.removeSliceIds.includes(s.id));const repl={};for(const s of p.replaceSlices)repl[s.id]=s;slices=slices.map(s=>repl[s.id]??s);for(const s of p.addSlices)if(!slices.some(x=>x.id===s.id))slices.push(s)
  return{...plan,slices,whitelist:uniq(minus(plan.whitelist,p.whitelistRemove).concat(p.whitelistAdd)),mustNotTouch:uniq(minus(plan.mustNotTouch,p.mustNotTouchRemove).concat(p.mustNotTouchAdd)),testCommands:uniq(minus(plan.testCommands,p.testCommandsRemove).concat(p.testCommandsAdd)),evidenceDependencies:uniq(minus(plan.evidenceDependencies,p.evidenceDependenciesRemove).concat(p.evidenceDependenciesAdd)),openspecEdits:[...plan.openspecEdits,...p.openspecEditsAdd],predictedImpact:p.predictedImpact}
}
function digest(p){return[`basis=${p.executionBasis}`,`slices:\n${p.slices.map(s=>`- ${s.id} tasks=${s.sourceTaskIds.join(',')} files=${s.files.join(', ')} — ${s.rationale}`).join('\n')}`,`whitelist=${p.whitelist.join(', ')}`,`mustNotTouch=${p.mustNotTouch.join(', ')||'无'}`,`evidenceDependencies=${p.evidenceDependencies.join(', ')||'无'}`,`tests=${p.testCommands.join(' && ')}`,`risk=${p.predictedImpact.risk}`].join('\n\n')}

phase('Recon')
const reconArtifactHit=!!(TRUSTED_ARTIFACT_REUSE&&PRIOR_STATE.recon&&samePriorAgentEffort({phase:'Recon',model:MODEL_RECON}))
const recon=reconArtifactHit ? PRIOR_STATE.recon : await llmAgent([
  '你是 OpenSpec-first Recon（只读）。OpenSpec 是上游 Plan IR，但必须用源码/GitNexus 验证是否仍成立。',
  `任务：${TASK}`,`repo=${REPO}`,`proposal=${PROPOSAL_DOC}`,`design=${DESIGN_DOC}`,`tasks=${TASKS_DOC}`,PLAN_DOC?`plan=${PLAN_DOC}`:'',`specs=${SPECS_GLOB}`,`目标=${MILESTONE}`,
  '先定位相关 task/heading，再做定向 Read；不要无条件吞完整长文档。用 GitNexus query/context/impact/api_impact/shape_check 验证 caller、flow、contract。',
  '输出 coverage/drift/architectureGap/semanticSpecChange。OpenSpec 与代码冲突时，以源码/测试为运行事实，但必须标 drift。只输出事实，不写实现计划。',K_FILE_LINE,
].filter(Boolean).join('\n'),{label:'recon:openspec',phase:'Recon',model:MODEL_RECON,schema:RECON_SCHEMA})
if(TRUSTED_ARTIFACT_REUSE&&PRIOR_STATE.recon)log('Recon ARTIFACT HIT：fingerprint 未变化，复用历史 evidence map')

const routing=computeRouting(recon)
const needsStrongPlan=!!recon&&(recon.openspec.architectureGap||recon.openspec.semanticSpecChange||(recon.openspec.coverage!=='complete'&&ROUTE_RANK[routing.route]>=ROUTE_RANK.HIGH))
const plannerModel=needsStrongPlan?MODEL_STRONG:MODEL_DEFAULT
const implementationModel=routing.route==='CRITICAL'?MODEL_STRONG:MODEL_DEFAULT
log(`OpenSpec coverage=${recon?.openspec?.coverage??'?'} drift=${recon?.openspec?.drift??'?'} route=${routing.route} planner=${plannerModel}`)

// v0.3 历史 raw 没有生成时刻 fingerprint；dirtyWorktree（上轮实现未完成或 Verify 未绿）的
// fingerprint 虽匹配，但 Plan/Review 从未对着这份 partial workspace 审过。两者都不能把
// 「今天的 hash」当成历史真实性：先用廉价模型验证旧 Plan/Review，再决定是否跳过昂贵模型。
let priorValidation=null
if(NEEDS_CHECKPOINT_VALIDATE&&PRIOR_STATE?.basePlan){
  phase('Recon')
  priorValidation=await llmAgent([
    '你是 CheckpointValidate（廉价只读验证器），不是 Planner。判断历史 Plan/Review 是否仍适用于当前 OpenSpec 与代码。',
    `当前任务=${TASK}; change=${CHANGE_DIR}; milestone=${MILESTONE}; route=${routing.route}`,
    `历史 BasePlan:
${digest(PRIOR_STATE.basePlan)}`,
    PRIOR_STATE?.review?`历史 Review verdict=${PRIOR_STATE.review.verdict}`:'历史 Review 缺失',
    PRIOR_DIRTY?'上轮实现未完成或 Verify 未绿（dirtyWorktree）：除 OpenSpec/代码漂移外，还必须核实已写入 workspace 的部分实现不推翻 Plan/Review 结论；无法核实即 false。':'',
    PRIOR_STATE?.fingerprint?.source?.kind==='none'?'该 state 来自非 OpenSpec 链(sourceKind=none):无 OpenSpec markdown 指纹属预期,重点核实代码侧漂移(slices/whitelist 涉及文件)与任务前提是否仍成立。':'',
    '必须亲自定向 Read 当前 proposal/design/tasks/specs，并 Read 历史 slices/whitelist 涉及的代码；可用刚完成的 Recon/GitNexus 结果导航，但不得只信历史摘要。',
    'planStillValid=true 仅当根因/切片/whitelist/tests/contract 仍成立；reviewStillValid=true 还要求历史 verdict=approve 且没有出现会推翻该审阅的新依赖/风险。',
    'requiresArchitect=true 仅当失效修复涉及架构/public API/schema/cross-repo contract/concurrency/state ownership/persistence/migration/security；机械/局部修复为 false。',
    '任一关键文件无法核实、OpenSpec 语义变化、caller/contract 漂移时对应值必须 false；changedSliceIds 列受影响 slice。',K_FILE_LINE,
  ].filter(Boolean).join('\n'),{label:'checkpoint:validate',phase:'Recon',model:MODEL_RECON,schema:CHECKPOINT_VALIDATE_SCHEMA})
  if(!priorValidation)log('CheckpointValidate 未返回：fail-closed，不复用历史 Plan/Review')
  else log(`CheckpointValidate${PRIOR_DIRTY?'（dirty）':''}：plan=${priorValidation.planStillValid} review=${priorValidation.reviewStillValid}`)
}

// ★ DECISIONS 绝不进入 BasePlan prompt：拍板后 same-session resume 可让 BasePlan HIT；跨 run 可走 artifact hit。
const priorRoute=PRIOR_STATE?.routing?.effectiveRoute??PRIOR_STATE?.routing?.route??null
const priorBasePlan=PRIOR_STATE?.basePlan??null
const priorEffectivePlan=PRIOR_STATE?.effectivePlan??null
const priorApprovedEffectivePlan=PRIOR_STATE?.review?.verdict==='approve'?priorEffectivePlan:null
const sameDecisions=ARTIFACT_REUSE&&decisionKey(PRIOR_STATE?.decisionApply?.decisions)===decisionKey(DECISIONS)
const basePlanArtifactHit=!!(ARTIFACT_REUSE&&priorBasePlan&&(TRUSTED_ARTIFACT_REUSE||priorValidation?.planStillValid===true)&&samePriorAgentEffort({phase:'Plan',model:plannerModel,effort:'high'})&&(!priorRoute||ROUTE_RANK[priorRoute]>=ROUTE_RANK[routing.route]))
// dirty 选择性恢复必须从上次已批准 EffectivePlan 起步，避免撤销未变化 slice 的历史 patch。
const recoverySliceIds=DIRTY_ARTIFACT_CANDIDATE&&sameDecisions&&priorApprovedEffectivePlan&&priorValidation&&priorValidation.planStillValid!==true
  ?(priorValidation.changedSliceIds??[]).filter(id=>priorApprovedEffectivePlan.slices?.some(s=>s.id===id)):[]
const RECOVERY_PATCH_VIABLE=!!(recoverySliceIds.length&&recoverySliceIds.length<(priorApprovedEffectivePlan?.slices?.length??0))
phase('Plan')
const basePlan=(basePlanArtifactHit||RECOVERY_PATCH_VIABLE) ? priorBasePlan : await llmAgent([
  `你是 ${MILESTONE} 的执行规划者。OpenSpec 是上游 Plan IR；只做 execution overlay，不从零复述/重写。`,
  `任务=${TASK}`,`repo=${REPO}`,`proposal=${PROPOSAL_DOC}`,`design=${DESIGN_DOC}`,`tasks=${TASKS_DOC}`,PLAN_DOC?`plan=${PLAN_DOC}`:'',`specs=${SPECS_GLOB}`,
  `Recon：route=${routing.route}; coverage=${recon?.openspec?.coverage??'?'}; drift=${recon?.openspec?.drift??'?'}; archGap=${recon?.openspec?.architectureGap??'?'}`,
  `相关 tasks=${recon?.openspec?.relevantTaskIds?.join(', ')||'自行定向读取'}`,
  '每个 slice 必须有稳定 id + sourceTaskIds + files + tests/理由。需要用户拍板时写 decisionPoints；每个 option 预编码 activate/disable slices、whitelist/tests 增量。',
  'whitelist/slices.files/evidenceDependencies 只能写目标 repo 内的精确文件路径，不得写 glob 或自然语言。evidenceDependencies 填你 Read/验证过但不直接修改的 caller/public contract/接口/关键测试；无则空数组。',
  'requiresArchitect 仅在选项改变架构/public API/schema/cross-repo contract/concurrency/state ownership/persistence/migration/security 时 true。',
  'OpenSpec 机械补洞列 openspecEdits semantic=false, decisionId=""。任何 semantic=true edit 必须同时给 decisionPoint，并把 decisionId 指向它；不得自行批准语义变化。',
  K_FILE_LINE,
].filter(Boolean).join('\n'),{label:'plan:base-overlay',phase:'Plan',model:plannerModel,effort:'high',schema:PLAN_SCHEMA})
if(basePlanArtifactHit)log('BasePlan ARTIFACT HIT：跳过昂贵 Planner')
if(RECOVERY_PATCH_VIABLE)log(`Recovery：以上次 approved EffectivePlan 为起点，局部修复 ${recoverySliceIds.length}/${priorApprovedEffectivePlan.slices.length} 个失效 slice，跳过全量 Planner`)
if(!basePlan)return{status:'failed',at:'BasePlan',checkpoint:CHECKPOINT_META,recon,basePlan:null,effectivePlan:null,plan:null,decisionApply:{decisions:DECISIONS,invalid:[],unknown:[]},reviewInputCanonical:null,artifactCache:{recon:reconArtifactHit,basePlan:false,effectivePlan:false,review:false},routing}
if(basePlan.verdict==='blocked')return{status:'blocked',at:'BasePlan',checkpoint:CHECKPOINT_META,recon,basePlan,effectivePlan:null,plan:basePlan,decisionApply:{decisions:DECISIONS,invalid:[],unknown:[]},reviewInputCanonical:null,artifactCache:{recon:reconArtifactHit,basePlan:basePlanArtifactHit,effectivePlan:false,review:false},routing}

const applied=applyDecisions(basePlan,DECISIONS)
if(applied.invalid.length||applied.unknown.length)return{status:'blocked',at:'DecisionApply',invalid:applied.invalid,unknown:applied.unknown,checkpoint:CHECKPOINT_META,recon,basePlan,effectivePlan:null,plan:basePlan,decisionApply:{decisions:DECISIONS,invalid:applied.invalid,unknown:applied.unknown},reviewInputCanonical:null,artifactCache:{recon:reconArtifactHit,basePlan:basePlanArtifactHit,effectivePlan:false,review:false},routing}
if(applied.unresolved.length)return{status:'need-decision',at:'DecisionApply',milestone:MILESTONE,decisionPoints:applied.unresolved,checkpoint:CHECKPOINT_META,recon,basePlan,effectivePlan:null,plan:basePlan,decisionApply:{decisions:DECISIONS,invalid:[],unknown:[]},reviewInputCanonical:null,artifactCache:{recon:reconArtifactHit,basePlan:basePlanArtifactHit,effectivePlan:false,review:false},routing,howToResume:'同 session 优先原 scriptPath + resumeFromRunId（args=首轮全量叠加 decisions，全量替换非合并）；跨 run/session 由 state fingerprint 验证后传 priorState/checkpointValidation/checkpointKey，BasePlan 可 ARTIFACT HIT。'}
const priorApprovedRoute=PRIOR_STATE?.routing?.effectiveRoute??PRIOR_STATE?.routing?.route??null
const effectivePlanArtifactHit=!!(basePlanArtifactHit&&sameDecisions&&priorEffectivePlan&&PRIOR_STATE?.reviewReusable===true&&PRIOR_STATE?.review?.verdict==='approve'&&(TRUSTED_ARTIFACT_REUSE||priorValidation?.reviewStillValid===true)&&(!priorApprovedRoute||ROUTE_RANK[priorApprovedRoute]>=ROUTE_RANK[routing.route]))
let plan=RECOVERY_PATCH_VIABLE?priorApprovedEffectivePlan:effectivePlanArtifactHit?priorEffectivePlan:applied.plan
if(effectivePlanArtifactHit)log('EffectivePlan ARTIFACT HIT：decisions 未变，复用上轮已批准 PlanPatch/PlanDelta 结果')

// 普通拍板：JS 0 token。只有新选择需要架构推理且没有命中已批准 EffectivePlan 才 Opus PlanDelta。
if(!effectivePlanArtifactHit&&!RECOVERY_PATCH_VIABLE&&applied.architect.length){
  phase('Plan')
  const delta=await llmAgent([
    '你是 Opus PlanDelta。BasePlan 已存在；只处理本轮 requiresArchitect=true 的已拍板选择，禁止从零重写未受影响 slice。',
    `BasePlan:\n${digest(plan)}`,
    `已拍板：\n${applied.architect.map(x=>`- ${x.decision.id}=${x.option.label}: ${x.option.consequence}`).join('\n')}`,
    `重读受影响代码 + ${DESIGN_DOC} + ${TASKS_DOC} + ${SPECS_GLOB}。语义 OpenSpec edit 的 decisionId 必须引用上述已拍板 id。`,K_FILE_LINE,
  ].join('\n'),{label:'plan:decision-delta',phase:'Plan',model:MODEL_STRONG,effort:'high',schema:PLAN_SCHEMA})
  if(!delta)return{status:'failed',at:'PlanDelta',checkpoint:CHECKPOINT_META,recon,basePlan,effectivePlan:plan,plan,decisionApply:{decisions:DECISIONS,invalid:[],unknown:[],architectChoices:applied.architect.map(x=>({id:x.decision.id,label:x.option.label}))},reviewInputCanonical:null,artifactCache:{recon:reconArtifactHit,basePlan:basePlanArtifactHit,effectivePlan:false,review:false},routing}
  if(delta.verdict==='blocked')return{status:'blocked',at:'PlanDelta',checkpoint:CHECKPOINT_META,recon,basePlan,effectivePlan:delta,plan:delta,decisionApply:{decisions:DECISIONS,invalid:[],unknown:[],architectChoices:applied.architect.map(x=>({id:x.decision.id,label:x.option.label}))},reviewInputCanonical:null,artifactCache:{recon:reconArtifactHit,basePlan:basePlanArtifactHit,effectivePlan:false,review:false},routing}
  plan=delta
}

const architectChoices=applied.architect.map(x=>({id:x.decision.id,label:x.option.label,consequence:x.option.consequence}))
let effectiveRoute=ROUTE_RANK[plan.predictedImpact.risk]>ROUTE_RANK[routing.route]?plan.predictedImpact.risk:routing.route
let patchRounds=0
let changed=plan.slices.map(s=>s.id)
let recoveryPatched=false
let review=null
let appliedOpenSpecEdits=[]
const makeReviewInput=(mode,currentPlan,currentChanged)=>stableStringify({
  contract:CHECKPOINT_TEMPLATE_KIND,
  task:TASK,
  milestone:MILESTONE,
  openSpec:{proposal:PROPOSAL_DOC,design:DESIGN_DOC,tasks:TASKS_DOC,plan:PLAN_DOC,specs:SPECS_GLOB},
  effectivePlan:currentPlan,
  effectiveRoute,
  reviewModel:MODEL_REVIEW,
  reviewEffort:resolveAgentEffort({phase:'Review',model:MODEL_REVIEW,effort:'high'}).effort??null,
  mode,
  changedSliceIds:currentChanged,
  decisions:DECISIONS,
  architectChoices,
})
let reviewInputMode='full'
let reviewInputChanged=[...changed]
let reviewInputCanonical=makeReviewInput(reviewInputMode,plan,reviewInputChanged)
let reviewArtifactHit=!!(effectivePlanArtifactHit&&PRIOR_STATE?.reviewReusable===true&&PRIOR_STATE?.review?.verdict==='approve'&&PRIOR_STATE?.reviewInputCanonical===reviewInputCanonical&&(!priorApprovedRoute||ROUTE_RANK[priorApprovedRoute]>=ROUTE_RANK[effectiveRoute]))
review=reviewArtifactHit?PRIOR_STATE.review:null
const artifactCache=()=>({recon:reconArtifactHit,basePlan:basePlanArtifactHit,effectivePlan:effectivePlanArtifactHit,review:reviewArtifactHit,recoveryPatched})
const checkpointEnvelope=extra=>({
  ...extra,checkpoint:CHECKPOINT_META,recon,basePlan,effectivePlan:plan,plan,review,
  decisionApply:{decisions:DECISIONS,invalid:[],unknown:[],architectChoices},reviewInputCanonical,artifactCache:artifactCache(),appliedOpenSpecEdits,
  routing:extra.routing??routing,
})

// semantic change 二次硬门：没有已拍板 decision id 就绝不 SpecSync。
const unapprovedSemantic=plan.openspecEdits.filter(e=>e.semantic&&(!e.decisionId||!(e.decisionId in DECISIONS)))
if(unapprovedSemantic.length)return checkpointEnvelope({status:'blocked',at:'SemanticSpecGate',reason:'存在未绑定已拍板 decision 的 semantic OpenSpec edit',edits:unapprovedSemantic})
if(reviewArtifactHit)log('Review ARTIFACT HIT：EffectivePlan 与完整 Review 输入一致，跳过昂贵 Reviewer')

// dirty 选择性恢复：先按 CheckpointValidate 的失效定位跑一次定向 PlanPatch；
// 之后 patchRounds=1，下方 Review 循环第一轮自动成为 DeltaReview（只审 changed slices）。
if(RECOVERY_PATCH_VIABLE&&!reviewArtifactHit){
  const recoveryModel=priorValidation.requiresArchitect?MODEL_STRONG:MODEL_DEFAULT
  const targets=plan.slices.filter(s=>recoverySliceIds.includes(s.id))
  phase('Plan')
  const rpatch=await llmAgent([
    `你是 PlanPatch；历史 Plan 的部分 slice 在当前 workspace 上已失效（dirtyWorktree 恢复），只修失效 slice，不从零重写。模型档=${recoveryModel}.`,
    `失效 slices:\n${targets.map(s=>`${s.id} ${s.title}: ${s.rationale}`).join('\n')}`,
    `失效原因:\n${(priorValidation.reasons??[]).map(x=>`- ${x}`).join('\n')||'无'}`,
    '亲自重读失效 slice 涉及的当前代码（实现可能已部分写入），输出 replace/add/remove slice 与 whitelist/tests/evidenceDependencies/OpenSpec edit 的 delta。未失效 slice 不得进入 replaceSlices；所有路径必须是目标 repo 内精确文件路径。semantic edit 必须绑定已拍板 decisionId。',K_FILE_LINE,
  ].join('\n'),{label:'plan:recovery-patch',phase:'Plan',model:recoveryModel,effort:'high',schema:PATCH_SCHEMA})
  if(!rpatch)return checkpointEnvelope({status:'failed',at:'RecoveryPatch'})
  if(rpatch.verdict==='blocked')return checkpointEnvelope({status:'blocked',at:'RecoveryPatch',reason:'Recovery PlanPatch 无法局部修复；可不带 priorState 全量重跑',patch:rpatch})
  plan=applyPatch(plan,rpatch)
  patchRounds++
  changed=uniq(rpatch.replaceSlices.map(s=>s.id).concat(rpatch.addSlices.map(s=>s.id)).concat(rpatch.removeSliceIds))
  effectiveRoute=ROUTE_RANK[plan.predictedImpact.risk]>ROUTE_RANK[effectiveRoute]?plan.predictedImpact.risk:effectiveRoute
  recoveryPatched=true
  const bad=plan.openspecEdits.filter(e=>e.semantic&&(!e.decisionId||!(e.decisionId in DECISIONS)))
  if(bad.length)return checkpointEnvelope({status:'blocked',at:'SemanticSpecGate',reason:'Recovery PlanPatch 引入未获用户拍板的 semantic edit',edits:bad})
  log(`Recovery PlanPatch：局部修复 ${changed.join(', ')}（${recoveryModel}），后续只跑 DeltaReview`)
}
if((ALWAYS_REVIEW||effectiveRoute!=='LOW'||recoveryPatched)&&!reviewArtifactHit){
  while(true){
    phase('Review')
    const reviewBody=patchRounds===0?digest(plan):[`只复审 changed slices=${changed.join(', ')}`, ...plan.slices.filter(s=>changed.includes(s.id)).map(s=>`${s.id} ${s.title}\n${s.rationale}`),`全局 invariants: whitelist=${plan.whitelist.join(', ')}; mustNotTouch=${plan.mustNotTouch.join(', ')||'无'}; tests=${plan.testCommands.join(' && ')}; evidenceDependencies=${plan.evidenceDependencies.join(', ')||'无'}`].join('\n\n')
    reviewInputMode=patchRounds===0?'full':'delta'
    reviewInputChanged=patchRounds===0?plan.slices.map(s=>s.id):[...changed]
    reviewInputCanonical=makeReviewInput(reviewInputMode,plan,reviewInputChanged)
    review=await llmAgent([
      patchRounds===0?'你是独立 Plan Reviewer。审 OpenSpec execution overlay，不重做 Planner。':'你是 Delta Reviewer。只审 changed slices + 全局 invariants；已批准且未变化 slice 不要重新讨论。',
      `OpenSpec=${PROPOSAL_DOC}|${DESIGN_DOC}|${TASKS_DOC}|${SPECS_GLOB}`,`route=${effectiveRoute}`,architectChoices.length?`架构决议：${architectChoices.map(x=>`${x.id}=${x.label}: ${x.consequence}`).join('；')}`:'',reviewBody,
      'revise 必须输出 scope/requiresArchitect/affectedSliceIds/requiredChanges。机械/单 slice 问题禁止冒充 architecture。',
    ].join('\n'),{label:`review:plan:${patchRounds}`,phase:'Review',model:MODEL_REVIEW,effort:'high',schema:REVIEW_SCHEMA})
    if(!review)return checkpointEnvelope({status:'failed',at:'Review'})
    if(review.verdict==='approve')break
    if(review.verdict==='block')return checkpointEnvelope({status:'blocked',at:'Review'})
    if(!review.requiredChanges.length&&!review.blockers.length)return checkpointEnvelope({status:'blocked',at:'Review',reason:'revise 无可执行反馈'})
    if(patchRounds>=MAX_PATCH_ROUNDS)return checkpointEnvelope({status:'blocked',at:'Review',reason:`PlanPatch 达上限 ${MAX_PATCH_ROUNDS}`})
    patchRounds++
    const patchModel=(review.requiresArchitect||review.scope==='architecture')?MODEL_STRONG:MODEL_DEFAULT
    const targets=plan.slices.filter(s=>!review.affectedSliceIds.length||review.affectedSliceIds.includes(s.id))
    phase('Plan')
    const patch=await llmAgent([
      `你是 PlanPatch；只修 Reviewer 指出的范围，不从零重写。模型档=${patchModel}.`,
      `targets:\n${targets.map(s=>`${s.id} ${s.title}: ${s.rationale}`).join('\n')}`,`requiredChanges:\n${review.requiredChanges.map(x=>`- ${x}`).join('\n')}`,`blockers:\n${review.blockers.map(x=>`- ${x}`).join('\n')||'无'}`,
      '输出 replace/add/remove slice 与 whitelist/tests/evidenceDependencies/OpenSpec edit 的 delta。未受影响 slice 不得进入 replaceSlices；所有路径必须是目标 repo 内精确文件路径。semantic edit 必须绑定已拍板 decisionId。',K_FILE_LINE,
    ].join('\n'),{label:`plan:patch:${patchRounds}`,phase:'Plan',model:patchModel,effort:'high',schema:PATCH_SCHEMA})
    if(!patch)return checkpointEnvelope({status:'failed',at:'PlanPatch'})
    if(patch.verdict==='blocked')return checkpointEnvelope({status:'blocked',at:'PlanPatch',patch})
    plan=applyPatch(plan,patch)
    changed=uniq(patch.replaceSlices.map(s=>s.id).concat(patch.addSlices.map(s=>s.id)).concat(patch.removeSliceIds))
    effectiveRoute=ROUTE_RANK[plan.predictedImpact.risk]>ROUTE_RANK[effectiveRoute]?plan.predictedImpact.risk:effectiveRoute
    const bad=plan.openspecEdits.filter(e=>e.semantic&&(!e.decisionId||!(e.decisionId in DECISIONS)))
    if(bad.length)return checkpointEnvelope({status:'blocked',at:'SemanticSpecGate',reason:'PlanPatch 引入未获用户拍板的 semantic edit',edits:bad})
  }
}

let specSync=null
if(plan.openspecEdits.length){
  phase('SpecSync')
  specSync=await llmAgent([
    '你是 OpenSpec SpecSync。只把【已批准】的 openspecEdits 精确落到原 artifact，不重新设计。',
    `changeDir=${CHANGE_DIR}`,`edits:\n${plan.openspecEdits.map(e=>`- [${e.kind}] ${e.path} semantic=${e.semantic} decision=${e.decisionId||'-'}: ${e.summary}`).join('\n')}`,
    '改前 Read、改后 Read；禁止把 [ ] 改 [x]；不得扩大到列表外语义。semantic=true 已由 JS Gate 验证 decisionId。',
  ].join('\n'),{label:'openspec:sync',phase:'SpecSync',model:MODEL_SPEC_SYNC,effort:'high',schema:SIMPLE_DONE_SCHEMA})
  if(!specSync?.done)return checkpointEnvelope({status:'failed',at:'SpecSync',specSync})
  appliedOpenSpecEdits=[...plan.openspecEdits]
  plan={...plan,openspecEdits:[]}
  reviewInputCanonical=makeReviewInput(reviewInputMode,plan,reviewInputChanged)
}

phase('Preflight')
const pre=await llmAgent(['你是 Preflight。建立修改前测试基线，不改业务代码。',`命令=${plan.testCommands.join(' && ')}`,K_FAIL_LOUD].join('\n'),{label:'preflight',phase:'Preflight',model:MODEL_PREFLIGHT,schema:PREFLIGHT_SCHEMA})
if(!pre)return checkpointEnvelope({status:'failed',at:'Preflight'})
if(!pre.ready)return checkpointEnvelope({status:'blocked',at:'Preflight',blockers:pre.blockers})

phase('Implement')
const impl=await llmAgent(['你是实现层。严格按已批准 OpenSpec execution overlay 实现。',digest(plan),'只改 whitelist；mustNotTouch 禁止触碰。改前/改后 Read；不 commit、不 push、不提前勾 task；做不完列 notImplemented。',K_FAIL_LOUD].join('\n'),{label:'implement',phase:'Implement',model:implementationModel,effort:'xhigh',schema:IMPLEMENT_SCHEMA})
if(!impl)return checkpointEnvelope({status:'failed',at:'Implement',plan})
if(!impl.done)return checkpointEnvelope({status:'escalate',at:'Implement',reason:impl.notImplemented.join('；')||impl.honesty,plan})

phase('Verify')
const verify=await llmAgent(['你是独立 Verify。自己跑测试/typecheck；只验证，不 commit。',`tests=${plan.testCommands.join(' && ')}`,`baseline=${pre.testPassed}/${pre.testTotal}; typecheck=${pre.typecheckExit}`,`GitNexus detect_changes(scope=all, repo="${GNX}", worktree="${WORKTREE}")；公共 symbol 重跑 context/impact。`,`核对 ${TASKS_DOC} 验收；completedTaskIds 仅填有测试/退出码/代码证据的任务，暂不勾 checkbox。`,K_FAIL_LOUD].join('\n'),{label:'verify',phase:'Verify',model:MODEL_VERIFY,schema:VERIFY_SCHEMA})

const significant=(a,p)=>a>p*1.5&&(a-p)>3
let routeMiss=false
if(verify?.actualImpact&&plan?.predictedImpact)routeMiss=significant(verify.actualImpact.affectedSymbols,plan.predictedImpact.affectedSymbols)||significant(verify.actualImpact.affectedModules,plan.predictedImpact.affectedModules)||significant(verify.actualImpact.processes,plan.predictedImpact.processes)
const needsAudit=effectiveRoute==='CRITICAL'||routeMiss||architectChoices.length>0
let audit=null
if(needsAudit){
  phase('Audit')
  audit=await llmAgent(['你是 Final Audit。亲自看 git diff/changed files/关键 caller/OpenSpec requirements，不得只看摘要。',`route=${effectiveRoute}; routeMiss=${routeMiss}; architectureDecisionGate=${architectChoices.length>0}`,architectChoices.length?`架构决议：${architectChoices.map(x=>`${x.id}=${x.label}: ${x.consequence}`).join('；')}`:'',digest(plan),`verify=${verify?.status??'?'} ${verify?.testPassed??'?'}/${verify?.testTotal??'?'}`, '重点：实现是否偏离 spec/design、OpenSpec sync 是否漏掉已批准 delta、实际 blast radius 是否超计划。'].filter(Boolean).join('\n'),{label:'final-audit',phase:'Audit',effortRole:'Audit',model:MODEL_REVIEW,effort:'high',schema:AUDIT_SCHEMA})
  if(!audit)return checkpointEnvelope({status:'failed',at:'Audit',verify})
}
const auditBlocks=needsAudit&&audit.verdict!=='accept'
const commitExpected=REQUIRE_COMMIT&&verify?.status==='green'&&!auditBlocks
let commitResult=null
if(commitExpected){
  phase('Commit')
  commitResult=await llmAgent(['你是 Commit 层。Verify green，必要 Audit 已 accept。',`只允许把这些 task 勾完成：${verify.completedTaskIds.join(', ')||'无'}`,`tasks=${TASKS_DOC}`,'逐条确认当前确实 [ ] 且有 Verify 证据，再改 [x]；列表外绝不勾。',K_GIT_SAFE,'代码与 docs 可分两笔提交；不 push。',K_FAIL_LOUD].join('\n'),{label:'commit',phase:'Commit',model:MODEL_COMMIT,schema:COMMIT_SCHEMA})
}
const commitSucceeded=commitResult?.committed===true&&(commitResult?.commits?.length??0)>0
const finalStatus=audit?.verdict==='needs-rework'?'needs-rework':audit?.verdict==='escalate-to-human'?'escalate-to-human':commitExpected&&!commitSucceeded?'commit-failed':verify?.status??'unknown'
return checkpointEnvelope({
  status:finalStatus,milestone:MILESTONE,ts:TS,patchRounds,specSync,preflight:pre,impl,verify,audit,commitResult,
  routing:{...routing,effectiveRoute,plannerModel,implementationModel,reviewModel:MODEL_REVIEW,architectureDecisionGate:architectChoices.length>0,architectChoices,routeMiss},
  broadcast:`[${MILESTONE}] OpenSpec-first · route=${effectiveRoute} · planner=${plannerModel} · cache=${reviewArtifactHit?(NEEDS_CHECKPOINT_VALIDATE?'review-validated':'review-hit'):basePlanArtifactHit?(NEEDS_CHECKPOINT_VALIDATE?'plan-validated':'plan-hit'):recoveryPatched?'plan-recovery':'miss'} · patches=${patchRounds} · ${finalStatus}`,
})
