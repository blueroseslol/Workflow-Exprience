// gitnexus-routed.js — GitNexus 驱动的动态模型路由模板（实验性）
//
// 架构（修正版控制流，v3：所有等级统一拆开 Verify/Commit，routeMiss 一律在提交前计算）：
//   Recon(haiku 建证据地图)
//     → JS 纯函数 computeRouting() 算 ComplexityScore（含 minRoute 下限）
//     → Plan(路由派生模型，亲自重读代码，输出 predictedImpact.risk)
//     → Plan Risk Gate(JS：Planner 自评风险高于路由 → 早退 route-escalation-required，带 nextArgs.minRoute)
//     → Review(fable 对抗；revise/block → 早退 replan-required，带 nextArgs.replanFeedback+replanAttempt，有上限，不带病实现)
//     → Preflight(haiku 建测试基线；fail-closed)
//     → Implement(路由派生模型；未完成 → 早退 escalate)
//     → Verify(haiku 验证 + GitNexus 实测，**绝不提交**)
//     → routeMiss(JS：预估 vs 实测，三维度)
//     → Final Audit(fable：CRITICAL 必跑 / 任意 route 出现 routeMiss 触发)
//     → Commit Gate(JS：verify 绿 且 audit accept 才放行) → Commit(haiku)
//
// v3 修正（对照审阅意见）：
//   - 所有 route 统一 Verify/Commit 分离：routeMiss 在提交前计算，
//     LOW/MEDIUM 也能在提交前被 routeMiss 拦住并升级 Audit（v2 是 LOW/MEDIUM 先提交后才发现）
//   - needsAudit = CRITICAL || routeMiss —— LOW 的 routeMiss 比 HIGH 更值得审计
//   - minRoute：Plan Risk Gate 升级带 nextArgs.minRoute；主 agent 同 session 用 resumeFromRunId
//     叠加 nextArgs 续跑（Recon 缓存命中，仅 Plan 及之后重跑），跨 session 才开新 workflow，
//     minRoute 兜底使升级粘滞、不在 Recon 处回落（避免升级-回落死循环）
//   - Preflight fail-closed：agent 未返回(null) 也算失败，不再静默放行
//   - Commit 失败不落 green：commitExpected 而未成功 → status=commit-failed
//   - fail-safe 不再编造 score=75（落在 CRITICAL 区间却标 HIGH，污染统计），改为 score=null + failsafe
//   - Final Audit 强制亲自 git diff / Read 变更 / 复查 caller，不得只摘要转述
//   - replan-required 有界且可推进：revise 但反馈为空 → fail-closed 直接 blocked；
//     否则 nextArgs 带回 replanAttempt+1 与累计 replanFeedback，二者都拼进 Plan prompt
//     （attempt 每轮递增 + 反馈累计 → prompt 每轮必变 → 缓存必 miss，杜绝相同意见无限重放）；
//     超过 maxReplan（默认 3）次仍 revise → blocked 转人工，不再自动续跑
//
// 定位：与 four-phase.js（稳定 baseline）并存的【实验模板】。
// 路由依据与阈值见 skills/workflow-experience/references/dynamic-routing.md
//
// 用法：复制本文件，替换 CONFIG 段 <占位>，通过 Workflow({script}) 或 scriptPath 运行。
// 沙箱禁 import/require、禁 Date.now()/Math.random() —— 本模板路由计算是纯函数，resume-safe。

export const meta = {
  name: '<kebab-case-name>',
  description: '<一句话，会显示在权限对话框>；GitNexus 动态路由',
  phases: [
    { title: 'Recon', model: 'haiku' },
    // Plan / Review / Implement / Audit 的模型由路由运行时派生，meta 是纯字面量无法声明，故不写 model
    { title: 'Plan' },
    { title: 'Review' },
    { title: 'Preflight', model: 'haiku' },
    { title: 'Implement' },
    { title: 'Verify', model: 'haiku' },
    { title: 'Audit' },
    { title: 'Commit', model: 'haiku' },
  ],
}

function llmAgent(prompt, opts = {}) {
  return agent(prompt, {
    ...opts,
    disallowedTools: [...new Set([...(opts.disallowedTools ?? []), 'SendMessage', 'ListAgents'])],
  })
}

// ---------- CONFIG（改这里） ----------
const REPO = args?.repo ?? '<D:/path/to/repo>'
const GNX = args?.gitnexusRepo ?? '<indexed-repo-name>'   // list_repos 里的准确名，目录名 ≠ repo 名
// linked worktree 时必须显式传 worktree，否则 GitNexus detect_changes 可能对错 checkout diff，出现假 0 changed
const WORKTREE = args?.worktree ?? REPO
const TASK = args?.task ?? '<任务描述：要做什么、为什么>'
const TASKS_DOC = args?.tasksDoc ?? ''                    // openspec tasks.md 路径，无则空
const MILESTONE = args?.milestone ?? '<x.y>'
const TS = args?.ts ?? 'unknown-ts'                       // 时间戳必须外部注入：脚本内 Date.now() 会 throw

// 模型别名（写逻辑别名而非第三方全 ID，未来换 provider 不用改脚本；全部可被 args 覆盖）
const MODEL_RECON = args?.reconModel ?? 'haiku'     // DeepSeek V4 Flash
const MODEL_DEFAULT = args?.defaultModel ?? 'sonnet' // Kimi K3
const MODEL_STRONG = args?.strongModel ?? 'opus'     // Claude Opus 5
const MODEL_REVIEW = args?.reviewModel ?? 'fable'    // GPT-5.6 Sol
const MODEL_VERIFY = args?.verifyModel ?? 'haiku'    // DeepSeek V4 Flash
const MODEL_PREFLIGHT = args?.preflightModel ?? MODEL_VERIFY
const MODEL_COMMIT = args?.commitModel ?? MODEL_VERIFY
// Implement 顾问：默认 fable，只做只读裁决；最多 3 次，仍不收敛才升级实现模型
const ADVISOR_MODEL = args?.advisorModel ?? MODEL_REVIEW
const ADVISOR_MAX = args?.advisorMax ?? 3
// implementation escalation 只覆盖 Implement，不把整个 route 强行升成 CRITICAL
const IMPLEMENTATION_MODEL_OVERRIDE = args?.implementationModelOverride ?? null
const IMPLEMENTATION_ESCALATION_REASON = args?.implementationEscalationReason ?? null

// 路由阈值（args 可调，不写成魔法常量；未来应据 corpus 校准，见 dynamic-routing.md）
const ROUTE_LOW_MAX = args?.routeLowMax ?? 24
const ROUTE_MEDIUM_MAX = args?.routeMediumMax ?? 49
const ROUTE_HIGH_MAX = args?.routeHighMax ?? 74

// 路由下限：上次 Plan Risk Gate 升级后由 nextArgs.minRoute 传入，让升级粘滞（不在 Recon 处回落）
const MIN_ROUTE = args?.minRoute ?? 'LOW'

// LOW 是否也强制过 Review（默认 false = 跳过省 token；true = 全量过）
const ALWAYS_REVIEW = args?.alwaysReview ?? false

// 是否要求最终提交（只读调研类可传 false）
const REQUIRE_COMMIT = args?.requireCommit ?? true

// 用户已拍板（不得当成 blocker 再问）
const DECIDED = args?.decisions ?? {}

// 上轮 Review=revise 的修订意见（replan-required 早退时由 nextArgs.replanFeedback 带回）
// 它会被拼进 Plan prompt —— prompt 进缓存键，所以续跑时 Plan 必重跑且必须产出修订后的计划，
// 不能像 route-escalation 那样只带 minRoute：跨档升级靠 plannerModel 变（model 进缓存键）、
// 同档升级靠 Plan prompt 内嵌的 route 变化（prompt 进缓存键）——二者都只让 Plan 重跑，
// 都不会让它吸收修订意见；replan 必须显式带反馈进 prompt。
const REPLAN_FEEDBACK = args?.replanFeedback ?? null

// 重规划轮次与上限：replanAttempt 随每次 replan-required 早退 +1 并拼进 Plan prompt，
// 保证即使 Review 逐字重复同一意见，prompt 也每轮不同（缓存必 miss，不可能无限重放）；
// 超过 MAX_REPLAN 仍 revise → blocked 转人工（fail-closed，不无限烧 token）。
const REPLAN_ATTEMPT = args?.replanAttempt ?? 0
const MAX_REPLAN = args?.maxReplan ?? 3

// 脏工作区标记：Advisor replan 早退时 Implement 已把上一版方案的 provisional implementation
// 落盘，下一轮 Planner 面对的是被部分修改的 workspace——残留 diff 是【待裁决的旧方案】，
// 不是干净的现状基线。true 时 Plan prompt 注入 dirtyWorktreeDigest，强制 Planner 先审阅
// git status/git diff 并对每处残留明确决定 retain/replace，防止把旧方案误当现状自动继承。
// 由 Advisor replan 早退的 nextArgs.dirtyWorktree=true 传入；Review=revise 路径只透传
// （Review 在 Implement 之前，本轮不产生新污染，但上轮残留仍在）。
const DIRTY_WORKTREE = args?.dirtyWorktree ?? false

// ---------- v0.4.3 checkpoint 消费(openspec-incremental.js 蓝本移植) ----------
// 纯 JS FNV-1a:沙箱禁 require/crypto,nochg checkpointKey 的 task 摘要必须与
// hooks/checkpoint-lib.cjs 同公式,否则跨通道建出两份 state 互相不可见。
function fnv1aHex(s){let h=0x811c9dc5;const str=String(s||'');for(let i=0;i<str.length;i++){h^=str.charCodeAt(i);h=(h+((h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24)))>>>0}return('0000000'+h.toString(16)).slice(-8)}
const CHECKPOINT_SCHEMA_VERSION = 2
const CHECKPOINT_CACHE_VERSION = 2
const CHECKPOINT_TEMPLATE_KIND = 'gitnexus-routed-v2'
const CHECKPOINT_KEY = args?.checkpointKey ?? `nochg:${fnv1aHex(TASK)}::${MILESTONE}`
const CHECKPOINT_META = {
  kind: CHECKPOINT_TEMPLATE_KIND,
  schemaVersion: CHECKPOINT_SCHEMA_VERSION,
  cacheVersion: CHECKPOINT_CACHE_VERSION,
  key: CHECKPOINT_KEY,
  task: TASK,
  milestone: MILESTONE,
  projectRoot: REPO,
}
const PRIOR_STATE = args?.priorState ?? null
const CHECKPOINT_VALIDATION = args?.checkpointValidation ?? null
const STATE_KEY_MATCH = !!(PRIOR_STATE && PRIOR_STATE.kind === 'ultracode-semantic-state' && PRIOR_STATE.checkpointKey === CHECKPOINT_KEY)
const STATE_COMPATIBLE = !!(STATE_KEY_MATCH &&
  PRIOR_STATE.schemaVersion === CHECKPOINT_SCHEMA_VERSION &&
  PRIOR_STATE.cacheVersion === CHECKPOINT_CACHE_VERSION &&
  PRIOR_STATE.templateKind === CHECKPOINT_TEMPLATE_KIND)
const PRIOR_DIRTY = !!(PRIOR_STATE?.dirtyWorktree === true || CHECKPOINT_VALIDATION?.dirtyWorktree === true)
const TRUSTED_ARTIFACT_REUSE = !!(STATE_COMPATIBLE && !PRIOR_STATE?.legacyUnverified && !PRIOR_DIRTY &&
  PRIOR_STATE?.fingerprint?.complete === true && CHECKPOINT_VALIDATION?.valid === true)
const LEGACY_ARTIFACT_CANDIDATE = !!(STATE_KEY_MATCH && !STATE_COMPATIBLE &&
  Object.keys(PRIOR_STATE?.decisionApply?.decisions ?? {}).length === 0 && Object.keys(DECIDED).length === 0 &&
  CHECKPOINT_VALIDATION?.legacyUnverified === true)
const DIRTY_ARTIFACT_CANDIDATE = !!(STATE_COMPATIBLE && !PRIOR_STATE?.legacyUnverified && PRIOR_DIRTY && CHECKPOINT_VALIDATION?.valid === true)
const KINDNONE_ARTIFACT_CANDIDATE = !!(STATE_COMPATIBLE && !PRIOR_STATE?.legacyUnverified && !PRIOR_DIRTY &&
  PRIOR_STATE?.fingerprint?.source?.kind === 'none' && CHECKPOINT_VALIDATION?.dependencyComplete === true &&
  CHECKPOINT_VALIDATION?.codeValid === true && CHECKPOINT_VALIDATION?.sourceValid === false)
const NEEDS_CHECKPOINT_VALIDATE = LEGACY_ARTIFACT_CANDIDATE || DIRTY_ARTIFACT_CANDIDATE || KINDNONE_ARTIFACT_CANDIDATE
const ARTIFACT_REUSE = TRUSTED_ARTIFACT_REUSE || NEEDS_CHECKPOINT_VALIDATE
const HAS_REPLAN_INPUT = !!(REPLAN_FEEDBACK?.length || REPLAN_ATTEMPT > 0 || PRIOR_STATE?.pendingTransition?.status === 'replan-required')

// ---------- 复用常量 ----------
const S_STR_ARR = { type: 'array', items: { type: 'string' } }
const S_NUM0 = { type: 'number', minimum: 0 }   // 计数一律非负，防止负数污染 ComplexityScore
const K_FILE_LINE = '每条结论必须引用你亲自 Read 到的 file:line，禁止凭摘要、记忆或 Recon 转述。'
const K_GIT_SAFE = '禁止 git add . 与 git add -A，逐文件 add；feat 与 docs 分两笔提交；不 push。'
const K_FAIL_LOUD = '如实报告。测试失败就写失败并附原始输出，不得伪造成功、不得吞掉错误。'

// ---------- Schemas ----------

// Recon 只输出【原始指标】，绝不输出 score/route —— 评分是 JS 纯函数的事，LLM 不参与。
// 字段以任务实际需要为准，可按 GitNexus 当前 API 调整（不要为统一而削足适履）。
const RECON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['entrySymbols', 'evidence', 'impact', 'executionFlows', 'modules', 'contracts', 'riskFlags', 'uncertainty', 'unknowns'],
  properties: {
    entrySymbols: S_STR_ARR,
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'fileLine', 'confidence'],
        properties: {
          claim: { type: 'string' },
          fileLine: { type: 'string' },
          confidence: { type: 'string', enum: ['verified', 'likely', 'speculative'] },
        },
      },
    },
    // upstream impact 的深度分层计数（路由的 Blast Radius 输入）
    impact: {
      type: 'object',
      additionalProperties: false,
      required: ['depth1', 'depth2', 'depth3', 'affectedSymbols'],
      properties: {
        depth1: S_NUM0,
        depth2: S_NUM0,
        depth3: S_NUM0,
        affectedSymbols: S_NUM0,
      },
    },
    executionFlows: { ...S_NUM0, description: '入口 symbol 参与的 execution flow / process 数（unique）' },
    modules: {
      type: 'object',
      additionalProperties: false,
      required: ['count', 'crossModule', 'crossRepo'],
      properties: {
        count: { ...S_NUM0, description: '预计触碰的文件数' },
        crossModule: { type: 'boolean' },
        crossRepo: { type: 'boolean' },
      },
    },
    contracts: {
      type: 'object',
      additionalProperties: false,
      required: ['publicApi', 'schemaChange', 'consumerCount', 'shapeMismatchCount'],
      properties: {
        publicApi: { type: 'boolean' },
        schemaChange: { type: 'boolean' },
        consumerCount: S_NUM0,
        shapeMismatchCount: { ...S_NUM0, description: 'shape_check 报告的 mismatch 数' },
      },
    },
    riskFlags: {
      type: 'object',
      additionalProperties: false,
      required: ['concurrency', 'stateMachine', 'security', 'persistence', 'migration', 'reflectionOrGeneratedCode'],
      properties: {
        concurrency: { type: 'boolean' },
        stateMachine: { type: 'boolean' },
        security: { type: 'boolean' },
        persistence: { type: 'boolean' },
        migration: { type: 'boolean' },
        reflectionOrGeneratedCode: { type: 'boolean' },
      },
    },
    uncertainty: {
      type: 'object',
      additionalProperties: false,
      required: ['indexStale', 'lowerBound', 'partial', 'truncated', 'ambiguous', 'gitnexusUnavailable'],
      properties: {
        indexStale: { type: 'boolean' },
        lowerBound: { type: 'boolean', description: 'impact epistemic=lower-bound' },
        partial: { type: 'boolean' },
        truncated: { type: 'boolean' },
        ambiguous: { type: 'boolean', description: '入口 symbol 无法唯一定位' },
        gitnexusUnavailable: { type: 'boolean' },
      },
    },
    unknowns: S_STR_ARR,
  },
}

// DecisionApply 蓝本移植(openspec-incremental.js):拍板点结构化,options 预编码,
// 续跑由 JS applyDecisions 0 token 应用 —— decisions 绝不进 Plan prompt(成本红线 #1)。
const OPTION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['label', 'consequence', 'requiresArchitect', 'activateSlices', 'disableSlices', 'whitelistAdd', 'mustNotTouchAdd', 'testCommandsAdd'],
  properties: {
    label: { type: 'string' }, consequence: { type: 'string' }, requiresArchitect: { type: 'boolean' },
    activateSlices: S_STR_ARR, disableSlices: S_STR_ARR, whitelistAdd: S_STR_ARR, mustNotTouchAdd: S_STR_ARR, testCommandsAdd: S_STR_ARR,
  },
}
const DECISION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['id', 'question', 'recommendation', 'evidence', 'options'],
  properties: { id: { type: 'string' }, question: { type: 'string' }, recommendation: { type: 'string' }, evidence: { type: 'string' }, options: { type: 'array', items: OPTION_SCHEMA } },
}

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'rootCause', 'slices', 'whitelist', 'mustNotTouch', 'testCommands', 'evidenceDependencies', 'predictedImpact', 'decisionPoints', 'rollback', 'openQuestionsForUser'],
  properties: {
    verdict: { type: 'string', enum: ['implementable', 'blocked'] },
    rootCause: { type: 'string', description: '根因,必须含【亲自】Read 到的 file:line' },
    slices: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'files', 'rationale'],
        properties: {
          id: { type: 'string', description: '稳定 slice id(S1/S2/...),DecisionApply 按它匹配 activate/disable' },
          title: { type: 'string' },
          files: S_STR_ARR,
          rationale: { type: 'string', description: '含亲自 Read 到的 file:line' },
        },
      },
    },
    whitelist: S_STR_ARR,
    mustNotTouch: S_STR_ARR,
    testCommands: S_STR_ARR,
    // 验证过但不直接修改的 caller/public contract/接口/关键测试文件,供 collectPlanCodePaths 指纹判定
    evidenceDependencies: S_STR_ARR,
    // 预估爆炸半径 + Planner 亲自读码后的风险自评;risk 供 Plan Risk Gate 与 Recon 路由二次纠偏
    predictedImpact: {
      type: 'object',
      additionalProperties: false,
      required: ['affectedSymbols', 'affectedModules', 'processes', 'risk'],
      properties: {
        affectedSymbols: S_NUM0,
        affectedModules: S_NUM0,
        processes: S_NUM0,
        risk: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
      },
    },
    // 唯一拍板早退通道:无拍板点的任务必须输出 [](不得编造拍板点)
    decisionPoints: { type: 'array', items: DECISION_SCHEMA },
    rollback: { type: 'string' },
    // 仅用于无法预编码选项的开放问题;非空不再触发 need-decision 早退(防 resume 死循环),
    // 仅 log 警告并按空继续,问题透传 Implement/Advisor
    openQuestionsForUser: S_STR_ARR,
  },
}

// 对抗式审阅：blockers 必须带证据，过滤「感觉有风险」式空泛意见
const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'blockers', 'concerns'],
  properties: {
    verdict: { type: 'string', enum: ['approve', 'revise', 'block'] },
    blockers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['issue', 'evidence'],
        properties: {
          issue: { type: 'string' },
          evidence: { type: 'string', description: 'file:line / GitNexus 结果 / 计划字段 / 测试证据，至少一种，不接受空泛判断' },
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
        testTotal: S_NUM0,
        testPassed: S_NUM0,
        testFailed: S_NUM0,
        typecheckExit: { type: 'number' },
      },
    },
    blockers: S_STR_ARR,
  },
}

const IMPLEMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'done', 'filesChanged', 'notImplemented', 'honesty',
    'needsAdvisor', 'advisorQuestion', 'blockingEvidence',
  ],
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
    needsAdvisor: { type: 'boolean', description: '只有出现有证据的高风险/疑难决策且无法安全继续时才 true' },
    advisorQuestion: { type: 'string', description: 'needsAdvisor=true 时给顾问的具体问题；否则空字符串' },
    blockingEvidence: S_STR_ARR,
  },
}

// Implement 顾问只给裁决，不接管 workspace
const IMPLEMENT_ADVISOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reasoning', 'nextStep', 'evidence'],
  properties: {
    verdict: {
      type: 'string',
      enum: ['continue', 'change-approach', 'replan', 'stop-and-ask', 'escalate-implementation'],
    },
    reasoning: { type: 'string' },
    nextStep: { type: 'string' },
    evidence: S_STR_ARR,
  },
}

// 取证型 + GitNexus 实测爆炸半径（actualImpact）。Verify 只验证、不提交（提交统一由 Commit 层负责）。
const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'vitestTail', 'testTotal', 'testPassed', 'testFailed', 'typecheckSrcExit', 'scanFindings', 'actualImpact'],
  properties: {
    status: { type: 'string', enum: ['green', 'red'] },
    vitestTail: { type: 'string', description: '测试真实尾部输出，原样粘贴' },
    testTotal: S_NUM0,
    testPassed: S_NUM0,
    testFailed: S_NUM0,
    typecheckSrcExit: { type: 'number' },
    scanFindings: S_STR_ARR,
    // 实现完成后用 GitNexus detect_changes / impact 实测的爆炸半径
    actualImpact: {
      type: 'object',
      additionalProperties: false,
      required: ['affectedSymbols', 'affectedModules', 'processes'],
      properties: {
        affectedSymbols: { ...S_NUM0, description: 'detect_changes 实际影响的符号数' },
        affectedModules: S_NUM0,
        processes: S_NUM0,
      },
    },
  },
}

const AUDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'findings', 'residualRisk'],
  properties: {
    verdict: { type: 'string', enum: ['accept', 'needs-rework', 'escalate-to-human'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['issue', 'evidence', 'severity'],
        properties: {
          issue: { type: 'string' },
          evidence: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        },
      },
    },
    residualRisk: { type: 'string' },
  },
}

// 提交层（所有等级统一由它提交；仅 Commit Gate 放行时执行）
const COMMIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['committed', 'commits', 'note'],
  properties: {
    committed: { type: 'boolean' },
    commits: S_STR_ARR,
    note: { type: 'string' },
  },
}

// CheckpointValidate 输出(openspec 蓝本)
const CHECKPOINT_VALIDATE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['planStillValid', 'reviewStillValid', 'changedSliceIds', 'reasons', 'requiresArchitect'],
  properties: {
    planStillValid: { type: 'boolean' }, reviewStillValid: { type: 'boolean' },
    changedSliceIds: S_STR_ARR, reasons: S_STR_ARR,
    requiresArchitect: { type: 'boolean', description: '失效修复涉及架构/public contract/state ownership 时 true;机械/局部修复 false' },
  },
}

// ---------- 路由：纯 JS 确定性计算（不进 agent、不耗 token、resume-safe） ----------
const ROUTE_ORDER = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
const ROUTE_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 }
const maxRoute = (a, b) => ROUTE_ORDER[Math.max(ROUTE_ORDER.indexOf(a), ROUTE_ORDER.indexOf(b))]
const uniq = xs => { const out = []; for (const x of xs ?? []) if (x && !out.includes(x)) out.push(x); return out }
const canonicalize = value => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const key of Object.keys(value).sort()) if (value[key] !== undefined) out[key] = canonicalize(value[key])
  return out
}
const stableStringify = value => JSON.stringify(canonicalize(value))
const decisionKey = o => stableStringify(o ?? {})

function applyDecisions(base, decisions) {
  let slices = [...(base.slices ?? [])], whitelist = [...(base.whitelist ?? [])],
    mustNotTouch = [...(base.mustNotTouch ?? [])], testCommands = [...(base.testCommands ?? [])]
  const unresolved = [], invalid = [], unknown = [], architect = []
  const known = new Set()
  for (const d of base.decisionPoints ?? []) {
    if (known.has(d.id)) { invalid.push({ id: d.id, reason: 'duplicate-decision-id' }); continue }
    known.add(d.id)
    const labels = (d.options ?? []).map(o => o.label)
    if (new Set(labels).size !== labels.length) { invalid.push({ id: d.id, reason: 'duplicate-option-label' }); continue }
    if (!(d.id in decisions)) { unresolved.push(d); continue }
    const o = (d.options ?? []).find(x => x.label === decisions[d.id])
    if (!o) { invalid.push({ id: d.id, selected: decisions[d.id] }); continue }
    slices = slices.filter(s => !o.disableSlices.includes(s.id))
    const missing = o.activateSlices.filter(id => !slices.some(s => s.id === id))
    if (missing.length) { invalid.push({ id: d.id, missing }); continue }
    whitelist = uniq(whitelist.concat(o.whitelistAdd)); mustNotTouch = uniq(mustNotTouch.concat(o.mustNotTouchAdd)); testCommands = uniq(testCommands.concat(o.testCommandsAdd))
    if (o.requiresArchitect) architect.push({ decision: d, option: o })
  }
  for (const id of Object.keys(decisions ?? {})) if (!known.has(id)) unknown.push(id)
  return { unresolved, invalid, unknown, architect, plan: { ...base, slices, whitelist, mustNotTouch, testCommands } }
}

function computeRouting(recon) {
  // Fail-safe：Recon 挂了绝不能当 LOW。偏向质量而非便宜 —— 按 HIGH 走，Planner 全程自侦察。
  // 不编造 score：recon 都失败了就没有真实 ComplexityScore，标 score=null + failsafe，避免污染统计。
  if (!recon) {
    const route = maxRoute('HIGH', MIN_ROUTE)
    return {
      score: null,
      failsafe: true,
      breakdown: {},
      route,
      forcedEscalations: ['recon-null → HIGH (fail-safe)'].concat(route !== 'HIGH' ? [`minRoute=${MIN_ROUTE}`] : []),
      uncertaintyScore: 15,
      reasons: ['Recon agent 未返回结构化结果，按 fail-safe 强制升级，Planner 须自行完成全部侦察'],
    }
  }

  // A. Blast Radius（0-30）：upstream impact 按深度加权，近处权重大
  const blast = recon.impact.depth1 * 4 + recon.impact.depth2 * 2 + recon.impact.depth3
  const blastScore = Math.min(30, blast)

  // B. Execution Flow（0-15）：一个 symbol 进入大量业务流程就该升级
  const flowScore = Math.min(15, recon.executionFlows * 3)

  // C. Module / Repo Reach（0-15）：跨 repo 顶格
  let reachScore = 1
  if (recon.modules.crossRepo) reachScore = 15
  else if (recon.modules.crossModule) reachScore = 10
  else if (recon.modules.count >= 2) reachScore = 5

  // D. API / Contract Risk（0-15）
  let contractScore = 0
  if (recon.contracts.publicApi) contractScore += 5
  if (recon.contracts.schemaChange) contractScore += 5
  contractScore += Math.min(3, recon.contracts.consumerCount)
  if (recon.contracts.shapeMismatchCount > 0) contractScore += 2
  contractScore = Math.min(15, contractScore)

  // E. Behavioral Risk（0-10）：每个行为风险标记 +2
  let behaviorScore = 0
  for (const k of ['concurrency', 'stateMachine', 'security', 'persistence', 'migration', 'reflectionOrGeneratedCode'])
    if (recon.riskFlags[k]) behaviorScore += 2
  behaviorScore = Math.min(10, behaviorScore)

  // F. Uncertainty（0-15）：只升不降。每个不确定标记 +2，unknowns 每条 +1（封顶 +3）
  let uncertaintyScore = 0
  for (const k of ['indexStale', 'lowerBound', 'partial', 'truncated', 'ambiguous', 'gitnexusUnavailable'])
    if (recon.uncertainty[k]) uncertaintyScore += 2
  uncertaintyScore += Math.min(3, recon.unknowns.length)
  uncertaintyScore = Math.min(15, uncertaintyScore)

  const score = blastScore + flowScore + reachScore + contractScore + behaviorScore + uncertaintyScore

  let route = score <= ROUTE_LOW_MAX ? 'LOW'
    : score <= ROUTE_MEDIUM_MAX ? 'MEDIUM'
    : score <= ROUTE_HIGH_MAX ? 'HIGH'
    : 'CRITICAL'

  // 硬升级规则：即使 score 偏低，命中即抬升（只升不降）
  const forcedEscalations = []
  const esc = (cond, to, why) => {
    if (!cond) return
    const nr = maxRoute(route, to)
    if (nr !== route) { forcedEscalations.push(why); route = nr }
  }
  esc(recon.uncertainty.gitnexusUnavailable, 'MEDIUM', 'GitNexus 不可用 → ≥MEDIUM')
  esc(recon.contracts.shapeMismatchCount > 0, 'MEDIUM', 'shapeMismatch>0 → ≥MEDIUM')
  esc(recon.contracts.publicApi, 'MEDIUM', 'publicApi → ≥MEDIUM')
  esc(recon.riskFlags.stateMachine, 'MEDIUM', 'stateMachine → ≥MEDIUM')
  esc(recon.riskFlags.concurrency, 'MEDIUM', 'concurrency → ≥MEDIUM')
  esc(recon.riskFlags.persistence, 'MEDIUM', 'persistence → ≥MEDIUM')
  esc(recon.modules.crossRepo, 'HIGH', 'crossRepo → HIGH')
  esc(recon.riskFlags.security, 'HIGH', 'security → HIGH')
  esc(recon.riskFlags.migration, 'HIGH', 'migration → HIGH')
  esc((recon.uncertainty.partial || recon.uncertainty.truncated) && recon.contracts.publicApi,
    'CRITICAL', 'partial/truncated + publicApi → CRITICAL')
  // minRoute 下限：上次 Plan Risk Gate 升级的粘滞，不让 Recon 把它拉回低位
  esc(true, MIN_ROUTE, MIN_ROUTE !== 'LOW' ? `minRoute=${MIN_ROUTE}（上次升级粘滞）` : null)
  // 清理 null 理由（MIN_ROUTE=LOW 时）
  for (let i = forcedEscalations.length - 1; i >= 0; i--) if (!forcedEscalations[i]) forcedEscalations.splice(i, 1)

  const reasons = [
    `blast=${blastScore} (d1*4+d2*2+d3=${blast})`,
    `flow=${flowScore} (${recon.executionFlows}*3)`,
    `reach=${reachScore}`,
    `contract=${contractScore}`,
    `behavior=${behaviorScore}`,
    `uncertainty=${uncertaintyScore}`,
  ]

  return { score, breakdown: { blastScore, flowScore, reachScore, contractScore, behaviorScore, uncertaintyScore }, route, forcedEscalations, uncertaintyScore, reasons }
}

// ================= Recon：haiku 建证据地图 =================
phase('Recon')
const reconArtifactHit = !!(TRUSTED_ARTIFACT_REUSE && PRIOR_STATE.recon)
const recon = reconArtifactHit
  ? PRIOR_STATE.recon
  : await llmAgent(
  [
    '你是 Recon 侦察兵（只读）。你的职责是建立 Repo Evidence Map，**不是**制定实现方案，**更不是**决定难度等级。',
    '',
    `任务：${TASK}`,
    `仓库根：${REPO}`,
    '',
    '## 必须执行的 GitNexus 侦察（按序）',
    `1. list_repos 确认 repo 名（目录名 ≠ repo 名），绑定到「${GNX}」。`,
    '2. 检查索引时间戳：落后于工作区就把 uncertainty.indexStale 置 true。',
    '3. query 找相关 execution flows，统计 unique 数量填 executionFlows。',
    '4. 对主要入口 symbol 跑 context，拿调用面，填 entrySymbols。',
    '5. 对预计修改的公共 symbol 跑 impact(direction=upstream, maxDepth=3)，把 depth1/depth2/depth3/affectedSymbols 填进 impact。',
    '   同一 symbol 只计一次，按最近的 depth 归类；多入口的计数要去重，不得重复累加。',
    '6. 涉及 API 修改跑 api_impact；涉及 response/schema 修改跑 shape_check，把 consumerCount / shapeMismatchCount 填进 contracts。',
    '7. 必要时读取 processes。',
    '',
    '## 硬性纪律',
    '- GitNexus 与源码/rg 冲突时，以源码为准。',
    '- 每条架构结论必须带你【亲自 Read 到】的 file:line，标 confidence=verified/likely/speculative。',
    '- 禁止「看起来应该只影响这里」「GitNexus LOW 所以肯定安全」这类结论。',
    '- GitNexus 返回 partial / truncated / lower-bound / ambiguous / 索引陈旧 时，把对应 uncertainty 标记置 true —— 这会【升级】路由，不是降低风险。',
    '- 查不清的写进 unknowns，不要编。',
    '',
    '填全 RECON_SCHEMA 的每个字段。你只输出原始事实与计数，不输出任何评分或路由判断。',
  ].join('\n'),
  { label: 'recon', phase: 'Recon', model: MODEL_RECON, schema: RECON_SCHEMA }
)
if (TRUSTED_ARTIFACT_REUSE && PRIOR_STATE.recon) log('Recon ARTIFACT HIT:fingerprint 未变化,复用历史 evidence map')

// ---------- 路由计算（JS，确定性，一次冻结本轮） ----------
const routing = computeRouting(recon)
log(`路由：score=${routing.score ?? 'failsafe'} → ${routing.route}` + (routing.forcedEscalations.length ? `（强制升级：${routing.forcedEscalations.join('；')}）` : ''))

// 模型链由路由派生
const plannerModel = (routing.route === 'HIGH' || routing.route === 'CRITICAL') ? MODEL_STRONG : MODEL_DEFAULT
let implementationModel = IMPLEMENTATION_MODEL_OVERRIDE
  ?? (routing.route === 'CRITICAL' ? MODEL_STRONG : MODEL_DEFAULT)
const reviewModel = MODEL_REVIEW
let needsReview = ALWAYS_REVIEW || routing.route !== 'LOW'

// ================= Plan：强模型重读关键代码（Recon 是导航器，不是事实代理） =================
phase('Plan')
const reconDigest = recon
  ? [
      '## Recon 证据地图（仅供导航定位，你必须亲自重读关键代码核实）',
      `入口 symbols：${recon.entrySymbols.join('、') || '（无）'}`,
      `upstream impact：depth1=${recon.impact.depth1} depth2=${recon.impact.depth2} depth3=${recon.impact.depth3} affected=${recon.impact.affectedSymbols}`,
      `executionFlows=${recon.executionFlows} · 文件数=${recon.modules.count} · crossModule=${recon.modules.crossModule} · crossRepo=${recon.modules.crossRepo}`,
      `contracts：publicApi=${recon.contracts.publicApi} schemaChange=${recon.contracts.schemaChange} consumers=${recon.contracts.consumerCount} shapeMismatch=${recon.contracts.shapeMismatchCount}`,
      `riskFlags：${Object.entries(recon.riskFlags).filter(([, v]) => v).map(([k]) => k).join('、') || '（无）'}`,
      `uncertainty：${Object.entries(recon.uncertainty).filter(([, v]) => v).map(([k]) => k).join('、') || '（无）'}`,
      `unknowns：${recon.unknowns.join('；') || '（无）'}`,
      `关键证据：\n${recon.evidence.map(e => `- [${e.confidence}] ${e.claim} @ ${e.fileLine}`).join('\n')}`,
    ].join('\n')
  : '（Recon 未返回——你必须自己完成全部侦察，不得假设安全）'

const replanDigest = REPLAN_FEEDBACK
  ? [
      `## 累计修订意见（第 ${REPLAN_ATTEMPT}/${MAX_REPLAN} 次重规划：必须逐条吸收，产出与上轮不同的计划）`,
      '上一版计划被 Review 判为 revise 并打回。以下每条都必须在新计划中明确回应（采纳并落进切片/whitelist，或给出带 file:line 证据的反驳）。',
      '禁止原样重交上一版计划 —— 那只是浪费一轮。若某条意见与本轮重读代码冲突，用 file:line 证据反驳，不要假装吸收。',
      ...REPLAN_FEEDBACK.map(f => `- ${f}`),
    ].join('\n')
  : ''

// 脏工作区警告：仅 Advisor replan 续跑时为 true（Review=revise 时 Implement 尚未运行）。
// 残留 diff 是上一版方案的 provisional implementation，Planner 必须逐块裁决，不得自动继承。
const dirtyWorktreeDigest = DIRTY_WORKTREE
  ? [
      '## ⚠️ 工作区残留（上一版方案的 provisional implementation，不是现状基线）',
      '上一轮 Implement 已把部分实现落盘，随后 Advisor 判定 Plan 本身需要修订。当前 `git diff` 是【待裁决的旧方案残留】，不是你规划的起点现状。',
      '你必须先亲自运行/阅读 `git status` 与 `git diff`，对每一处残留 hunk 明确裁决：',
      '- **retain**：残留与新计划方向一致 → 吸收进对应切片，并在该切片 rationale 写明「继承上轮残留 + file:line」；',
      '- **replace**：残留基于旧假设或与新计划冲突 → 在对应切片中明确要求实现者先还原/覆盖该处，并给出 file:line 证据。',
      '禁止把残留 diff 当作已验证的正确现状直接继承，也禁止无视它导致新旧两套实现混杂。每个 hunk 的 retain/replace 决定必须在新计划中可检索。',
    ].join('\n')
  : ''

// ---------- CheckpointValidate(NEEDS_CHECKPOINT_VALIDATE 时,廉价只读) ----------
// legacy/dirty/kind=none 的 state 不能把「今天的 hash」当历史真实性:先验证旧 Plan/Review 再决定跳过昂贵模型。
let priorValidation = null
const priorBasePlan = PRIOR_STATE?.basePlan ?? null
const priorEffectivePlan = PRIOR_STATE?.effectivePlan ?? null
if (NEEDS_CHECKPOINT_VALIDATE && priorBasePlan) {
  phase('Recon')
  priorValidation = await llmAgent(
    [
      '你是 CheckpointValidate(廉价只读验证器),不是 Planner。判断历史 Plan/Review 是否仍适用于当前代码与任务。',
      `当前任务:${TASK}`,
      `仓库根:${REPO}; route=${routing.route}; milestone=${MILESTONE}`,
      `历史 BasePlan 根因:${priorBasePlan.rootCause ?? '(无)'}`,
      `历史切片:\n${(priorBasePlan.slices ?? []).map(s => `- ${s.id ?? '?'} ${s.title}(${(s.files ?? []).join(', ')})`).join('\n')}`,
      `历史 whitelist:${(priorBasePlan.whitelist ?? []).join(', ')}`,
      PRIOR_STATE?.review ? `历史 Review verdict=${PRIOR_STATE.review.verdict}` : '历史 Review 缺失',
      PRIOR_DIRTY ? '上轮实现未完成或 Verify 未绿(dirtyWorktree):除代码漂移外,还必须核实已写入 workspace 的部分实现不推翻 Plan/Review 结论;无法核实即 false。' : '',
      PRIOR_STATE?.fingerprint?.source?.kind === 'none' ? '该 state 来自非 OpenSpec 链(sourceKind=none):无 markdown 指纹属预期,重点核实代码侧漂移与任务前提是否仍成立。' : '',
      '必须亲自定向 Read 历史 slices/whitelist/evidenceDependencies 涉及的代码文件;不得只信历史摘要。',
      'planStillValid=true 仅当根因/切片/whitelist/tests 仍成立;reviewStillValid=true 还要求历史 verdict=approve 且没有出现会推翻该审阅的新依赖/风险。',
      'requiresArchitect=true 仅当失效修复涉及架构/public API/schema/concurrency/state ownership/persistence/security;机械/局部修复为 false。',
      '任一关键文件无法核实、caller/contract 漂移时对应值必须 false;changedSliceIds 列受影响 slice。',
      K_FILE_LINE,
    ].filter(Boolean).join('\n'),
    { label: 'checkpoint:validate', phase: 'Recon', model: MODEL_RECON, schema: CHECKPOINT_VALIDATE_SCHEMA }
  )
  if (!priorValidation) log('CheckpointValidate 未返回:fail-closed,不复用历史 Plan/Review')
  else log(`CheckpointValidate${PRIOR_DIRTY ? '(dirty)' : ''}:plan=${priorValidation.planStillValid} review=${priorValidation.reviewStillValid}`)
}

const priorRoute = PRIOR_STATE?.routing?.route ?? null
const basePlanArtifactHit = !!(ARTIFACT_REUSE && priorBasePlan && !HAS_REPLAN_INPUT
  && (TRUSTED_ARTIFACT_REUSE || priorValidation?.planStillValid === true)
  && (!priorRoute || ROUTE_RANK[priorRoute] >= ROUTE_RANK[routing.route]))

const basePlan = basePlanArtifactHit
  ? priorBasePlan
  : await llmAgent(
  [
    `你是 ${MILESTONE} 的规划者（Recon 路由等级 ${routing.route}）。只规划，不改代码，不 commit。`,
    '',
    `任务：${TASK}`,
    `仓库根：${REPO}`,
    TASKS_DOC ? `里程碑文档：${TASKS_DOC} 中 ${MILESTONE} 原文及冻结条款` : '',
    '',
    reconDigest,
    '',
    replanDigest,
    dirtyWorktreeDigest,
    '## 重读纪律（关键）',
    'Recon 只是导航器。**你必须亲自重新 Read**：修改入口、关键 caller、关键 callee、public interface、tests、lifecycle/state ownership 代码。',
    K_FILE_LINE,
    '不得写「根据 Recon 的描述……」作为唯一证据。你的最终结论必须引用【你亲自 Read 到】的 file:line。',
    '',
    '## 预估爆炸半径 + 风险自评（填 predictedImpact）',
    '基于你的阅读，预估本次改动会影响的 affectedSymbols / affectedModules / processes，并给出你亲自读码后的风险评级 risk。',
    '**如果你读码后认为实际风险高于 Recon 给的路由等级，如实填更高的 risk —— 这会触发 Plan Risk Gate 升级，不会被忽略。**',
    '',
    '硬规则：whitelist/slices.files/evidenceDependencies 只能写目标 repo 内的精确文件路径，不得写 glob 或自然语言；evidenceDependencies 必须列出你验证过但不修改的 caller/public contract/关键测试。whitelist 精确到文件，凡不在 whitelist 的都进 mustNotTouch。需要用户拍板的一律写 decisionPoints 并预编码 options（含『其他/转人工』选项）；无拍板点的任务 decisionPoints 必须输出 []，不得编造拍板点。无法预编码的开放问题必须让 Plan blocked，不得交给 Implement 擅自裁决。',
  ].filter(Boolean).join('\n'),
  { label: 'plan', phase: 'Plan', model: plannerModel, effort: 'high', schema: PLAN_SCHEMA }
)
if (basePlanArtifactHit) log('BasePlan ARTIFACT HIT:复用历史未应用决议的计划')

if (!basePlan) return {
  status: 'failed', at: 'Plan', basePlan: null, effectivePlan: null, plan: null,
  decisionApply: { decisions: DECIDED, invalid: [], unknown: [] }, reviewInputCanonical: null,
  artifactCache: { recon: reconArtifactHit, basePlan: false, effectivePlan: false, review: false },
  routing, checkpoint: CHECKPOINT_META,
}
if (basePlan.verdict === 'blocked' || basePlan.openQuestionsForUser?.length) {
  return {
    status: 'blocked', at: 'Plan', reason: basePlan.rootCause,
    questions: basePlan.openQuestionsForUser, basePlan, effectivePlan: null, plan: basePlan,
    decisionApply: { decisions: DECIDED, invalid: [], unknown: [] }, reviewInputCanonical: null,
    artifactCache: { recon: reconArtifactHit, basePlan: basePlanArtifactHit, effectivePlan: false, review: false },
    routing, checkpoint: CHECKPOINT_META,
  }
}
const applied = applyDecisions(basePlan, DECIDED)
if (applied.invalid.length || applied.unknown.length) {
  return {
    status: 'blocked', at: 'DecisionApply', invalid: applied.invalid, unknown: applied.unknown,
    basePlan, effectivePlan: null, plan: basePlan,
    decisionApply: { decisions: DECIDED, invalid: applied.invalid, unknown: applied.unknown },
    reviewInputCanonical: null,
    artifactCache: { recon: reconArtifactHit, basePlan: basePlanArtifactHit, effectivePlan: false, review: false },
    routing, checkpoint: CHECKPOINT_META,
  }
}
if (applied.unresolved.length) {
  return {
    status: 'need-decision', milestone: MILESTONE,
    questions: applied.unresolved.map(d => d.question), decisionPoints: applied.unresolved,
    basePlan, effectivePlan: null, plan: basePlan,
    decisionApply: { decisions: DECIDED, invalid: [], unknown: [] },
    reviewInputCanonical: null,
    artifactCache: { recon: reconArtifactHit, basePlan: basePlanArtifactHit, effectivePlan: false, review: false },
    routing, checkpoint: CHECKPOINT_META,
  }
}
const sameDecisions = decisionKey(DECIDED) === decisionKey(PRIOR_STATE?.decisionApply?.decisions)
const derivedEffectivePlan = applied.plan
const effectivePlanArtifactHit = !!(basePlanArtifactHit && sameDecisions && priorEffectivePlan
  && stableStringify(derivedEffectivePlan) === stableStringify(priorEffectivePlan))
const effectivePlan = effectivePlanArtifactHit ? priorEffectivePlan : derivedEffectivePlan
const architectureDecisionGate = applied.architect.length > 0
const architectureChoices = applied.architect.map(({ decision, option }) => ({
  decisionId: decision.id,
  selected: option.label,
  consequence: option.consequence,
}))
let reviewArtifactHit = false
const reviewInputCanonical = stableStringify({
  contract: CHECKPOINT_TEMPLATE_KIND,
  task: TASK,
  milestone: MILESTONE,
  effectivePlan,
  route: routing.route,
  routeScore: routing.score,
  uncertaintyScore: routing.uncertaintyScore,
  forcedEscalations: routing.forcedEscalations,
  reviewModel,
  architectureDecisionGate,
  architectureChoices,
})
const artifactCache = () => ({
  recon: reconArtifactHit,
  basePlan: basePlanArtifactHit,
  effectivePlan: effectivePlanArtifactHit,
  review: reviewArtifactHit,
})
const withPlanState = fields => ({
  ...fields,
  basePlan,
  effectivePlan,
  plan: effectivePlan,
  decisionApply: { decisions: DECIDED, invalid: [], unknown: [], architectureChoices },
  reviewInputCanonical,
  artifactCache: artifactCache(),
})
if (architectureDecisionGate) {
  needsReview = true
  implementationModel = MODEL_STRONG
  log(`架构决议强门:${applied.architect.length} 个 requiresArchitect 选择将强制 Review/强实现模型/Final Audit`)
}

// ---------- Plan Risk Gate（JS）：Recon 误判的第二次纠偏，升级粘滞 ----------
// Planner 亲自读码后若评估的风险高于 Recon 冻结的路由，不在当前 workflow 中途换模型
// （会破 resume/cache 确定性），而是早退并交回 nextArgs.minRoute。
// 主 agent 同 session 用 resumeFromRunId + 首轮 args 叠加 nextArgs 续跑：Recon 命中缓存，
// minRoute 兜底使 Recon 再判 LOW 也不回落（避免升级-回落死循环），仅 Plan 及之后重跑。
// 已跨 session 才开新 workflow（checkpoint），minRoute 同样兜底。
const plannedRank = ROUTE_RANK[effectivePlan.predictedImpact?.risk] ?? 0
if (plannedRank > ROUTE_RANK[routing.route]) {
  log(`⚠️ Plan Risk Gate：Planner 自评 ${effectivePlan.predictedImpact.risk} 高于 Recon 路由 ${routing.route}，早退升级（minRoute 粘滞）`)
  return withPlanState({
    status: 'route-escalation-required',
    from: routing.route,
    to: effectivePlan.predictedImpact.risk,
    nextArgs: { minRoute: effectivePlan.predictedImpact.risk },
    reason: 'Planner 亲自读码后评估的风险高于 Recon 预判。同 session 用 resumeFromRunId + 首轮 args 叠加 nextArgs 续跑（Recon 缓存命中，仅升级段重跑）；跨 session 才开新 workflow 并带上 minRoute。升级即粘滞，不会在 Recon 处回落',
    recon,
    routing,
    checkpoint: CHECKPOINT_META,
  })
}

const planDigest = [
  `根因：${effectivePlan.rootCause}`,
  `切片：\n${effectivePlan.slices.map(s => `- ${s.id ?? '?'} ${s.title}（${s.files.join(', ')}）— ${s.rationale}`).join('\n')}`,
  `whitelist：${effectivePlan.whitelist.join(', ')}`,
  `mustNotTouch：${effectivePlan.mustNotTouch.join(', ') || '（无）'}`,
  `测试命令：${effectivePlan.testCommands.join(' && ')}`,
  `预估影响：affected=${effectivePlan.predictedImpact.affectedSymbols} 符号 / ${effectivePlan.predictedImpact.affectedModules} 模块 / ${effectivePlan.predictedImpact.processes} 流程，自评 ${effectivePlan.predictedImpact.risk}`,
].join('\n\n')

// ================= Review：对抗式审阅（不是第二个 Planner） =================
let review = null
if (needsReview) {
  phase('Review')
  // Review artifact hit：只复用与当前 EffectivePlan 和完整审阅上下文完全相同的已批准结果。
  reviewArtifactHit = !!(effectivePlanArtifactHit && PRIOR_STATE?.reviewReusable === true
    && PRIOR_STATE?.review?.verdict === 'approve'
    && (TRUSTED_ARTIFACT_REUSE || priorValidation?.reviewStillValid === true)
    && PRIOR_STATE?.reviewInputCanonical === reviewInputCanonical
    && (!priorRoute || ROUTE_RANK[priorRoute] >= ROUTE_RANK[routing.route]))
  review = reviewArtifactHit
    ? PRIOR_STATE.review
    : await llmAgent(
    [
      '你是独立审阅者（GPT-5.6 Sol）。**你不是第二个 Planner，你的任务是反驳这份计划，不是附和。**',
      '',
      planDigest,
      '',
      '优先寻找（每条都要给证据）：',
      '- incorrect assumption / missing dependency / blast radius underestimation',
      '- lifecycle issue / concurrency issue / state migration issue',
      '- public API compatibility / rollback hole / missing tests / missing caller',
      '- GitNexus 与源码不一致 / whitelist 过窄 / mustNotTouch 错误',
      '',
      '证据必须是 file:line、GitNexus 结果、计划字段、测试证据中的至少一种。' +
      '不接受「这个方案可能存在风险」这类没有证据的意见 —— 那种一律不进 blockers。',
      '',
      `路由上下文：route=${routing.route}，uncertainty=${routing.uncertaintyScore}。不确定项越多，你越该倾向 revise/block。`,
      architectureDecisionGate
        ? `架构决议强门已启用。必须逐项复核这些用户选择及其后果：\n${architectureChoices.map(x => `- ${x.decisionId}=${x.selected}：${x.consequence}`).join('\n')}`
        : '',
    ].join('\n'),
    { label: 'review:plan', phase: 'Review', model: reviewModel, effort: 'high', schema: REVIEW_SCHEMA }
  )
  if (reviewArtifactHit) log('Review ARTIFACT HIT:EffectivePlan 与完整审阅上下文一致且历史审阅可复用')

  // fail-closed：该审却审不出结果（agent 未返回）→ 早退，不放行到后续阶段
  if (!review) {
    return withPlanState({ status: 'failed', at: 'Review', reason: 'review agent 未返回结构化结果（fail-closed，不进入实现）', routing, checkpoint: CHECKPOINT_META })
  }
  if (review.verdict === 'block') {
    return withPlanState({ status: 'blocked', at: 'Review', blockers: review.blockers, review, routing, checkpoint: CHECKPOINT_META })
  }
  // revise 不带病进 Implement：实现者被旧 whitelist 锁死，无法合法吸收 reviewer 发现的「whitelist 过窄」。
  // 早退交回意见，并把累计意见 + replanAttempt 作为 nextArgs 带回 —— 续跑时二者都拼进 Plan prompt
  // （prompt 进缓存键 → Plan 必重跑且必须产出修订计划），否则同输入重放同一份 Plan/Review，死循环。
  if (review?.verdict === 'revise') {
    const roundFeedback = review.blockers.map(b => `${b.issue}（${b.evidence}）`).concat(review.concerns)
    // fail-closed：revise 却不给任何修订意见 → 续跑只会原样重放同一 Plan/Review，直接 blocked 转人工
    if (!roundFeedback.length) {
      return withPlanState({
        status: 'blocked',
        at: 'Review',
        reason: 'Review 判 revise 但 blockers/concerns 均为空，无可吸收的修订意见（fail-closed，不进入无推进的 replan 循环）',
        review,
        routing,
        checkpoint: CHECKPOINT_META,
      })
    }
    const attempt = REPLAN_ATTEMPT + 1
    // 有界：超过上限仍 revise → 转人工，不再自动续跑
    if (attempt > MAX_REPLAN) {
      return withPlanState({
        status: 'blocked',
        at: 'Review',
        reason: `重规划已达上限 ${MAX_REPLAN} 次，Review 仍判 revise，转人工处理`,
        replanHistory: REPLAN_FEEDBACK ?? [],
        latestFeedback: roundFeedback,
        review,
        routing,
        checkpoint: CHECKPOINT_META,
      })
    }
    // 累计反馈 + attempt 都拼进下一轮 Plan prompt（prompt 进缓存键）：
    // 即使 Review 逐字重复同一意见，prompt 也每轮不同 → Plan 必重跑，杜绝无限重放
    // dirtyWorktree 只透传不新置：Review 在 Implement 之前，本轮未产生新污染，
    // 但若上轮 Advisor replan 留下的残留还在（DIRTY_WORKTREE=true），必须继续让 Planner 知情
    const replanFeedback = (REPLAN_FEEDBACK ?? []).concat(roundFeedback)
    log(`Review=revise：早退 replan-required（第 ${attempt}/${MAX_REPLAN} 次），累计反馈与 attempt 随 nextArgs 注入 Plan prompt，不进入实现`)
    return withPlanState({
      status: 'replan-required',
      milestone: MILESTONE,
      replanAttempt: attempt,
      reviewFeedback: replanFeedback,
      dirtyWorktree: DIRTY_WORKTREE,
      nextArgs: { replanFeedback, replanAttempt: attempt, dirtyWorktree: DIRTY_WORKTREE },
      reason: 'Review 判 revise。同 session 用 resumeFromRunId + 首轮 args 叠加 nextArgs 续跑：Recon 缓存命中，累计 replanFeedback 与 replanAttempt 改变 Plan prompt → Plan 及之后重跑并吸收修订意见；超过 maxReplan 次仍 revise 将 blocked 转人工。',
      review,
      routing,
      checkpoint: CHECKPOINT_META,
    })
  }
} else {
  log('路由 LOW 且 alwaysReview=false，跳过 Review（可在 args 传 alwaysReview:true 强制开启）')
}

// ================= Preflight：haiku 建测试基线（fail-closed） =================
phase('Preflight')
const pre = await llmAgent(
  [
    '你是环境与基线层。装依赖、建目录、跑一次基线测试，不改业务代码。',
    `基线命令：${effectivePlan.testCommands.join(' && ')}`,
    '把真实的测试数字与 typecheck 退出码填进 baseline。',
    '如实报告 —— 基线本来就红就写红，不要试图修好它（那是 Implement 层的事）。',
    K_FAIL_LOUD,
  ].join('\n'),
  { label: 'preflight', phase: 'Preflight', model: MODEL_PREFLIGHT, schema: PREFLIGHT_SCHEMA }
)

// fail-closed：agent 未返回也算失败，不放行（故障偏向质量）
if (!pre) return withPlanState({ status: 'failed', at: 'Preflight', reason: 'preflight agent 未返回', review, routing, checkpoint: CHECKPOINT_META })
if (!pre.ready) return withPlanState({ status: 'blocked', at: 'Preflight', blockers: pre.blockers, review, preflight: pre, routing, checkpoint: CHECKPOINT_META })

// ================= Implement：Kimi/Opus 主实现 + 有界 Fable Advisor Loop =================
phase('Implement')
// DECIDED 摘要只透传实现层(latestFeedback:字符串开放问题的答案由实现层现场裁决,不改 Plan;
// decisionPoints 已由 JS applyDecisions 应用进 effectivePlan)
const decidedDigest = Object.keys(DECIDED).length
  ? [
      '## 用户已拍板(仅约束实现层现场裁决;Plan 已由 DecisionApply 应用,不得回问)',
      ...Object.entries(DECIDED).map(([k, v]) => `- ${k}:${JSON.stringify(v)}`),
      (effectivePlan.openQuestionsForUser ?? []).length
        ? `未预编码开放问题(由你现场裁决并记录在 honesty):\n${effectivePlan.openQuestionsForUser.map(q => `- ${q}`).join('\n')}`
        : '',
    ].filter(Boolean).join('\n')
  : (effectivePlan.openQuestionsForUser ?? []).length
    ? `## 未预编码开放问题(由你现场裁决并记录在 honesty):\n${effectivePlan.openQuestionsForUser.map(q => `- ${q}`).join('\n')}`
    : ''
let impl = null
let advisorCalls = 0
const advisorHistory = []
// 首次 early-return 请求升级强实现模型时置 true（进遥测）。
// 不能用 escalatedToStrong 统计「请求升级」：那是【续跑生效后】的状态——首次 run
// calls>0 但 escalatedToStrong=false，续跑 escalatedToStrong=true 却可能 calls=0
// 被 advised=calls>0 过滤，两头都漏 → 升级统计系统性偏低。请求必须记在发出请求的首次 run 上。
let escalationRequested = false

const implementationAdvisorSummary = () => ({
  model: ADVISOR_MODEL,
  calls: advisorCalls,
  outcomes: advisorHistory,
  implementationModel,
  escalatedToStrong: IMPLEMENTATION_MODEL_OVERRIDE === MODEL_STRONG,
  escalationRequested,
})

for (let implementAttempt = 0; implementAttempt <= ADVISOR_MAX; implementAttempt++) {
  const advisorDigest = advisorHistory.length
    ? [
        '## 已获得的顾问裁决（必须先自己核对源码/git diff，再决定如何执行；顾问不是事实源）',
        ...advisorHistory.map((a, i) =>
          `- #${i + 1} ${a.verdict}: ${a.nextStep}\n  reasoning: ${a.reasoning}\n  evidence: ${a.evidence.join('；') || '（无）'}`
        ),
      ].join('\n')
    : ''

  impl = await llmAgent(
    [
      '你是实现层。按计划逐切片实现。',
      '',
      planDigest,
      '',
      decidedDigest,
      IMPLEMENTATION_ESCALATION_REASON
        ? `## 上轮实现升级原因\n${IMPLEMENTATION_ESCALATION_REASON}\n你已被升级为更强实现模型，先重新 Read 当前 workspace/git diff 再继续。`
        : '',
      advisorDigest,
      '',
      '## 顾问触发规则',
      '正常编译错误、类型错误、明确测试失败、格式问题必须自己解决，禁止滥用顾问。',
      '只有出现以下任一情况且你已亲自 Read/尝试取证后，才允许 done=false + needsAdvisor=true：',
      '- 合理修复后测试仍失败且根因不明确；',
      '- 实际代码与 Plan 的关键假设冲突，或正确实现需要越出 whitelist；',
      '- 新发现跨模块/public API/schema/concurrency/lifecycle/state machine/persistence/serialization 风险；',
      '- GitNexus 调用关系与 Planner 假设冲突；',
      '- 存在两个以上合理但风险明显不同的实现方案，需要独立裁决。',
      'needsAdvisor=true 时 advisorQuestion 必须具体，blockingEvidence 至少给出一条 file:line / 测试 / git diff / GitNexus 证据。',
      'done=true 时必须 needsAdvisor=false、advisorQuestion=""；不要为了“保险”调用顾问。',
      '',
      '硬规则：',
      '- 只允许修改 whitelist 内的文件；mustNotTouch 内的一律不动。越界即失败。',
      '- 每轮继续实现前先 Read 目标文件与当前 git diff，避免覆盖上一轮已落盘修改。',
      '- 改前先 Read 目标文件确认现状，改后再 Read 一次确认落盘符合预期。',
      '- 不要 commit、不要 push（提交层负责）。',
      '- 计划里有而你没做的，必须写进 notImplemented，不许假装做了。',
      K_FAIL_LOUD,
    ].filter(Boolean).join('\n'),
    {
      label: `implement:${implementAttempt}`,
      phase: 'Implement',
      model: implementationModel,
      effort: 'xhigh',
      schema: IMPLEMENT_SCHEMA,
    }
  )

  if (!impl) {
    return withPlanState({
      status: 'failed',
      at: 'Implement',
      reason: 'implement agent 未返回结构化结果',
      review,
      preflight: pre,
      routing,
      implementationAdvisor: implementationAdvisorSummary(),
      checkpoint: CHECKPOINT_META,
    })
  }
  if (impl.done) break

  if (!impl.needsAdvisor) {
    return withPlanState({
      status: 'escalate',
      at: 'Implement',
      reason: impl.notImplemented.join('；') || impl.honesty || '实现未完成且未请求顾问',
      notImplemented: impl.notImplemented,
      impl,
      review,
      preflight: pre,
      routing,
      implementationAdvisor: implementationAdvisorSummary(),
      checkpoint: CHECKPOINT_META,
    })
  }

  if (!impl.advisorQuestion || !impl.blockingEvidence.length) {
    return withPlanState({
      status: 'failed',
      at: 'ImplementAdvisor',
      reason: 'needsAdvisor=true 但缺少 advisorQuestion 或 blockingEvidence',
      impl,
      review,
      preflight: pre,
      routing,
      implementationAdvisor: implementationAdvisorSummary(),
      checkpoint: CHECKPOINT_META,
    })
  }

  if (advisorCalls >= ADVISOR_MAX) {
    if (implementationModel !== MODEL_STRONG) {
      escalationRequested = true
      return withPlanState({
        status: 'implementation-escalation-required',
        from: implementationModel,
        to: MODEL_STRONG,
        nextArgs: {
          implementationModelOverride: MODEL_STRONG,
          implementationEscalationReason:
            `Fable Advisor 已调用 ${advisorCalls}/${ADVISOR_MAX} 次仍未收敛。最后问题：${impl.advisorQuestion}`,
        },
        reason: '有界 Advisor Loop 已达上限；同 session 用原 scriptPath + resumeFromRunId + 首轮 args 叠加 nextArgs，仅 Implement 及后续因 model/prompt 改变而重跑。',
        impl,
        review,
        preflight: pre,
        routing,
        implementationAdvisor: implementationAdvisorSummary(),
        checkpoint: CHECKPOINT_META,
      })
    }
    return withPlanState({
      status: 'escalate',
      at: 'Implement',
      reason: `强实现模型 + ${ADVISOR_MAX} 次顾问仍无法收敛，转人工/用户拍板`,
      impl,
      review,
      preflight: pre,
      routing,
      implementationAdvisor: implementationAdvisorSummary(),
      checkpoint: CHECKPOINT_META,
    })
  }

  // ★ 必须在 agent() 调用前自增：失败/null 也计入上限，避免死循环
  advisorCalls++
  const advice = await llmAgent(
    [
      '你是 Implement Advisor（只读顾问），任务是给出裁决而不是接管代码。',
      `仓库根：${REPO}`,
      `当前实现模型：${implementationModel}`,
      `路由：${routing.route}`,
      '',
      decidedDigest,
      `实现者问题：${impl.advisorQuestion}`,
      `阻塞证据：\n${impl.blockingEvidence.map(x => `- ${x}`).join('\n')}`,
      `未完成项：\n${impl.notImplemented.map(x => `- ${x}`).join('\n') || '（无）'}`,
      `诚实声明：${impl.honesty}`,
      '',
      '你必须亲自 Read 相关文件；必要时查看 git diff、测试输出、GitNexus context/impact。',
      '禁止 Edit/Write，禁止用 Bash 改文件；你只提供分析、证据和下一步。',
      '不要因为实现者说“困难”就附和。若局部方案可继续，选 continue/change-approach；',
      '若 Plan 本身错误选 replan；需用户决策选 stop-and-ask；Kimi 已不适合继续时选 escalate-implementation。',
      'evidence 尽量给 file:line / git diff / 测试 / GitNexus 证据。',
    ].join('\n'),
    {
      label: `implement-advisor:${advisorCalls}`,
      phase: 'Review',
      model: ADVISOR_MODEL,
      effort: 'high',
      schema: IMPLEMENT_ADVISOR_SCHEMA,
      disallowedTools: ['Edit', 'Write'],
    }
  )

  if (!advice) {
    return withPlanState({
      status: 'failed',
      at: 'ImplementAdvisor',
      reason: 'advisor agent 未返回结构化结果（fail-closed）',
      impl,
      review,
      preflight: pre,
      routing,
      implementationAdvisor: implementationAdvisorSummary(),
      checkpoint: CHECKPOINT_META,
    })
  }

  advisorHistory.push({
    call: advisorCalls,
    verdict: advice.verdict,
    reasoning: advice.reasoning,
    nextStep: advice.nextStep,
    evidence: advice.evidence,
  })

  if (advice.verdict === 'stop-and-ask') {
    return withPlanState({
      status: 'need-decision',
      milestone: MILESTONE,
      questions: [advice.nextStep],
      impl,
      review,
      preflight: pre,
      routing,
      implementationAdvisor: implementationAdvisorSummary(),
      checkpoint: CHECKPOINT_META,
    })
  }

  if (advice.verdict === 'replan') {
    const replanAttempt = REPLAN_ATTEMPT + 1
    const advisorFeedback = [
      `Implement Advisor: ${advice.reasoning}`,
      `建议：${advice.nextStep}`,
      ...advice.evidence.map(x => `证据：${x}`),
    ]
    if (replanAttempt > MAX_REPLAN) {
      return withPlanState({
        status: 'blocked',
        at: 'ImplementAdvisor',
        reason: `重规划已达上限 ${MAX_REPLAN} 次，Implement Advisor 仍要求 replan，转人工`,
        impl,
        review,
        preflight: pre,
        routing,
        implementationAdvisor: implementationAdvisorSummary(),
        checkpoint: CHECKPOINT_META,
      })
    }
    const replanFeedback = (REPLAN_FEEDBACK ?? []).concat(advisorFeedback)
    // ⚠️ 与 Review=revise 的 replan 不同：本轮 Implement 已运行，工作区带着 provisional
    // implementation 的残留 diff。必须让下一轮 Planner 知情并逐块裁决 retain/replace，
    // 否则它会把旧方案残留误当现状基线，新旧实现混杂。
    return withPlanState({
      status: 'replan-required',
      milestone: MILESTONE,
      replanAttempt,
      reviewFeedback: replanFeedback,
      dirtyWorktree: true,
      nextArgs: { replanFeedback, replanAttempt, dirtyWorktree: true },
      reason: 'Implement Advisor 判断 Plan 本身需要修订；复用现有 replanFeedback/replanAttempt 机制，不创建第二套循环。本轮 Implement 已落盘部分实现，nextArgs.dirtyWorktree=true：下一轮 Planner 必须先审阅 git status/git diff，对残留 hunk 逐块决定 retain/replace，不得误当现状自动继承。',
      impl,
      review,
      preflight: pre,
      routing,
      implementationAdvisor: implementationAdvisorSummary(),
      checkpoint: CHECKPOINT_META,
    })
  }

  if (advice.verdict === 'escalate-implementation') {
    if (implementationModel !== MODEL_STRONG) {
      escalationRequested = true
      return withPlanState({
        status: 'implementation-escalation-required',
        from: implementationModel,
        to: MODEL_STRONG,
        nextArgs: {
          implementationModelOverride: MODEL_STRONG,
          implementationEscalationReason: `${advice.reasoning}\n下一步：${advice.nextStep}`,
        },
        reason: 'Advisor 判断当前实现模型不适合继续；只升级 Implement model，不把整个 route 改成 CRITICAL。',
        impl,
        review,
        preflight: pre,
        routing,
        implementationAdvisor: implementationAdvisorSummary(),
        checkpoint: CHECKPOINT_META,
      })
    }
    return withPlanState({
      status: 'escalate',
      at: 'Implement',
      reason: '当前已是强实现模型，Advisor 仍要求升级，转人工/用户拍板',
      impl,
      review,
      preflight: pre,
      routing,
      implementationAdvisor: implementationAdvisorSummary(),
      checkpoint: CHECKPOINT_META,
    })
  }

  // continue / change-approach：下一轮仍由原实现模型执行，并把 advisorHistory 注入 prompt
}

if (!impl?.done) {
  return withPlanState({
    status: 'escalate',
    at: 'Implement',
    reason: 'Implement Advisor Loop 结束但实现仍未完成',
    impl,
    review,
    preflight: pre,
    routing,
    implementationAdvisor: implementationAdvisorSummary(),
    checkpoint: CHECKPOINT_META,
  })
}

// ================= Verify：haiku 机械核对 + GitNexus 实测爆炸半径（只验证，不提交） =================
phase('Verify')
const verify = await llmAgent(
  [
    '你是独立验证层。不要相信上一层的自述，自己跑一遍。**只验证，绝不 commit**（提交统一由后续 Commit 层负责）。',
    `测试命令：${effectivePlan.testCommands.join(' && ')}`,
    pre ? `Preflight 基线：${pre.baseline.testPassed}/${pre.baseline.testTotal} 通过，typecheck exit=${pre.baseline.typecheckExit}` : '（无基线）',
    '低于基线视为回退，status 填 red。',
    '',
    '## GitNexus 实测爆炸半径（填 actualImpact）',
    `跑 detect_changes(scope=all, repo="${GNX}", worktree="${WORKTREE}")，统计实际影响的符号数 / 模块数 / 流程数；`,
    '对改动过的公共 symbol 重跑 context/impact。',
    '把【真实】数字填进 actualImpact，不要照抄预估。',
    '',
    '没有测试输出或退出码作证据，不得勾选任何 checkbox。',
    K_FAIL_LOUD,
  ].join('\n'),
  { label: 'verify', phase: 'Verify', model: MODEL_VERIFY, schema: VERIFY_SCHEMA }
)

// ---------- routeMiss：JS 对比预估 vs 实测（三维度，确定性，提交前计算） ----------
// 任一维度「实测明显超预估」（超 50% 且绝对值超 3）即 routeMiss。对所有等级生效——
// 这必须在 Commit 之前算，否则 LOW/MEDIUM 会先提交后才发现低估。
const significant = (actual, predicted) => actual > predicted * 1.5 && (actual - predicted) > 3
let routeMiss = false
let blastRadiusDelta = null
if (effectivePlan?.predictedImpact && verify?.actualImpact) {
  const p = effectivePlan.predictedImpact
  const a = verify.actualImpact
  blastRadiusDelta = {
    symbols: a.affectedSymbols - p.affectedSymbols,
    modules: a.affectedModules - p.affectedModules,
    processes: a.processes - p.processes,
  }
  routeMiss = significant(a.affectedSymbols, p.affectedSymbols)
    || significant(a.affectedModules, p.affectedModules)
    || significant(a.processes, p.processes)
  if (routeMiss) {
    const msg = `routeMiss：实测影响超预估（symbols +${blastRadiusDelta.symbols} / modules +${blastRadiusDelta.modules} / processes +${blastRadiusDelta.processes}）`
    log('⚠️ ' + msg)
    if (verify.scanFindings) verify.scanFindings.push(msg)
  }
}

// ================= Final Audit：CRITICAL、架构决议强门必跑；任意 route 出现 routeMiss 即触发 =================
// LOW 的 routeMiss 反而比 HIGH 更值得审计——它意味着前面的 Recon+Planner 都低估了爆炸范围。
const needsAudit = routing.route === 'CRITICAL' || routeMiss || architectureDecisionGate
let audit = null
if (needsAudit) {
  phase('Audit')
  audit = await llmAgent(
    [
      '你是最终审计者（GPT-5.6 Sol），独立于 Plan/Implement/Verify 之外做最后把关。',
      '',
      `路由：${routing.route}` + (routeMiss ? `，且出现 routeMiss（实测影响超预估）` : '') + (architectureDecisionGate ? '，且架构决议强门已启用' : ''),
      architectureDecisionGate
        ? `架构决议：\n${architectureChoices.map(x => `- ${x.decisionId}=${x.selected}：${x.consequence}`).join('\n')}`
        : '',
      `计划：\n${planDigest}`,
      `实现者自述：filesChanged=${(impl?.filesChanged ?? []).map(f => f.path).join(', ')}；notImplemented=${(impl?.notImplemented ?? []).join('；') || '无'}`,
      `验证结果：status=${verify?.status ?? '?'}，${verify?.testPassed ?? '?'}/${verify?.testTotal ?? '?'} 通过`,
      verify?.scanFindings?.length ? `scanFindings：\n${verify.scanFindings.map(s => `- ${s}`).join('\n')}` : '',
      '',
      '## 你必须亲自复核，不得只凭上面各层自述就 accept：',
      `1. 在 ${WORKTREE} 跑 git diff，查看本次实际变更；`,
      '2. Read 所有 changed files 的关键修改区；',
      '3. 对公共接口/关键 symbol 重新检查 caller；',
      `4. routeMiss 时，对受影响 symbol 重跑 GitNexus impact/context（repo=${GNX}, worktree=${WORKTREE}）；`,
      '5. 每条 finding 必须引用实际 file:line / diff / GitNexus evidence。',
      '未完成上述检查不得 verdict=accept。',
      '',
      '重点审计：routeMiss 暴露的低估、未验证假设、跨模块副作用、回滚完整性。',
      'verdict=accept / needs-rework / escalate-to-human。非 accept 将阻止提交。',
    ].filter(Boolean).join('\n'),
    { label: 'final-audit', phase: 'Audit', model: reviewModel, effort: 'high', schema: AUDIT_SCHEMA }
  )
}

// ================= Commit Gate（JS）→ Commit（所有等级统一在此提交） =================
// 需要审计但 audit 缺失 → fail-closed 早退，绝不提交
if (needsAudit && !audit) {
  return withPlanState({
    status: 'failed', at: 'Audit', reason: '需要 Final Audit 但 audit agent 未返回结构化结果（fail-closed，不提交）',
    review, preflight: pre, impl, implementationAdvisor: implementationAdvisorSummary(), verify, routing, checkpoint: CHECKPOINT_META,
  })
}
// 最终 status 必须吸收 audit verdict：needsAudit 时必须 audit=accept 才放行
const auditBlocks = needsAudit && audit.verdict !== 'accept'
const commitExpected = REQUIRE_COMMIT && verify?.status === 'green' && !auditBlocks
let commitResult = null
if (commitExpected) {
  phase('Commit')
  commitResult = await llmAgent(
    [
      '你是提交层。验证已全绿、审计已通过，现在提交。',
      `${K_GIT_SAFE}`,
      `commit message 引用 ${MILESTONE}。只提交本次切片，不 push。`,
      '把 commit hash 填进 commits，committed 置 true。',
      K_FAIL_LOUD,
    ].join('\n'),
    { label: 'commit', phase: 'Commit', model: MODEL_COMMIT, schema: COMMIT_SCHEMA }
  )
} else if (REQUIRE_COMMIT) {
  log(`Commit Gate 拦截：verify=${verify?.status ?? '?'}，audit=${audit?.verdict ?? '（无）'} → 不提交`)
}
const commitSucceeded = commitResult?.committed === true && (commitResult?.commits?.length ?? 0) > 0

const commits = commitResult?.commits ?? []

// 最终 status：audit 否决优先；该提交却没提交成 → commit-failed；否则 verify
const finalStatus =
  audit?.verdict === 'needs-rework' ? 'needs-rework'
    : audit?.verdict === 'escalate-to-human' ? 'escalate-to-human'
    : (commitExpected && !commitSucceeded) ? 'commit-failed'
    : (verify?.status ?? 'unknown')

// ================= 返回（含路由遥测，进入 harvest 固化的 result） =================
return {
  status: finalStatus,
  milestone: MILESTONE,
  ts: TS,
  checkpoint: CHECKPOINT_META,
  basePlan,
  effectivePlan,
  plan: effectivePlan,
  decisionApply: { decisions: DECIDED, invalid: [], unknown: [], architectureChoices },
  reviewInputCanonical,
  artifactCache: artifactCache(),
  review,
  preflight: pre,
  impl,
  implementationAdvisor: implementationAdvisorSummary(),
  verify,
  audit,
  commitResult,
  commits,
  // 路由遥测：进 workflow result，由 harvest-workflow 固化进 docs/ultracode/raw，scan-corpus 聚合
  routing: {
    score: routing.score,
    failsafe: routing.failsafe ?? false,
    route: routing.route,
    minRoute: MIN_ROUTE,
    plannerModel,
    implementationModel,
    reviewModel: needsReview ? reviewModel : null,
    architectureDecisionGate,
    architectureChoices,
    reasons: routing.reasons,
    forcedEscalations: routing.forcedEscalations,
    uncertaintyScore: routing.uncertaintyScore,
    planRiskGate: { planned: effectivePlan?.predictedImpact?.risk ?? null, passed: true },
    predictedImpact: effectivePlan?.predictedImpact ?? null,
    actualImpact: verify?.actualImpact ?? null,
    blastRadiusDelta,
    routeMiss,
  },
  broadcast: `[${MILESTONE}] route=${routing.route} score=${routing.score ?? 'failsafe'} · ${finalStatus} · ${verify?.testPassed ?? '?'}/${verify?.testTotal ?? '?'} 测试 · ${commits.length} 提交` + (routeMiss ? ' · ⚠️routeMiss' : ''),
}
