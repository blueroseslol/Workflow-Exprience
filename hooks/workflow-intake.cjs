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
        `valid=${c.validation.valid} legacy=${c.legacyUnverified} nativeResume=${c.nativeResumeEligible} runId=${c.runId || '-'} ` +
        `scriptPath=${c.scriptPath || '-'} changed=${changed}`
    })
    checkpointContext =
      '\n[Ultracode checkpoint resolver] 发现历史语义 checkpoint 候选：\n' + rows.join('\n') +
      '\n恢复规则：只使用与本需求 change/milestone/task 明确匹配的候选。' +
      '若 nativeResume=true，必须优先使用该候选的原 scriptPath + resumeFromRunId，禁止重新 author 脚本；' +
      '否则 valid=true 时 Read 对应 state JSON，并把完整对象作为 args.priorState，同时传 checkpointKey 与 ' +
      'args.checkpointValidation={valid:true,sourceValid:true,codeValid:true,legacyUnverified:false,changedPaths:[]}；' +
      '若 legacy=true 且 nativeResume=false，可 Read state 并传 args.checkpointValidation={valid:false,legacyUnverified:true,changedPaths:["<legacy-unverified>"]}，' +
      'OpenSpec 模板会先用廉价 Recon 模型做 CheckpointValidate，验证通过才跳过 BasePlan/Review；' +
      '普通 valid=false 且 legacy=false 时禁止复用历史 Plan/Review，只把 changedPaths 当失效证据。'
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext:
          '[workflow 入口] 用户以 workflow 前缀提交开发需求。立即调用 Skill 工具' +
          '（skill: "workflow-experience:workflow-experience"）加载意图路由规则并处理该需求；' +
          '对用户只讲阶段意图，不报内部模板文件名；不要当普通聊天直接回答。' +
          '如果原始需求显式要求“完成后通知主会话/其他会话、回传结果、同步给协调会话”等跨会话动作，' +
          '必须保留该意图并按 Skill 的 peer-session handoff 规则处理：workflow 内只产出结果，' +
          'workflow 到达 terminal result 后由外层 Claude Code 会话定向执行 ListAgents/SendMessage；' +
          '不得在 Ultracode workflow DSL 中伪造不存在的 SendMessage primitive。' + checkpointContext,
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
