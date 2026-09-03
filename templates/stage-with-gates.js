// 拍板边界模板：一个决议一个 workflow（用户 2026-09-01 拍板 Q6=B）
//
// 为什么不是「整个 Stage 一个 workflow 靠 resume 续跑」：
//   1. resume 是 same-session only —— 等人拍板往往跨会话，届时 journal 读不到会「静默全量重跑」
//   2. 7 里程碑 × 3-4 agent = 21-28，越过 25 agent 警告线
//   3. resume 要求脚本一字节不改
// 详见 references/resume-and-args.md
//
// 用法：
//   1) 首跑不带 decisions，脚本在拍板点早退，返回 need-decision
//   2) 主 agent 用 AskUserQuestion 问用户（脚本内无交互 API）
//   3) 把答复抄进下面的 COMMON.decided，另存为下一个里程碑的脚本再跑

export const meta = {
  name: '<stage>-<milestone>',
  description: '<里程碑一句话>；遇拍板点早退等用户',
  phases: [
    { title: 'Plan', model: 'opus' },
    { title: 'Review', model: 'fable' },
    { title: 'Implement', model: 'sonnet' },
    { title: 'Verify', model: 'haiku' },
  ],
}

function llmAgent(prompt, opts = {}) {
  return agent(prompt, {
    ...opts,
    disallowedTools: [...new Set([...(opts.disallowedTools ?? []), 'SendMessage', 'ListAgents'])],
  })
}

// ---------- COMMON：上一轮的拍板结论抄到这里 ----------
const COMMON = {
  repo: '<D:/path/to/repo>',
  tasks: '<D:/path/to/repo/openspec/changes/xxx/tasks.md>',
  milestone: '<5.4>',

  // 已拍板：写死在脚本里，不再问。每条注明来源（谁、何时定的）
  decided: [
    // '开 y3 生产 lanes（用户 2026-08-31 拍板）',
    // '白名单扩到 adapter + @ldl/auto-rig（用户 2026-08-31 拍板）',
  ],

  // 本里程碑不得触碰的边界
  mustNotTouch: [
    // '<repo>/backend/openspec/changes/*/specs/**（spec 冻结）',
  ],

  // 允许勾选的 checkbox；其余保持原状
  tickAllowed: ['<5.4>'],
}

// 运行期注入：主 agent 在得到用户答复后带进来
const DECISIONS = args?.decisions ?? {}
const TS = args?.ts ?? 'unknown-ts'
const ADVISOR_MODEL = args?.advisorModel ?? 'fable'

const S_STR_ARR = { type: 'array', items: { type: 'string' } }

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'rootCause', 'slices', 'whitelist', 'testCommands', 'decisionPoints'],
  properties: {
    verdict: { type: 'string', enum: ['implementable', 'needs-decision', 'blocked'] },
    rootCause: { type: 'string', description: '含 file:line' },
    slices: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'files', 'rationale'],
        properties: { title: { type: 'string' }, files: S_STR_ARR, rationale: { type: 'string' } },
      },
    },
    whitelist: S_STR_ARR,
    testCommands: S_STR_ARR,
    // ★ 关键字段：规划层必须把「需要人定的事」结构化输出，而不是自作主张
    decisionPoints: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'question', 'options', 'recommendation', 'evidence'],
        properties: {
          id: { type: 'string', description: '稳定标识，用户答复时按此 key 回传' },
          question: { type: 'string' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['label', 'consequence'],
              properties: { label: { type: 'string' }, consequence: { type: 'string' } },
            },
          },
          recommendation: { type: 'string' },
          evidence: { type: 'string', description: 'file:line —— 凭什么说这是个需要拍板的点' },
        },
      },
    },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'vitestTail', 'testPassed', 'testFailed', 'typecheckSrcExit', 'commits', 'ticked'],
  properties: {
    status: { type: 'string', enum: ['green', 'red'] },
    vitestTail: { type: 'string', description: '真实尾部输出' },
    testPassed: { type: 'number' },
    testFailed: { type: 'number' },
    typecheckSrcExit: { type: 'number' },
    commits: S_STR_ARR,
    ticked: { type: 'array', items: { type: 'string' }, description: '实际勾选了哪些 checkbox 及其证据' },
  },
}

// ---------- Plan ----------
phase('Plan')
const plan = await llmAgent(
  [
    `你是 ${COMMON.milestone} 的规划者。只规划，不改代码。`,
    '',
    `必读（亲自 Read，禁止凭摘要）：${COMMON.tasks} 中 ${COMMON.milestone} 原文及冻结条款`,
    '',
    '已拍板，不得再问：',
    ...COMMON.decided.map(d => `- ${d}`),
    ...Object.entries(DECISIONS).map(([k, v]) => `- [本轮新增] ${k}：${JSON.stringify(v)}`),
    '',
    `不得触碰：${COMMON.mustNotTouch.join('；') || '（无）'}`,
    `只允许勾选：${COMMON.tickAllowed.join('、')}`,
    '',
    '硬规则：',
    '- 每条结论必须引用你亲自 Read 到的 file:line。',
    '- 凡是需要用户在两个合理方案之间做选择的，写进 decisionPoints，不要自己拍。',
    '- 已在「已拍板」列表里的，绝不能再进 decisionPoints。',
  ].join('\n'),
  { label: 'plan', phase: 'Plan', model: 'opus', effort: 'high', schema: PLAN_SCHEMA }
)

if (!plan) return { status: 'failed', at: 'Plan', milestone: COMMON.milestone }

// ★ 拍板门：早退不消耗 agent、不触发缓存 miss
const unresolved = plan.decisionPoints.filter(d => !(d.id in DECISIONS))
if (unresolved.length) {
  log(`停在拍板点：${unresolved.length} 项待用户裁决`)
  return {
    status: 'need-decision',
    milestone: COMMON.milestone,
    ts: TS,
    // 主 agent 拿这个数组去调 AskUserQuestion
    decisionPoints: unresolved,
    plan,
    // 下一步提示：把答复抄进新脚本的 COMMON.decided，或同会话内带 args.decisions 重跑
    howToResume: '把用户答复按 {<id>: <label>} 传入 args.decisions；跨会话则新建脚本并抄进 COMMON.decided',
  }
}

const planDigest = [
  `根因：${plan.rootCause}`,
  `切片：\n${plan.slices.map(s => `- ${s.title}（${s.files.join(', ')}）— ${s.rationale}`).join('\n')}`,
  `whitelist：${plan.whitelist.join(', ')}`,
].join('\n\n')

// ---------- Review ----------
phase('Review')
const review = await llmAgent(
  `你是 advisor，只审计划。找出它会失败的地方，不要附和。\n\n${planDigest}\n\n` +
    `已拍板事项（不得推翻）：${COMMON.decided.join('；')}\n\n` +
    'block 条件：根因无 file:line / 越过 mustNotTouch / 试图勾选 tickAllowed 之外的条目 / 把未验证假设当事实。',
  {
    label: 'review:plan',
    phase: 'Review',
    model: ADVISOR_MODEL,
    effort: 'high',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['verdict', 'blockers'],
      properties: {
        verdict: { type: 'string', enum: ['approve', 'approve-with-changes', 'block'] },
        blockers: S_STR_ARR,
      },
    },
  }
)

if (review?.verdict === 'block') {
  return { status: 'blocked', at: 'Review', milestone: COMMON.milestone, blockers: review.blockers, plan }
}

// ---------- Implement ----------
phase('Implement')
const impl = await llmAgent(
  [
    '你是实现层。按计划逐切片实现。',
    '',
    planDigest,
    '',
    `只允许改 whitelist 内的文件；不得触碰：${COMMON.mustNotTouch.join('；') || '（无）'}`,
    '改前先 Read 目标文件，改后再 Read 一次确认落盘。',
    '不要 commit（Verify 层负责）。计划里有而你没做的，必须写进 notImplemented。',
  ].join('\n'),
  {
    label: 'implement',
    phase: 'Implement',
    model: 'sonnet',
    effort: 'xhigh',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['done', 'filesChanged', 'notImplemented', 'honesty'],
      properties: {
        done: { type: 'boolean' },
        filesChanged: S_STR_ARR,
        notImplemented: S_STR_ARR,
        honesty: { type: 'string' },
      },
    },
  }
)

// ---------- Verify ----------
phase('Verify')
const verify = await llmAgent(
  [
    '你是独立验证 + 提交层。不要相信上一层的自述，自己跑一遍。',
    `测试命令：${plan.testCommands.join(' && ')}`,
    '',
    '全绿后提交：禁止 git add . 与 -A，逐文件 add；feat 与 docs 分两笔；不 push。',
    `commit message 引用 ${COMMON.milestone}。`,
    `只允许勾选 ${COMMON.tickAllowed.join('、')}，且每个勾选都要在 ticked 里附上证据（测试输出或退出码）。`,
    '没有证据就不要勾。如实报告，测试失败就写 red 并附原始输出。',
  ].join('\n'),
  { label: 'verify', phase: 'Verify', model: 'haiku', schema: VERIFY_SCHEMA }
)

return {
  status: verify?.status ?? 'unknown',
  milestone: COMMON.milestone,
  ts: TS,
  plan,
  review,
  impl,
  verify,
  broadcast: `[${COMMON.milestone}] ${verify?.status ?? '?'} · ${verify?.testPassed ?? '?'} 通过/${verify?.testFailed ?? '?'} 失败 · ${(verify?.commits ?? []).length} 提交`,
  // 下一个里程碑的脚本应把本轮 decided + 本轮结论一起抄进它的 COMMON
  carryForward: [...COMMON.decided, ...Object.entries(DECISIONS).map(([k, v]) => `${k}：${v}`)],
}
