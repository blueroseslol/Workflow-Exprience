#!/usr/bin/env node
/**
 * peer-progress.cjs — 历史/手动工具（默认插件 hooks 不注册）
 *
 * 读取 .claude/progress/*.jsonl，并按旧 SessionStart hook 协议输出其他会话的新进度。
 * 本文件仅为历史兼容与人工排障保留；hooks/hooks.json 不再注册它，默认安装绝不自动
 * 读取或注入其他会话进度。若操作者明确决定手动注册，建议仍限制 matcher 为 startup|clear。
 *
 * 为什么过去挂 SessionStart 而不是 UserPromptSubmit：
 *   UserPromptSubmit 每轮都发 = 每轮都贵，且注入内容计入每轮上下文，
 *   随项目推进单调变贵。SessionStart 只在开局注入一次。
 *
 * 为什么不用 SendMessage 做常态广播：
 *   投递有 held / refused / dropped 三态，held 取决于对方的 permissionMode，
 *   而该字段不在 sessions/<pid>.json 里 —— 发送前静态不可判，dropped 是永久丢弃。
 *   SendMessage 只用于「用户原始需求显式要求的定向 handoff」，且必须检查投递结果；
 *   普通进度仅由 harvest 写入文件 checkpoint，不自动读取或注入。
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

const MAX_LINES = 10
const MAX_CHARS = 1500

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

  const sessionId = input.session_id || input.sessionId
  const cwd = input.cwd || process.cwd()
  if (!sessionId) return

  const progressDir = path.join(cwd, '.claude', 'progress')
  let files
  try {
    files = fs.readdirSync(progressDir).filter(f => f.endsWith('.jsonl'))
  } catch {
    return // 目录不存在 = 还没有任何会话写过进度
  }

  const markPath = path.join(os.tmpdir(), `wfpeer-${sha256(sessionId).slice(0, 16)}.json`)
  const mark = readJson(markPath) || {} // { '<peerSessionId>': <已读行数> }

  const fresh = []

  for (const f of files) {
    const peerId = f.replace(/\.jsonl$/, '')
    if (peerId === sessionId) continue // 跳过自己

    let lines
    try {
      lines = fs.readFileSync(path.join(progressDir, f), 'utf8').split('\n').filter(Boolean)
    } catch {
      continue
    }

    const seen = mark[peerId] || 0
    if (lines.length <= seen) continue

    for (const l of lines.slice(seen)) {
      try {
        const o = JSON.parse(l)
        fresh.push({ peer: peerId.slice(0, 8), ts: o.ts, summary: o.summary || o.workflowName || '(无摘要)', status: o.status })
      } catch {
        /* 跳过坏行 */
      }
    }
    mark[peerId] = lines.length
  }

  writeJson(markPath, mark)

  if (!fresh.length) return

  // 新的在前，硬性截断
  fresh.reverse()
  const shown = fresh.slice(0, MAX_LINES)
  let body = shown.map(x => `- [${x.peer}] ${x.summary}${x.status ? ` · ${x.status}` : ''}`).join('\n')
  if (body.length > MAX_CHARS) body = body.slice(0, MAX_CHARS) + '\n…（已截断）'

  const more = fresh.length > shown.length ? `\n（另有 ${fresh.length - shown.length} 条未显示）` : ''

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `本项目其他 Claude Code 会话的近期进度（手动启用的历史工具输出，仅供参考）：\n${body}${more}`,
      },
    })
  )
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(p, v) {
  try {
    fs.writeFileSync(p, JSON.stringify(v), 'utf8')
  } catch {
    /* ignore */
  }
}

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex')

try {
  main()
} catch {
  /* hook 绝不阻断会话 */
}
process.exit(0)
