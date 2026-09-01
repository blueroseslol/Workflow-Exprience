// gitnexus-routed.js — GitNexus 驱动的动态模型路由模板（实验性）
//
// 架构：
//   Recon(haiku 建 Repo Evidence Map)
//     → JS 纯函数计算 ComplexityScore（LLM 不参与评分）
//     → 路由 LOW / MEDIUM / HIGH / CRITICAL
//     → 派生模型链 → (可选)对抗 Review → Implement → Verify(GitNexus 预估vs实测)
//     → routeMiss / CRITICAL 触发 Sol Final Audit
//
// 定位：与 four-phase.js（稳定 baseline）并存的【实验模板】。
// 用 corpus 数据证明它降低 killed / failed / 返工之前，不替换默认模板。
// 路由依据、阈值含义、遥测字段见 skills/workflow-experience/references/dynamic-routing.md
//
// 用法：复制本文件，替换 CONFIG 段 <占位>，通过 Workflow({script}) 或 scriptPath 运行。
// 沙箱禁 import/require、禁 Date.now()/Math.random() —— 本模板的路由计算是纯函数，resume-safe。

export const meta = {
  name: '<kebab-case-name>',
  description: '<一句话，会显示在权限对话框>；GitNexus 动态路由',
  phases: [
    { title: 'Recon', model: 'haiku' },
    // Plan / Review / Implement / Audit 的模型由路由在运行时派生，meta 是纯字面量无法声明，故不写 model
    { title: 'Plan' },
    { title: 'Review' },
    { title: 'Implement' },
    { title: 'Verify', model: 'haiku' },
    { title: 'Audit' },
  ],
}

// ---------- CONFIG（改这里） ----------
const REPO = args?.repo ?? '<D:/path/to/repo>'
const GNX = args?.gitnexusRepo ?? '<indexed-repo-name>'   // list_repos 里的准确名，目录名 ≠ repo 名
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

// 路由阈值（args 可调，不写成魔法常量；未来应据 corpus 校准，见 dynamic-routing.md）
const ROUTE_LOW_MAX = args?.routeLowMax ?? 24
const ROUTE_MEDIUM_MAX = args?.routeMediumMax ?? 49
const ROUTE_HIGH_MAX = args?.routeHighMax ?? 74

// LOW 是否也强制过 Review（默认 false = 跳过省 token；true = 全量过）
const ALWAYS_REVIEW = args?.alwaysReview ?? false

// 用户已拍板（不得当成 blocker 再问）
const DECIDED = args?.decisions ?? {}

// ---------- 复用常量 ----------
const S_STR_ARR = { type: 'array', items: { type: 'string' } }
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
        depth1: { type: 'number' },
        depth2: { type: 'number' },
        depth3: { type: 'number' },
        affectedSymbols: { type: 'number' },
      },
    },
    executionFlows: { type: 'number', description: '入口 symbol 参与的 execution flow / process 数' },
    modules: {
      type: 'object',
      additionalProperties: false,
      required: ['count', 'crossModule', 'crossRepo'],
      properties: {
        count: { type: 'number', description: '预计触碰的文件数' },
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
        consumerCount: { type: 'number' },
        shapeMismatchCount: { type: 'number', description: 'shape_check 报告的 mismatch 数' },
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

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'rootCause', 'slices', 'whitelist', 'mustNotTouch', 'testCommands', 'predictedImpact', 'openQuestionsForUser'],
  properties: {
    verdict: { type: 'string', enum: ['implementable', 'blocked'] },
    rootCause: { type: 'string', description: '根因，必须含【亲自】Read 到的 file:line' },
    slices: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'files', 'rationale'],
        properties: {
          title: { type: 'string' },
          files: S_STR_ARR,
          rationale: { type: 'string', description: '含亲自 Read 到的 file:line' },
        },
      },
    },
    whitelist: S_STR_ARR,
    mustNotTouch: S_STR_ARR,
    testCommands: S_STR_ARR,
    // 预估爆炸半径：Verify 阶段拿它与 detect_changes 实测对比，算 routeMiss
    predictedImpact: {
      type: 'object',
      additionalProperties: false,
      required: ['affectedSymbols', 'affectedModules', 'processes', 'risk'],
      properties: {
        affectedSymbols: { type: 'number' },
        affectedModules: { type: 'number' },
        processes: { type: 'number' },
        risk: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
      },
    },
    rollback: { type: 'string' },
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

// 取证型 + GitNexus 实测爆炸半径（actualImpact）
const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'vitestTail', 'testTotal', 'testPassed', 'testFailed', 'typecheckSrcExit', 'scanFindings', 'actualImpact', 'commits'],
  properties: {
    status: { type: 'string', enum: ['green', 'red'] },
    vitestTail: { type: 'string', description: '测试真实尾部输出，原样粘贴' },
    testTotal: { type: 'number' },
    testPassed: { type: 'number' },
    testFailed: { type: 'number' },
    typecheckSrcExit: { type: 'number' },
    scanFindings: S_STR_ARR,
    // 实现完成后用 GitNexus detect_changes / impact 实测的爆炸半径
    actualImpact: {
      type: 'object',
      additionalProperties: false,
      required: ['affectedSymbols', 'affectedModules', 'processes'],
      properties: {
        affectedSymbols: { type: 'number', description: 'detect_changes 实际影响的符号数' },
        affectedModules: { type: 'number' },
        processes: { type: 'number' },
      },
    },
    commits: S_STR_ARR,
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

// ---------- 路由：纯 JS 确定性计算（不进 agent、不耗 token、resume-safe） ----------
const ROUTE_ORDER = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
const maxRoute = (a, b) => ROUTE_ORDER[Math.max(ROUTE_ORDER.indexOf(a), ROUTE_ORDER.indexOf(b))]

function computeRouting(recon) {
  // Fail-safe：Recon 挂了绝不能当 LOW。偏向质量而非便宜 —— 按 HIGH 走，Planner 全程自侦察。
  if (!recon) {
    return {
      score: 75,
      breakdown: { failsafe: 75 },
      route: 'HIGH',
      forcedEscalations: ['recon-null → HIGH (fail-safe)'],
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
const recon = await agent(
  [
    '你是 Recon 侦察兵（只读）。你的职责是建立 Repo Evidence Map，**不是**制定实现方案，**更不是**决定难度等级。',
    '',
    `任务：${TASK}`,
    `仓库根：${REPO}`,
    '',
    '## 必须执行的 GitNexus 侦察（按序）',
    `1. list_repos 确认 repo 名（目录名 ≠ repo 名），绑定到「${GNX}」。`,
    '2. 检查索引时间戳：落后于工作区就把 uncertainty.indexStale 置 true。',
    '3. query 找相关 execution flows，统计数量填 executionFlows。',
    '4. 对主要入口 symbol 跑 context，拿调用面，填 entrySymbols。',
    '5. 对预计修改的公共 symbol 跑 impact(direction=upstream, maxDepth=3)，把 depth1/depth2/depth3/affectedSymbols 填进 impact。',
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

// ---------- 路由计算（JS，确定性，一次冻结本轮） ----------
const routing = computeRouting(recon)
log(`路由：score=${routing.score} → ${routing.route}` + (routing.forcedEscalations.length ? `（强制升级：${routing.forcedEscalations.join('；')}）` : ''))

// 模型链由路由派生
const plannerModel = (routing.route === 'HIGH' || routing.route === 'CRITICAL') ? MODEL_STRONG : MODEL_DEFAULT
const implementationModel = routing.route === 'CRITICAL' ? MODEL_STRONG : MODEL_DEFAULT
const reviewModel = MODEL_REVIEW
const needsReview = ALWAYS_REVIEW || routing.route !== 'LOW'

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

const plan = await agent(
  [
    `你是 ${MILESTONE} 的规划者（路由等级 ${routing.route}）。只规划，不改代码，不 commit。`,
    '',
    `任务：${TASK}`,
    `仓库根：${REPO}`,
    TASKS_DOC ? `里程碑文档：${TASKS_DOC} 中 ${MILESTONE} 原文及冻结条款` : '',
    '',
    reconDigest,
    '',
    '## 重读纪律（关键）',
    'Recon 只是导航器。**你必须亲自重新 Read**：修改入口、关键 caller、关键 callee、public interface、tests、lifecycle/state ownership 代码。',
    K_FILE_LINE,
    '不得写「根据 Recon 的描述……」作为唯一证据。你的最终结论必须引用【你亲自 Read 到】的 file:line。',
    '',
    '## 预估爆炸半径（填 predictedImpact，供 Verify 对比实测）',
    '基于你的阅读，预估本次改动会影响的 affectedSymbols / affectedModules / processes 数量与你的风险评级 risk。',
    '',
    '用户已拍板（不得回问）：',
    ...Object.entries(DECIDED).map(([k, v]) => `- ${k}：${JSON.stringify(v)}`),
    '',
    '硬规则：whitelist 精确到文件，凡不在 whitelist 的都进 mustNotTouch；无法自行决定的写进 openQuestionsForUser，不要自作主张。',
  ].filter(Boolean).join('\n'),
  { label: 'plan', phase: 'Plan', model: plannerModel, effort: 'high', schema: PLAN_SCHEMA }
)

if (!plan) return { status: 'failed', at: 'Plan', routing }
if (plan.verdict === 'blocked') return { status: 'blocked', reason: plan.rootCause, questions: plan.openQuestionsForUser, routing }
if (plan.openQuestionsForUser.length) {
  return { status: 'need-decision', milestone: MILESTONE, questions: plan.openQuestionsForUser, plan, routing }
}

const planDigest = [
  `根因：${plan.rootCause}`,
  `切片：\n${plan.slices.map(s => `- ${s.title}（${s.files.join(', ')}）— ${s.rationale}`).join('\n')}`,
  `whitelist：${plan.whitelist.join(', ')}`,
  `mustNotTouch：${plan.mustNotTouch.join(', ') || '（无）'}`,
  `测试命令：${plan.testCommands.join(' && ')}`,
  `预估影响：affected=${plan.predictedImpact.affectedSymbols} 符号 / ${plan.predictedImpact.affectedModules} 模块 / ${plan.predictedImpact.processes} 流程，自评 ${plan.predictedImpact.risk}`,
].join('\n\n')

// ================= Review：对抗式审阅（不是第二个 Planner） =================
let review = null
if (needsReview) {
  phase('Review')
  review = await agent(
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
    ].join('\n'),
    { label: 'review:plan', phase: 'Review', model: reviewModel, effort: 'high', schema: REVIEW_SCHEMA }
  )

  if (review?.verdict === 'block') {
    return { status: 'blocked', at: 'Review', blockers: review.blockers, plan, routing }
  }
  if (review?.verdict === 'revise') log('Review=revise：实现阶段必须吸收 blockers/concerns')
} else {
  log('路由 LOW 且 alwaysReview=false，跳过 Review（可在 args 传 alwaysReview:true 强制开启）')
}

// ================= Implement =================
phase('Implement')
const impl = await agent(
  [
    '你是实现层。按计划逐切片实现。',
    '',
    planDigest,
    review && review.verdict === 'revise' ? `Review 要求吸收：\n${review.blockers.map(b => `- ${b.issue}（${b.evidence}）`).join('\n')}\n${review.concerns.join('\n')}` : '',
    '',
    '硬规则：',
    '- 只允许修改 whitelist 内的文件；mustNotTouch 内的一律不动。越界即失败。',
    '- 改前先 Read 目标文件确认现状，改后再 Read 一次确认落盘符合预期。',
    '- 不要 commit、不要 push（Verify 层负责）。',
    '- 计划里有而你没做的，必须写进 notImplemented，不许假装做了。',
    K_FAIL_LOUD,
  ].filter(Boolean).join('\n'),
  { label: 'implement', phase: 'Implement', model: implementationModel, effort: 'xhigh', schema: IMPLEMENT_SCHEMA }
)

// ================= Verify：haiku 机械核对 + GitNexus 实测爆炸半径 =================
phase('Verify')
const verify = await agent(
  [
    '你是独立验证 + 提交层。不要相信上一层的自述，自己跑一遍。',
    `测试命令：${plan.testCommands.join(' && ')}`,
    '低于计划声称的基线视为回退，status 填 red。',
    '',
    '## GitNexus 实测爆炸半径（填 actualImpact）',
    `跑 detect_changes(scope=all)，repo=${GNX}，统计实际影响的符号数 / 模块数 / 流程数；`,
    '对改动过的公共 symbol 重跑 context/impact。',
    '把【真实】数字填进 actualImpact，不要照抄预估。',
    '',
    `全绿后提交：${K_GIT_SAFE}`,
    `commit message 引用 ${MILESTONE}。没有测试输出或退出码作证据，不得勾选任何 checkbox。`,
    K_FAIL_LOUD,
  ].join('\n'),
  { label: 'verify', phase: 'Verify', model: MODEL_VERIFY, schema: VERIFY_SCHEMA }
)

// ---------- routeMiss：JS 对比预估 vs 实测（确定性） ----------
let routeMiss = false
let blastRadiusDelta = null
if (plan?.predictedImpact && verify?.actualImpact) {
  blastRadiusDelta = verify.actualImpact.affectedSymbols - plan.predictedImpact.affectedSymbols
  // 实测明显超出预估：超 50% 且绝对值超 3 → routeMiss
  routeMiss = blastRadiusDelta > 3 && verify.actualImpact.affectedSymbols > plan.predictedImpact.affectedSymbols * 1.5
  if (routeMiss) {
    const msg = `routeMiss：实测影响 ${verify.actualImpact.affectedSymbols} 符号，超出预估 ${plan.predictedImpact.affectedSymbols}（delta +${blastRadiusDelta}）`
    log('⚠️ ' + msg)
    if (verify.scanFindings) verify.scanFindings.push(msg)
  }
}

// ================= Final Audit：CRITICAL 必跑；HIGH + routeMiss 触发 =================
const needsAudit = routing.route === 'CRITICAL' || (routeMiss && (routing.route === 'HIGH' || routing.route === 'CRITICAL'))
let audit = null
if (needsAudit) {
  phase('Audit')
  audit = await agent(
    [
      '你是最终审计者（GPT-5.6 Sol），独立于 Plan/Implement/Verify 之外做最后把关。',
      '',
      `路由：${routing.route}` + (routeMiss ? `，且出现 routeMiss（实测影响超预估）` : ''),
      `计划：\n${planDigest}`,
      `实现者自述：filesChanged=${(impl?.filesChanged ?? []).map(f => f.path).join(', ')}；notImplemented=${(impl?.notImplemented ?? []).join('；') || '无'}`,
      `验证结果：status=${verify?.status ?? '?'}，${verify?.testPassed ?? '?'}/${verify?.testTotal ?? '?'} 通过，commits=${(verify?.commits ?? []).length}`,
      verify?.scanFindings?.length ? `scanFindings：\n${verify.scanFindings.map(s => `- ${s}`).join('\n')}` : '',
      '',
      '重点审计：routeMiss 暴露的低估、未验证假设、跨模块副作用、回滚完整性。每条 finding 给 evidence。',
      'verdict=accept / needs-rework / escalate-to-human。',
    ].filter(Boolean).join('\n'),
    { label: 'final-audit', phase: 'Audit', model: reviewModel, effort: 'high', schema: AUDIT_SCHEMA }
  )
}

// ================= 返回（含路由遥测，进入 harvest 固化的 result） =================
return {
  status: verify?.status ?? 'unknown',
  milestone: MILESTONE,
  ts: TS,
  plan,
  review,
  impl,
  verify,
  audit,
  // 路由遥测：进 workflow result，由 harvest-workflow 固化进 docs/ultracode/raw，scan-corpus 聚合
  routing: {
    score: routing.score,
    route: routing.route,
    plannerModel,
    implementationModel,
    reviewModel: needsReview ? reviewModel : null,
    reasons: routing.reasons,
    forcedEscalations: routing.forcedEscalations,
    uncertaintyScore: routing.uncertaintyScore,
    predictedImpact: plan?.predictedImpact ?? null,
    actualImpact: verify?.actualImpact ?? null,
    blastRadiusDelta,
    routeMiss,
  },
  broadcast: `[${MILESTONE}] route=${routing.route} score=${routing.score} · ${verify?.status ?? '?'} · ${verify?.testPassed ?? '?'}/${verify?.testTotal ?? '?'} 测试` + (routeMiss ? ' · ⚠️routeMiss' : ''),
}
