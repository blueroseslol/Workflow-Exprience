// gitnexus-routed.js — GitNexus 驱动的动态模型路由模板（实验性）
//
// 架构（修正版控制流，v3：所有等级统一拆开 Verify/Commit，routeMiss 一律在提交前计算）：
//   Recon(haiku 建证据地图)
//     → JS 纯函数 computeRouting() 算 ComplexityScore（含 minRoute 下限）
//     → Plan(路由派生模型，亲自重读代码，输出 predictedImpact.risk)
//     → Plan Risk Gate(JS：Planner 自评风险高于路由 → 早退 route-escalation-required，带 nextArgs.minRoute)
//     → Review(fable 对抗；revise/block → 早退 replan-required，不带病实现)
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
//   - minRoute：Plan Risk Gate 升级带 nextArgs.minRoute，新 workflow 以此兜底，避免升级-回落死循环
//   - Preflight fail-closed：agent 未返回(null) 也算失败，不再静默放行
//   - Commit 失败不落 green：commitExpected 而未成功 → status=commit-failed
//   - fail-safe 不再编造 score=75（落在 CRITICAL 区间却标 HIGH，污染统计），改为 score=null + failsafe
//   - Final Audit 强制亲自 git diff / Read 变更 / 复查 caller，不得只摘要转述
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
    // 预估爆炸半径 + Planner 亲自读码后的风险自评；risk 供 Plan Risk Gate 与 Recon 路由二次纠偏
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

// ---------- 路由：纯 JS 确定性计算（不进 agent、不耗 token、resume-safe） ----------
const ROUTE_ORDER = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
const ROUTE_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 }
const maxRoute = (a, b) => ROUTE_ORDER[Math.max(ROUTE_ORDER.indexOf(a), ROUTE_ORDER.indexOf(b))]

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

// ---------- 路由计算（JS，确定性，一次冻结本轮） ----------
const routing = computeRouting(recon)
log(`路由：score=${routing.score ?? 'failsafe'} → ${routing.route}` + (routing.forcedEscalations.length ? `（强制升级：${routing.forcedEscalations.join('；')}）` : ''))

// 模型链由路由派生
const plannerModel = (routing.route === 'HIGH' || routing.route === 'CRITICAL') ? MODEL_STRONG : MODEL_DEFAULT
const implementationModel = routing.route === 'CRITICAL' ? MODEL_STRONG : MODEL_DEFAULT
const reviewModel = MODEL_REVIEW
const needsReview = ALWAYS_REVIEW || routing.route !== 'LOW'
const isHighRisk = routing.route === 'HIGH' || routing.route === 'CRITICAL'

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
    `你是 ${MILESTONE} 的规划者（Recon 路由等级 ${routing.route}）。只规划，不改代码，不 commit。`,
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
    '## 预估爆炸半径 + 风险自评（填 predictedImpact）',
    '基于你的阅读，预估本次改动会影响的 affectedSymbols / affectedModules / processes，并给出你亲自读码后的风险评级 risk。',
    '**如果你读码后认为实际风险高于 Recon 给的路由等级，如实填更高的 risk —— 这会触发 Plan Risk Gate 升级，不会被忽略。**',
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

// ---------- Plan Risk Gate（JS）：Recon 误判的第二次纠偏，升级粘滞 ----------
// Planner 亲自读码后若评估的风险高于 Recon 冻结的路由，不在当前 workflow 中途换模型
// （会破 resume/cache 确定性），而是早退并交回 nextArgs.minRoute，按「一个决议一个 workflow」开新 workflow。
// 新 workflow 带 minRoute=<更高等级> 重跑，Recon 再判 LOW 也会被 minRoute 兜底，不会回落死循环。
const plannedRank = ROUTE_RANK[plan.predictedImpact?.risk] ?? 0
if (plannedRank > ROUTE_RANK[routing.route]) {
  log(`⚠️ Plan Risk Gate：Planner 自评 ${plan.predictedImpact.risk} 高于 Recon 路由 ${routing.route}，早退升级（minRoute 粘滞）`)
  return {
    status: 'route-escalation-required',
    from: routing.route,
    to: plan.predictedImpact.risk,
    nextArgs: { minRoute: plan.predictedImpact.risk },
    reason: 'Planner 亲自读码后评估的风险高于 Recon 预判；请带 nextArgs.minRoute 重开一个 workflow，升级即粘滞，不会在 Recon 处回落',
    recon,
    plan,
    routing,
  }
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
  // revise 不带病进 Implement：实现者被旧 whitelist 锁死，无法合法吸收 reviewer 发现的「whitelist 过窄」。
  // 早退交回意见，让规划层（或用户）修订计划后再跑。
  if (review?.verdict === 'revise') {
    log('Review=revise：早退 replan-required，不进入实现')
    return {
      status: 'replan-required',
      milestone: MILESTONE,
      reviewFeedback: review.blockers.map(b => `${b.issue}（${b.evidence}）`).concat(review.concerns),
      plan,
      routing,
    }
  }
} else {
  log('路由 LOW 且 alwaysReview=false，跳过 Review（可在 args 传 alwaysReview:true 强制开启）')
}

// ================= Preflight：haiku 建测试基线（fail-closed） =================
phase('Preflight')
const pre = await agent(
  [
    '你是环境与基线层。装依赖、建目录、跑一次基线测试，不改业务代码。',
    `基线命令：${plan.testCommands.join(' && ')}`,
    '把真实的测试数字与 typecheck 退出码填进 baseline。',
    '如实报告 —— 基线本来就红就写红，不要试图修好它（那是 Implement 层的事）。',
    K_FAIL_LOUD,
  ].join('\n'),
  { label: 'preflight', phase: 'Preflight', model: MODEL_VERIFY, schema: PREFLIGHT_SCHEMA }
)

// fail-closed：agent 未返回也算失败，不放行（故障偏向质量）
if (!pre) return { status: 'failed', at: 'Preflight', reason: 'preflight agent 未返回', routing }
if (!pre.ready) return { status: 'blocked', at: 'Preflight', blockers: pre.blockers, routing }

// ================= Implement =================
phase('Implement')
const impl = await agent(
  [
    '你是实现层。按计划逐切片实现。',
    '',
    planDigest,
    '',
    '硬规则：',
    '- 只允许修改 whitelist 内的文件；mustNotTouch 内的一律不动。越界即失败。',
    '- 改前先 Read 目标文件确认现状，改后再 Read 一次确认落盘符合预期。',
    '- 不要 commit、不要 push（提交层负责）。',
    '- 计划里有而你没做的，必须写进 notImplemented，不许假装做了。',
    K_FAIL_LOUD,
  ].join('\n'),
  { label: 'implement', phase: 'Implement', model: implementationModel, effort: 'xhigh', schema: IMPLEMENT_SCHEMA }
)

// ---------- Implement gate：未完成就早退，不进入验证 ----------
if (!impl || !impl.done) {
  log('Implement 未完成，早退 escalate（不进入 Verify，避免「没实现完但旧测试全绿被提交」）')
  return {
    status: 'escalate',
    at: 'Implement',
    reason: impl ? (impl.notImplemented.join('；') || impl.honesty || '实现未标记完成') : 'implement agent 未返回',
    notImplemented: impl?.notImplemented ?? [],
    plan,
    routing,
  }
}

// ================= Verify：haiku 机械核对 + GitNexus 实测爆炸半径（只验证，不提交） =================
phase('Verify')
const verify = await agent(
  [
    '你是独立验证层。不要相信上一层的自述，自己跑一遍。**只验证，绝不 commit**（提交统一由后续 Commit 层负责）。',
    `测试命令：${plan.testCommands.join(' && ')}`,
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
if (plan?.predictedImpact && verify?.actualImpact) {
  const p = plan.predictedImpact
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

// ================= Final Audit：CRITICAL 必跑；任意 route 出现 routeMiss 即触发 =================
// LOW 的 routeMiss 反而比 HIGH 更值得审计——它意味着前面的 Recon+Planner 都低估了爆炸范围。
const needsAudit = routing.route === 'CRITICAL' || routeMiss
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
// 最终 status 必须吸收 audit verdict：audit 非 accept 就不提交。
const auditBlocks = audit && audit.verdict !== 'accept'
const commitExpected = REQUIRE_COMMIT && verify?.status === 'green' && !auditBlocks
let commitResult = null
if (commitExpected) {
  phase('Commit')
  commitResult = await agent(
    [
      '你是提交层。验证已全绿、审计已通过，现在提交。',
      `${K_GIT_SAFE}`,
      `commit message 引用 ${MILESTONE}。只提交本次切片，不 push。`,
      '把 commit hash 填进 commits，committed 置 true。',
      K_FAIL_LOUD,
    ].join('\n'),
    { label: 'commit', phase: 'Commit', model: MODEL_VERIFY, schema: COMMIT_SCHEMA }
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
  plan,
  review,
  preflight: pre,
  impl,
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
    reasons: routing.reasons,
    forcedEscalations: routing.forcedEscalations,
    uncertaintyScore: routing.uncertaintyScore,
    planRiskGate: { planned: plan?.predictedImpact?.risk ?? null, passed: true },
    predictedImpact: plan?.predictedImpact ?? null,
    actualImpact: verify?.actualImpact ?? null,
    blastRadiusDelta,
    routeMiss,
  },
  broadcast: `[${MILESTONE}] route=${routing.route} score=${routing.score ?? 'failsafe'} · ${finalStatus} · ${verify?.testPassed ?? '?'}/${verify?.testTotal ?? '?'} 测试 · ${commits.length} 提交` + (routeMiss ? ' · ⚠️routeMiss' : ''),
}
