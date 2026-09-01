// 只读调研模板：Read → GitNexus → Synthesize
// 语料里最高频的只读序列。适用于「先搞清楚现状再决定做什么」的场景。
// 全程不改任何文件，可以放心并行。

export const meta = {
  name: '<recon-name>',
  description: '<调研目标一句话>；纯只读，不改文件',
  phases: [
    { title: 'Recon', model: 'sonnet' },
    { title: 'Synthesize', model: 'opus' },
  ],
}

const REPO = args?.repo ?? '<D:/path/to/repo>'
const GITNEXUS_REPO = args?.gitnexusRepo ?? '<indexed-repo-name>'

const RECON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['topic', 'findings', 'evidence', 'unknowns'],
  properties: {
    topic: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'detail', 'confidence'],
        properties: {
          claim: { type: 'string' },
          detail: { type: 'string' },
          // ★ 三档而非布尔：逼模型区分「我验证过」和「我猜的」
          confidence: { type: 'string', enum: ['verified', 'likely', 'speculative'] },
        },
      },
    },
    evidence: { type: 'array', items: { type: 'string' }, description: '具体 file:line 或命令+输出片段' },
    unknowns: { type: 'array', items: { type: 'string' }, description: '你没能查清的事' },
  },
}

// ---------- 调研面：按关注点切分，各自独立 ----------
const ANGLES = [
  {
    key: 'structure',
    label: 'recon:结构与入口',
    prompt: [
      '调研目标：<这一面要搞清楚什么>',
      '',
      '必读（亲自 Read）：',
      `- ${REPO}/<关键文件1>`,
      `- ${REPO}/<关键文件2>`,
      '',
      `GitNexus：query repo=${GITNEXUS_REPO} 找相关执行流；对入口符号跑 context。`,
      '索引落后时须标注，不得当作「无影响」。',
    ].join('\n'),
  },
  {
    key: 'contracts',
    label: 'recon:契约与边界',
    prompt: [
      '调研目标：<这一面要搞清楚什么>',
      '',
      `GitNexus：impact <入口符号> upstream maxDepth 3，repo=${GITNEXUS_REPO}。`,
      '跨模块契约用 api_impact / shape_check。',
      '',
      '每条结论标 verified / likely / speculative。verified 必须附命令与输出片段。',
    ].join('\n'),
  },
  {
    key: 'tests',
    label: 'recon:测试与基线',
    prompt: [
      '调研目标：现有测试覆盖了什么、跑一次要多久、当前是否全绿。',
      '',
      '不要修改任何文件。可以跑只读命令（vitest --run、tsc --noEmit）。',
      '把真实的测试数字与退出码写进 evidence。',
    ].join('\n'),
  },
]

const HARD_RULES = [
  '',
  '通用硬规则：',
  '- 你的任务是纯调研，不修改任何文件。',
  '- 每条结论必须引用你亲自 Read 到的 file:line 或实际跑过的命令输出，禁止凭记忆。',
  '- 查不清的写进 unknowns，不要编。',
  '- confidence 标 verified 的，evidence 里必须有对应的命令与输出。',
].join('\n')

phase('Recon')
const recon = (
  await parallel(
    ANGLES.map(a => () =>
      agent(a.prompt + HARD_RULES, {
        label: a.label,
        phase: 'Recon',
        model: 'sonnet',
        effort: 'xhigh',
        schema: RECON_SCHEMA,
      })
    )
  )
).filter(Boolean) // ★ agent 失败返回 null，必须过滤

log(`调研完成：${recon.length}/${ANGLES.length} 份报告`)

if (!recon.length) return { status: 'failed', at: 'Recon' }

const digest = recon
  .map(
    r =>
      `### ${r.topic}\n` +
      r.findings.map(f => `- [${f.confidence}] ${f.claim} — ${f.detail}`).join('\n') +
      `\n证据：\n${r.evidence.map(e => `- ${e}`).join('\n')}` +
      `\n未知：\n${r.unknowns.map(u => `- ${u}`).join('\n')}`
  )
  .join('\n\n')

phase('Synthesize')
const synthesis = await agent(
  [
    '基于下面的调研报告，产出一份结论（中文 Markdown）。',
    '',
    digest,
    '',
    '要求：',
    '1. 先给一句话结论。',
    '2. 明确区分「已验证」与「未验证」—— 凡调研标 speculative 的，结论里必须写明「未验证，需要做 <具体实验>」，不要直接当事实用。',
    '3. 列出 unknowns 中真正影响决策的那些，其余略过。',
    '4. 如果调研之间有矛盾，指出来，不要和稀泥。',
    '5. 最后给出建议的下一步（可执行，指向具体文件或命令）。',
  ].join('\n'),
  { label: 'synthesize', phase: 'Synthesize', model: 'opus', effort: 'high' }
)

return { synthesis, reconCount: recon.length, angles: ANGLES.map(a => a.key) }
