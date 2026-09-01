#!/usr/bin/env node
/**
 * skill-pointer.cjs — PreToolUse(Skill) hook
 *
 * 需求 3：调用 workflow-authoring 时，提醒 agent 本机有模板可用。
 *
 * ⚠️ 为什么只注入「一行路径指针」而不是文档内容：
 *   additionalContext 是【追加】不是替换 —— 内置 workflow-authoring 正文
 *   （17112 字符 ≈ 4753 token）照常返回。注入内容是纯增量。
 *   注入 5KB 文档 = 每次触发多烧 ~1400 token，且省不掉任何东西。
 *   所以这里只注入 ~30 token 的指针，让 agent 自己决定要不要 Read。
 */

const fs = require('fs')
const path = require('path')

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..')

const TARGET_SKILLS = new Set(['workflow-authoring'])

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

  const skillRaw = input.tool_input?.skill || input.toolInput?.skill
  if (typeof skillRaw !== 'string') return

  // 插件技能形如 plugin:skill，取冒号后的部分
  const skillName = skillRaw.includes(':') ? skillRaw.split(':').pop() : skillRaw
  if (!TARGET_SKILLS.has(skillName)) return

  const skillDir = path.join(PLUGIN_ROOT, 'skills', 'workflow-experience').replace(/\\/g, '/')
  const templates = path.join(PLUGIN_ROOT, 'templates').replace(/\\/g, '/')

  // 不枚举模板名：每加一个模板都要同步改 hook，是纯维护税。
  // 只给索引与目录，让 agent 自己按需 Read。
  // 注：本 hook 只在命中 workflow-authoring 时触发，反向依赖由 workflow-experience/SKILL.md 负责，
  //     这里不再重复「先调用 workflow-authoring」（会造成循环提示）。
  const pointer =
    `本机已有 workflow 经验库：先 Read ${skillDir}/SKILL.md 的索引，` +
    `再按需 Read references/ 或 templates/（${templates}/）下的可粘贴模板，不要从零编。`

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: pointer,
      },
    })
  )
}

try {
  main()
} catch {
  /* 读不到 skill 名就不注入 */
}
process.exit(0)
