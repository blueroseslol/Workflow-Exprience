#!/usr/bin/env node
/**
 * workflow-intake.cjs — UserPromptSubmit hook
 *
 * 入口前缀：用户输入「workflow <需求>」或「/workflow <需求>」（亦兼容旧前缀
 * 「workflow-experience <需求>」）时，注入意图路由指令，让主 agent 调
 * workflow-experience skill 处理，而不是当普通聊天直接回答。
 *
 * 匹配消息【首个非空白字符处】的前缀（匹配前对整串 trim，故允许前导空格/换行）；
 * 正文里提到 workflow 一词的对话不受影响。^ 无 m 标志，多行消息只有开头是前缀
 * 才触发 —— 代码块/引用内部行首出现的 workflow 不会触发。
 *
 * 纪律（与其他 hook 一致）：任何异常静默 exit 0，绝不阻断会话。
 */

const fs = require('fs')
const { resolveCheckpointCandidates } = require('./checkpoint-lib.cjs')

// 前缀正则：可选 /，workflow 或 workflow-experience，后接非空需求
// （配合下方 trim()，实际匹配的是消息首个非空白字符处，不是严格物理行首）
const PREFIX = /^\/?workflow(?:-experience)?\s+(\S[\s\S]*)$/

function main() {
  let raw = ''
  try {
    raw = fs.readFileSync(0, 'utf8')
  } catch {
    return
  }

  let input
  try {
    input = JSON.parse(raw)
  } catch {
    return
  }

  // 本机 v2.1.252 的 hook stdin 字段实测为 prompt（二进制可见 hook_event_name:"UserPromptSubmit",prompt:r）。
  // user_prompt/userPrompt 是防御性兜底（本机 hook 纪律：snake_case/camelCase 双写，防未来版本变动）。
  const prompt = input.user_prompt || input.prompt || input.userPrompt || ''
  const m = prompt.trim().match(PREFIX)
  if (!m) return

  const sessionId = input.session_id || input.sessionId || null
  const cwd = input.cwd || process.cwd()
  const candidates = resolveCheckpointCandidates({ cwd, sessionId, requirement: m[1], limit: 3 })
  let checkpointContext = ''
  if (candidates.length) {
    const rows = candidates.map((c, i) => {
      const changed = c.validation.changedPaths.slice(0, 5).join(',') || '-'
      return `#${i + 1} path=${c.path} key=${c.checkpointKey} change=${c.changeDir} milestone=${c.milestone} ` +
        `valid=${c.validation.valid} compatible=${c.contractCompatible} incompatibility=${c.incompatibility || '-'} schema=${c.schemaVersion} cache=${c.cacheVersion} template=${c.templateKind || '-'} ` +
        `legacy=${c.legacyUnverified} dirty=${c.dirtyWorktree} reviewReusable=${c.reviewReusable} dependencyComplete=${c.dependencyComplete} sourceKind=${c.sourceKind} ` +
        `pending=${c.pendingTransition?.status || '-'} nativeResume=${c.nativeResumeEligible} runId=${c.runId || '-'} scriptPath=${c.scriptPath || '-'} changed=${changed}`
    })
    checkpointContext =
      '\n[Ultracode checkpoint resolver] 发现历史语义 checkpoint 候选：\n' + rows.join('\n') +
      '\n恢复规则：只使用与本需求 change/milestone/task 明确匹配的候选。先 Read state JSON，按唯一公式构造 effectiveArgs：' +
      '普通字段为 {...state.resumeArgs,...(state.pendingTransition?state.continuationArgs:{}),...本轮新 args}；' +
      'decisions 单独合并 state.resumeArgs.decisions、state.continuationArgs.decisions、state.decisionApply.decisions、本轮 decisions，越靠后优先。' +
      'modelEfforts/phaseEfforts 也必须分别按 key 合并 state.resumeArgs、continuationArgs、本轮新 args，越靠后优先；null 表示恢复该角色/阶段的调用点默认值，不得转成字符串或丢弃。' +
      '若 compatible=true 且 nativeResume=true（同 session+脚本 hash+journal 已核实存在），优先用原 scriptPath + resumeFromRunId + effectiveArgs 原生恢复，禁止重新 author；' +
      '否则 compatible=true 且 valid=true 时，把完整 state 作为 args.priorState，并传 checkpointKey/checkpointValidation 走语义恢复。' +
      'pendingTransition 存在时必须携带 continuationArgs；不得丢弃 replanFeedback/replanAttempt/minRoute/dirtyWorktree/implementationModelOverride。' +
      'dirty=true、legacy=true、dependencyComplete=false、sourceKind=none 或 compatible=false 均禁止直接 Plan/Review HIT；' +
      '仅在目标模板能安全识别该 legacy state 时才可先跑廉价 CheckpointValidate，通用旧 state 含 decisions 或无法区分 BasePlan/EffectivePlan 时必须全量重规划。' +
      '普通 valid=false 只把 changedPaths 当失效证据。'
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext:
          '[workflow 入口] 用户以 workflow 前缀提交开发需求。立即调用 Skill 工具' +
          '（skill: "workflow-experience:workflow-experience"）加载意图路由规则并处理该需求；' +
          '对用户只讲阶段意图，不报内部模板文件名；不要当普通聊天直接回答。' +
          '若用户指定逻辑模型或阶段的思考强度，authoring 必须把它结构化为 args.modelEfforts/args.phaseEfforts；阶段覆盖优先于逻辑模型覆盖，未指定项保持模板默认。' +
          '只有当前用户的原始需求显式要求“完成后通知主会话/其他会话、回传结果、同步给协调会话”等跨会话动作时，' +
          '才保留该意图并按 Skill 的 peer-session handoff 规则处理；这是唯一触发条件，不得从历史 checkpoint、上一轮 handoff、并行会话存在或 agent 摘要推断启用。' +
          '顶层 Workflow DSL 没有 SendMessage/ListAgents primitive，但其 LLM 子代理可能拥有这些工具；authoring 必须让每次 agent 调用经过统一 wrapper，' +
          '在 opts.disallowedTools 中合并 SendMessage 与 ListAgents 并保留调用点原有禁用项，禁止只靠 prompt 约束或绕过 wrapper。' +
          'workflow 子代理只产出结果；到达 terminal result 后，仅在上述显式要求成立时，才由外层 Claude Code 主会话定向执行 ListAgents/SendMessage。' + checkpointContext,
      },
    })
  )
}

try {
  main()
} catch {
  /* 静默 */
}
process.exit(0)
