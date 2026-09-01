// codex-relay.workflow.js — codex 线程 → Ultracode 接力开发
// 用法（Claude 主循环）：
//   Workflow({ scriptPath: 'D:/AI/Skill/Workflow-Exprience/scripts/codex-relay.workflow.js',
//              args: { bundlePath: '<...>/codex-handoff-<uuid8>.json',
//                      repoRoot: 'D:/AI/Website/LDL_UGC',
//                      gitRoots: ['D:/AI/Website/LDL_UGC/backend'],
//                      gitnexusRepo: 'ldl-ugc-backend',
//                      task: '<用户口述的接力目标>',
//                      decisions: { ... },              // 用户已拍板项，可为 {}
//                      docsDir: 'D:/AI/Website/LDL_UGC/docs/ultracode',
//                      handoffDoc: 'backend/docs/handoff/backend/handoff-....md',
//                      ts: '2026-09-01T12:00:00Z' } })  // 脚本内不能调 Date.now()
// 关键设计：Gate 阶段是硬门。自述段永不进入 Plan 的 prompt。
export const meta = {
  name: 'codex-relay-ultracode',
  description: 'codex 线程交接包 → 强制交叉验证 → Ultracode 接力开发（Opus 计划 / fable 审 / Sonnet 实现 / Haiku 验证提交）',
  phases: [
    { title: 'Gate', model: 'haiku' },
    { title: 'Read', model: 'haiku' },
    { title: 'Plan', model: 'opus' },
    { title: 'Review', model: 'fable' },
    { title: 'Implement', model: 'sonnet' },
    { title: 'Verify', model: 'haiku' },
    { title: 'Record', model: 'haiku' },
  ],
}

const A = args || {}
const REPO = A.repoRoot || ''
const GIT_ROOTS = (A.gitRoots && A.gitRoots.length) ? A.gitRoots : [REPO]
const GNX = A.gitnexusRepo || ''
const BUNDLE = A.bundlePath || ''
const TASK = A.task || '（未指定，按 codex 线程的 goal 继续）'
const DECISIONS = A.decisions || {}
const DOCS = A.docsDir || (REPO + '/docs/ultracode')
const HANDOFF = A.handoffDoc || ''
const TS = A.ts || 'unstamped'

if (!BUNDLE) return { stopped: 'missing-args', why: 'args.bundlePath 必填：先跑 codex-handoff.mjs 生成 .json' }

// ---------------- schemas ----------------
const GATE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['workingTreeSafe', 'gitSummary', 'zeroCommitRisk', 'claimTable', 'claimsVerdict', 'blockers', 'userDecisionsNeeded'],
  properties: {
    workingTreeSafe: { type: 'boolean', description: '已完成盘点、可以安全动手；只要有任何未知的未提交内容就是 false' },
    gitSummary: { type: 'string', description: '每个 git root 的 status --short 计数：M / ?? / D 各多少，是否有 stash，HEAD oneline' },
    zeroCommitRisk: { type: 'boolean', description: '交接包 gitCommitCount===0 且工作区确实脏 → true' },
    claimTable: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['claim', 'command', 'expected', 'actual', 'match'],
        properties: {
          claim: { type: 'string' }, command: { type: 'string' },
          expected: { type: 'string' }, actual: { type: 'string' },
          match: { type: 'string', enum: ['match', 'mismatch', 'not-run'] },
        },
      },
    },
    claimsVerdict: { type: 'string', enum: ['trustworthy', 'untrustworthy'], description: '任一 mismatch 或关键项 not-run → untrustworthy（整段自述降级，不是只降那一条）' },
    blockers: { type: 'array', items: { type: 'string' } },
    userDecisionsNeeded: { type: 'array', items: { type: 'string' } },
  },
}

const READ_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['interruptPoint', 'evidence', 'openspecDrift', 'selfCompleteness', 'notes'],
  properties: {
    interruptPoint: { type: 'string', description: '中断那一轮实际做到哪：文件、函数、file:line' },
    evidence: { type: 'array', items: { type: 'string' }, description: '必须是 file:line' },
    openspecDrift: { type: 'array', items: { type: 'string' }, description: '勾了 [x] 但代码里找不到对应实现的条目' },
    selfCompleteness: { type: 'string', enum: ['self-consistent', 'half-done', 'broken'] },
    notes: { type: 'string' },
  },
}

const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'slices', 'whitelist', 'mustNotTouch', 'gitnexus', 'honesty', 'rollback', 'testCommands', 'openQuestionsForUser', 'planMarkdown'],
  properties: {
    verdict: { type: 'string', enum: ['implementable', 'blocked'] },
    slices: { type: 'array', items: { type: 'string' } },
    whitelist: { type: 'array', items: { type: 'string' } },
    mustNotTouch: { type: 'array', items: { type: 'string' } },
    gitnexus: { type: 'string' },
    honesty: { type: 'string' },
    rollback: { type: 'string', description: '零提交语境下的回滚：反向编辑 + 精确删除，禁止 checkout/stash/clean' },
    testCommands: { type: 'array', items: { type: 'string' } },
    openQuestionsForUser: { type: 'array', items: { type: 'string' } },
    planMarkdown: { type: 'string' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['decision', 'blockers', 'requiredEdits', 'notes'],
  properties: {
    decision: { type: 'string', enum: ['approve', 'revise', 'block'] },
    blockers: { type: 'array', items: { type: 'string' } },
    requiredEdits: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

const IMPL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['ok', 'filesChanged', 'testsAdded', 'notes', 'skippedBecause'],
  properties: {
    ok: { type: 'boolean' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    testsAdded: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
    skippedBecause: { type: 'string' },
  },
}

const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['passed', 'commandResults', 'baselineDelta', 'commits', 'gitnexusDetect', 'honestyRemainder', 'blockers'],
  properties: {
    passed: { type: 'boolean' },
    commandResults: { type: 'array', items: { type: 'string' } },
    baselineDelta: { type: 'string', description: '与 Gate 阶段基线的数字对比；低于基线即视为回退' },
    commits: { type: 'array', items: { type: 'string' } },
    gitnexusDetect: { type: 'string' },
    honestyRemainder: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' } },
  },
}

const RECORD_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['ultracodeDoc', 'handoffAppended', 'broadcast', 'notes'],
  properties: {
    ultracodeDoc: { type: 'string' },
    handoffAppended: { type: 'boolean' },
    broadcast: { type: 'string', description: '一行进度广播文本，供跨会话消费' },
    notes: { type: 'string' },
  },
}

const GIT_SAFETY = [
  '禁止 git checkout -- / restore / reset --hard / clean / stash / 切分支 —— 交接包可能来自零提交线程，这些操作会不可逆销毁数天工作。',
  '禁止 git add . 与 git add -A；只精确 add 本切片路径。',
  '不 push、不 rebase、不 merge。',
  '回滚 = 人工反向编辑 + 精确删除自己新建的文件。',
].join('\n')

// ================= Gate（硬门，不可跳过） =================
phase('Gate')
log('硬门：盘点工作树 + 机械比对 codex 自述里的每个数字。不通过不进规划。')

const gate = await agent(`你是 haiku 验证闸门。只读、只跑命令，不改任何生产代码，不 commit。

交接包 JSON：${BUNDLE}
先 Read 这个文件。它有两类内容，你只信任前一类：
- 机器事实（cwd / userDirectives / files / commandCount / commandFailures / gitCommitCount / lastTurnEmpty / compactions / failureSignatures）—— 直接读自 rollout 字节，不可伪造。
- agent 自述（同目录 .md 的第 7 节）—— codex 自己写的话，全部当作待证伪的假设。

## 步骤 1：工作树盘点（在写任何东西之前）
对每个 git root 跑（逐个，不要合并）：
${GIT_ROOTS.map(r => `- git -C "${r}" status --short ; git -C "${r}" diff --stat ; git -C "${r}" log -1 --oneline ; git -C "${r}" stash list`).join('\n')}
把 M / ?? / D 的数量分别数出来写进 gitSummary。
若交接包的 gitCommitCount === 0 且工作区确实脏 → zeroCommitRisk=true，并在 blockers 里第一条写明「零提交高危：N 个文件悬空，未盘点前禁止任何丢弃性 git 操作」。

${GIT_SAFETY}

## 步骤 2：机械比对自述数字（这是本阶段的核心产出）
打开交接包的 .md（把 .json 换成 .md），只读第 7 节。从中抽出每一个**可证伪的数字断言**：
形如「N files / M tests 全绿」「typecheck 通过」「pack 6 个 / X 字节」「878 项通过」「strict validation 通过」。
每条断言生成一行 claimTable：claim（原话）、command（你实际跑的命令）、expected（自述数字）、actual（实测数字）、match。
必须真的把命令跑起来。跑不动（缺依赖、缺权限、需要付费 Provider、需要网络）就填 not-run 并在 blockers 说明原因，**不要猜**。

判定规则（严格，不许放宽）：
- 全部 match → claimsVerdict='trustworthy'
- **任一 mismatch，或关键测试项 not-run → claimsVerdict='untrustworthy'**。
  注意：只降一条是错的。测试配置文件（如 vitest.config.ts）在原线程后期被反复修改过，覆盖面缩水会让**别的**数字同时失去意义，所以一处不符就整段降级。

## 步骤 3：不可信证据源标注
若交接包 failureSignatures 里出现 GitNexus 相关失败（index 损坏 / WAL / FTS 降级 / duplicate PK），在 blockers 写明「GitNexus 结论在原线程中不可信，接力方在重建索引前不得把 impact=LOW 当作安全依据」。

## 步骤 4：汇总待用户拍板项
从机器事实的 userDirectives 与失败签名里找出「需要用户提供凭据 / 批准范围 / 提供素材」才能继续的事项，写进 userDecisionsNeeded。
已拍板的（不要重复问）：${JSON.stringify(DECISIONS)}

workingTreeSafe=true 仅当：盘点完成、没有未知来源的丢弃风险、没有正在被他人并行修改的目录。`, {
  model: 'haiku', effort: 'max', phase: 'Gate', label: 'gate-verify', schema: GATE_SCHEMA,
})

if (!gate) return { stopped: 'gate-agent-failed' }
if (!gate.workingTreeSafe) {
  return { stopped: 'gate-unsafe', gate, askUser: gate.blockers.concat(gate.userDecisionsNeeded) }
}
if (gate.userDecisionsNeeded.length && !Object.keys(DECISIONS).length) {
  log('闸门产出 ' + gate.userDecisionsNeeded.length + ' 条待拍板项，先停下来问用户')
  return { stopped: 'need-user-decisions', gate, askUser: gate.userDecisionsNeeded }
}
log('闸门通过。自述可信度 = ' + gate.claimsVerdict + '（' + gate.claimTable.length + ' 条断言已比对）')

// ================= Read（读码定位中断点） =================
phase('Read')
const read = await agent(`你是 haiku 读码者。只读，不改任何文件。

交接包机器事实：${BUNDLE}（Read 它，只看 files / userDirectives / lastTurnEmpty / aborts 字段）
仓库根：${REPO}

## 任务
原 codex 线程${gate.zeroCommitRisk ? '在零提交状态下' : ''}被中断，最后一轮没有收尾总结。你要用**源码与工作区 diff**，而不是自述，回答：中断那一轮实际做到哪一步。

做法：
1. 从交接包 files 里取触碰次数最高的前 15 个路径 + 时间上最后被改的那批，逐个 Read。
2. 对每个 git root 跑 git diff（不带 --stat，读真实 hunk），重点看未跟踪文件（??）：它们是这条线程新造的东西，最可能半成品。
3. 若仓库有 openspec/changes/*/tasks.md，逐条核对已勾 [x] 的项在代码里是否真有对应实现。**勾选是 agent 自己写的，不是证据。** 找不到实现的写进 openspecDrift。
4. 若有 docs/handoff 文档，读它——那是原 agent 自己的跨会话交接通道，比转述新。

## 硬约束
- evidence 里每一条必须是 file:line，不得凭推断。
- 不要读交接包 .md 的第 7 节（agent 自述）。你的判断必须独立于它。
${GIT_SAFETY}

产出 interruptPoint（具体到 file:line）、evidence、openspecDrift、selfCompleteness、notes。`, {
  model: 'haiku', effort: 'max', phase: 'Read', label: 'read-interrupt-point', schema: READ_SCHEMA,
})

if (!read) return { stopped: 'read-failed', gate }

// ================= Plan（自述段永不进入这里） =================
phase('Plan')
log('Opus 规划。输入只有：机器事实 + 验证对照表 + 用户拍板结果 + 读码结论。')

const plan = await agent(`你是 Team Lead / Opus 规划者。只出计划，不改代码、不勾 checkbox、不 commit。

## 接力目标（用户口述）
${TASK}

## 输入 1：机器事实（不可伪造）
交接包：${BUNDLE} —— Read 它，只读这些字段：cwd / userDirectives / goals / files / commandTop / failureSignatures / compactions / gitCommitCount / lastTurnEmpty / aborts。
**userDirectives 是用户的原话，是本次接力唯一不可从工作区重建的信息，具有最高约束力。**
其中出现的禁令（不许重跑付费任务、不许打开自动重试、某个变更先跳过、某条主线已叫停等），你必须逐条转写进 planMarkdown 的「不可推翻的约束」小节，并在 mustNotTouch 里落成具体路径或开关。

## 输入 2：验证对照表（Gate 实测）
自述可信度：**${gate.claimsVerdict}**
${gate.claimsVerdict === 'untrustworthy'
    ? '→ codex 的全部「已完成 / 全绿」自述已降级为不可采信。规划中不得把任何一项当作既有事实；需要哪一块就自己重新验证。'
    : '→ 自述数字与实测一致，可作为参考基线，但仍不是证据。'}
git 现状：${gate.gitSummary}
${gate.zeroCommitRisk ? '**零提交高危：整棵工作树未提交。计划必须包含分批提交策略，且第一笔提交前不得做任何丢弃性 git 操作。**' : ''}
实测对照：
${gate.claimTable.map(c => `- [${c.match}] ${c.claim} → 期望 ${c.expected} / 实测 ${c.actual}`).join('\n')}

## 输入 3：读码结论（file:line 证据）
中断点：${read.interruptPoint}
完成度：${read.selfCompleteness}
证据：${read.evidence.join(' | ')}
OpenSpec 漂移（勾了但找不到实现）：${read.openspecDrift.join(' | ') || '（无）'}
${read.notes}

## 输入 4：用户已拍板
${JSON.stringify(DECISIONS, null, 2)}

## 你没有拿到的东西（不要去要）
- codex 的推理链：rollout 中全部 reasoning 都是 encrypted_content，永久不可读。「它为什么这么做」这层信息不存在。
- 原线程发生过多次上下文压缩（见交接包 compactions 字段）；它后期的判断可能建立在被截断的上下文上。涉及早期决策一律以 openspec/tasks.md 与 docs/handoff 为准。

## 规划硬约束
- 规划必须亲自 Read 你打算改的每个文件，planMarkdown 中所有论断都要有 file:line。不得凭本 prompt 推断。
${GNX ? `- GitNexus（repo=${GNX}）：对将改的入口符号跑 context + impact(direction=upstream, maxDepth=3)，把实测 risk / impactedCount / epistemic 写进 gitnexus 字段。若交接包显示原线程 GitNexus 索引损坏，先在计划里写明「需重建索引后才做影响面判断」。` : '- 本仓未配置 GitNexus，gitnexus 字段写「N/A」。'}
- whitelist 是本次允许改动的完整路径清单；mustNotTouch 落实用户禁令与冻结面。
- rollback 必须写成「反向编辑 + 精确删除」，不得写 checkout/stash/reset。
- testCommands 必须是可直接执行的命令行，且要覆盖 Gate 阶段测到的基线。
- honesty：能自动完成的继续做；真正需要用户提供素材/凭据/人工验收的，写成诚实降格，不要为了推进而放宽断言，也不要因此整体停摆。
- openQuestionsForUser 只放物理上无法继续的事项。
- planMarkdown 用简体中文；代码标识符保持原文。

verdict=implementable，除非物理阻塞。`, {
  model: 'opus', effort: 'high', phase: 'Plan', label: 'opus-plan', schema: PLAN_SCHEMA,
})

if (!plan || plan.verdict !== 'implementable') {
  return { stopped: 'plan-blocked', gate, read, plan }
}

// ================= Review（fable 只审计划） =================
phase('Review')
const review = await agent(`你是 fable。只审下面这份接力计划，不看实现、不改代码。你的默认立场是反驳而不是附和。

判定：
- approve：可执行，无硬约束违反
- revise：方向对，但白名单 / 诚实口径 / 回滚策略必须先改（列 requiredEdits）
- block：违反硬约束

必须 block 的情形：
1. 计划把 codex 的自述当成既有事实——本次自述可信度为 **${gate.claimsVerdict}**${gate.claimsVerdict === 'untrustworthy' ? '，即全部不可采信' : ''}。
2. 计划包含任何丢弃性 git 操作（checkout -- / restore / reset --hard / clean / stash / 切分支）${gate.zeroCommitRisk ? '——本次工作树零提交，这类操作会销毁数天工作' : ''}。
3. 计划违反用户原话中的禁令（付费调用上限、已叫停的主线、要求跳过的变更、已关闭的自动重试等）。
4. 计划把「需要用户提供素材或凭据」的事项伪装成可自动完成。
5. 计划依赖已被标注为不可信的证据源（例如索引损坏时的 GitNexus impact 结论）。
6. 计划为了勾选 checkbox 而放宽验收断言。允许诚实不勾。

计划正文：
${plan.planMarkdown}

whitelist：
${plan.whitelist.join('\n')}

mustNotTouch：
${plan.mustNotTouch.join('\n')}

honesty：${plan.honesty}
rollback：${plan.rollback}
gitnexus：${plan.gitnexus}

用户原话约束的来源是交接包 ${BUNDLE} 的 userDirectives 字段；有疑问就 Read 它自己核。`, {
  model: 'fable', effort: 'high', phase: 'Review', label: 'fable-review', schema: REVIEW_SCHEMA,
})

if (!review || review.decision === 'block') {
  return { stopped: 'fable-block', gate, read, plan, review }
}
if (review.decision === 'revise') log('fable=revise：实现阶段必须吸收 requiredEdits')

// ================= Implement =================
phase('Implement')
const impl = await agent(`你是实现者（sonnet）。必须 Read → Edit → Read（改前读、改后再读验证）。

只改计划白名单内的文件。不 commit、不 git add、不勾 checkbox（留给 Verify）。

计划：
${plan.planMarkdown}

fable requiredEdits（必须吸收）：
${JSON.stringify(review.requiredEdits)}

whitelist：
${plan.whitelist.join('\n')}

mustNotTouch：
${plan.mustNotTouch.join('\n')}

回滚策略：${plan.rollback}

## 硬约束
${GIT_SAFETY}
- 每个将改文件先 Read 相关段落，改完再 Read 验证。
- 中文不进代码标识符。测试名用英文。Windows 路径用绝对路径或 path.join。
- 若发现计划与源码冲突：停在白名单内做最小诚实实现，写进 notes，不要扩面。
- 若必须改计划未授权的高影响符号：停下，写进 notes，ok=false。
- 依赖变更不要自己 install，留给 Verify。

产出 filesChanged、testsAdded、ok、notes、skippedBecause。`, {
  model: 'sonnet', effort: 'xhigh', phase: 'Implement', label: 'sonnet-implement', schema: IMPL_SCHEMA,
})

if (!impl || !impl.ok) {
  return { stopped: 'implement-failed', gate, read, plan, review, impl }
}

// ================= Verify =================
phase('Verify')
const verify = await agent(`你是独立验证 haiku。不信任实现者的口述，亲自跑命令、亲自 Read。

实现者声称：
filesChanged=${JSON.stringify(impl.filesChanged)}
testsAdded=${JSON.stringify(impl.testsAdded)}
notes=${impl.notes}

## 必做
1. Read 关键接线，确认实现者说的确实在代码里。
2. 逐条执行计划的 testCommands：
${plan.testCommands.map(c => '   - ' + c).join('\n')}
3. baselineDelta：把结果与 Gate 阶段的实测基线逐个数字对比：
${gate.claimTable.map(c => `   - ${c.claim}：Gate 实测 ${c.actual}`).join('\n')}
   **任何低于基线的数字都算回退**，即使显示"全部通过"——测试配置的覆盖面可能被缩小了。发现即 passed=false。
${GNX ? `4. GitNexus：detect_changes(scope=all)，并对改动过的公共符号重跑 context/impact。repo=${GNX}。` : '4. 本仓无 GitNexus，跳过并注明。'}
5. 提交（仅当 passed=true）：
   - 对照计划与 tasks.md 的已勾条目写 conventional commit
   - **精确 git add 本切片路径，禁止 git add . / -A**
   - feat 与 docs/spec 分离提交
   - 依赖有变则 install 后单独 chore，或并入 feat
   - 不 push、不 rebase、不 merge、不碰无关 dirty
${GIT_ROOTS.map(r => `   - git -C "${r}"`).join('\n')}
${gate.zeroCommitRisk ? '   - **本工作树原本零提交、体量巨大。分批提交，一次性提交会丧失可回溯性。只提交本切片新产生的改动，原线程遗留的悬空文件除非属于本切片否则不要一并提交。**' : ''}
6. 若测试失败：passed=false，不提交，写 blockers。只修测试文件的类型错误，不得改生产行为来"救"绿灯。

${GIT_SAFETY}

产出 passed、commandResults、baselineDelta、commits(hash+subject)、gitnexusDetect、honestyRemainder、blockers。`, {
  model: 'haiku', effort: 'max', phase: 'Verify', label: 'haiku-verify', schema: VERIFY_SCHEMA,
})

// ================= Record（固化 + 广播） =================
phase('Record')
const record = await agent(`你是 haiku 记录者。只写文档，不改生产代码，不再提交代码（提交已由 Verify 完成）。

## 1. 固化到 ${DOCS}
创建/覆盖 ${DOCS}/relay-${TS.replace(/[:.]/g, '-')}.md，内容：
- 来源 codex 线程 uuid 与 rollout 路径（读 ${BUNDLE} 的 uuid / rolloutPath 字段）
- 本次接力目标：${TASK}
- Gate 验证对照表（原样抄录，这是「接手时真实状态」的唯一权威记录）：
${gate.claimTable.map(c => `  - [${c.match}] ${c.claim} → 期望 ${c.expected} / 实测 ${c.actual}`).join('\n')}
- 自述可信度判定：${gate.claimsVerdict}
- 中断点：${read.interruptPoint}
- 计划白名单与 mustNotTouch
- 本轮实际改动：${JSON.stringify(impl.filesChanged)}
- 验证结果与提交：${verify ? JSON.stringify(verify.commits) : '（验证未通过，无提交）'}
- 诚实剩余：${verify ? verify.honestyRemainder : plan.honesty}
- 仍需用户拍板：${JSON.stringify(plan.openQuestionsForUser)}
同时更新（没有就创建）${DOCS}/INDEX.md，追加一行指向本文件。

## 2. 反向通道：追加到仓库内的 handoff 文档
${HANDOFF ? `在 ${REPO}/${HANDOFF} 末尾**追加**（不要改写既有内容）一段：
「## 由 Claude Code 接手 · ${TS}」，写明：接手自哪条 codex 线程、Gate 验证结论、本轮做了什么、验证结果、下一步、仍待拍板项。
这是与 codex 的双向通道——它下次 resume 读工作区时会看到。` : '本次未指定 handoffDoc，跳过；在 notes 里说明建议追加到哪个文档。'}

## 3. 绝对禁止
- 不得写入 ~/.codex 下的任何文件（rollout.jsonl / state_5.sqlite / memories 全部只读）。
- 不得 git add . / -A；本阶段只 add 你新写的文档路径，与 Verify 的代码提交分开成 docs 提交。
- 不 push。

## 4. 广播文本
产出一行 broadcast：形如「[relay] <repo> ← codex <uuid8>：<做了什么>；验证 <passed>；待拍板 N 项」，供跨会话进度广播消费。`, {
  model: 'haiku', effort: 'max', phase: 'Record', label: 'haiku-record', schema: RECORD_SCHEMA,
})

return {
  gateVerdict: gate.claimsVerdict,
  zeroCommitRisk: gate.zeroCommitRisk,
  claimTable: gate.claimTable,
  interruptPoint: read.interruptPoint,
  openspecDrift: read.openspecDrift,
  fable: review.decision,
  filesChanged: impl.filesChanged,
  verifyPassed: !!(verify && verify.passed),
  baselineDelta: verify && verify.baselineDelta,
  commits: (verify && verify.commits) || [],
  ultracodeDoc: record && record.ultracodeDoc,
  broadcast: record && record.broadcast,
  askUser: [].concat(
    gate.userDecisionsNeeded,
    plan.openQuestionsForUser,
    review.blockers,
    (verify && verify.blockers) || []
  ),
  honesty: (verify && verify.honestyRemainder) || plan.honesty,
}
