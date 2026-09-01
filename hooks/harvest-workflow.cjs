#!/usr/bin/env node
/**
 * harvest-workflow.cjs — Stop hook
 *
 * 需求 2（前半）：把跑完的 workflow 运行记录固化到项目 docs/ultracode/
 * 需求 8（写入侧）：同时向 .claude/progress/<sessionId>.jsonl 追加一行进度
 *
 * 为什么是 Stop 而不是「workflow 完成事件」：
 *   CLI 没有 WorkflowComplete / PostWorkflow 这类事件（grep 全集为 0）。
 *   PostToolUse(Workflow) 拿到的 status 只有 async_launched，结果还没出来。
 *   所以只能在 Stop 时轮询 wf_*.json 的终态。
 *
 * 设计约束：
 *   - 纯文件搬运，不调用模型，不返回 additionalContext（Stop 的 additionalContext
 *     会让对话继续一整轮，固化应当是静默的）
 *   - 跨轮次游标：workflow 是后台任务，Stop 触发时文件可能还没落盘，要等几轮
 *   - 任何异常都静默 exit 0 —— hook 绝不能阻断用户的会话
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

const MAX_SCAN = 200 // 单次最多处理的 wf 文件数，防御性上限

function main() {
  let input = ''
  try {
    input = fs.readFileSync(0, 'utf8')
  } catch {
    return
  }

  let hookInput
  try {
    hookInput = JSON.parse(input)
  } catch {
    return
  }

  // 递归防护：必须是第一件事
  if (hookInput.stop_hook_active || hookInput.stopHookActive) return

  const sessionId = hookInput.session_id || hookInput.sessionId
  const cwd = hookInput.cwd || process.cwd()
  if (!sessionId) return

  const runsDir = findWorkflowsDir(sessionId)
  if (!runsDir) return

  const cursorPath = path.join(os.tmpdir(), `wfharvest-${sha256(sessionId).slice(0, 16)}.json`)
  const cursor = readJson(cursorPath) || { done: [] }
  const done = new Set(cursor.done)

  let files
  try {
    files = fs
      .readdirSync(runsDir)
      .filter(f => /^wf_.*\.json$/.test(f))
      .slice(0, MAX_SCAN)
  } catch {
    return
  }

  const docsDir = path.join(cwd, 'docs', 'ultracode')
  const rawDir = path.join(docsDir, 'raw')
  const indexPath = path.join(docsDir, 'index.jsonl')
  const progressDir = path.join(cwd, '.claude', 'progress')

  let harvested = 0

  for (const f of files) {
    const runId = f.replace(/\.json$/, '')
    if (done.has(runId)) continue

    const run = readJson(path.join(runsDir, f))
    if (!run) continue

    // 用 status 判完成，不用 mtime —— 快照是终态一次性写入
    const status = run.status
    if (!status || status === 'running') continue

    try {
      fs.mkdirSync(rawDir, { recursive: true })
      fs.copyFileSync(path.join(runsDir, f), path.join(rawDir, f))

      const entry = {
        runId: run.runId || runId,
        ts: run.timestamp || null,
        workflowName: run.workflowName || null,
        status,
        agentCount: run.agentCount ?? null,
        totalTokens: run.totalTokens ?? null,
        totalToolCalls: run.totalToolCalls ?? null,
        durationMs: run.durationMs ?? null,
        phases: Array.isArray(run.phases)
          ? run.phases.map(p => ({ title: p.title, model: p.model ?? null }))
          : null,
        scriptSha1: run.script ? sha1(run.script) : null,
        scriptPath: run.scriptPath || null,
      }
      fs.appendFileSync(indexPath, JSON.stringify(entry) + '\n', 'utf8')

      // 需求 8 写入侧：同一次 hook 调用顺带写进度，省一次 hook
      appendProgress(progressDir, sessionId, entry)

      done.add(runId)
      harvested++
    } catch {
      // 单个文件失败不影响其余
    }
  }

  // storageV5 静默失效检测：本轮明明有 workflow 但一个都没捞到
  if (harvested === 0 && files.length === 0) {
    try {
      fs.mkdirSync(docsDir, { recursive: true })
      const warnKey = 'snapshot-not-on-disk'
      if (!cursor.warned || cursor.warned !== warnKey) {
        fs.appendFileSync(
          indexPath,
          JSON.stringify({ warn: warnKey, note: 'workflows 目录为空，本地快照可能未落盘', sessionId }) + '\n',
          'utf8'
        )
        cursor.warned = warnKey
      }
    } catch {
      /* ignore */
    }
  }

  cursor.done = [...done].slice(-500) // 只保留最近 500 个，防止游标无限增长
  writeJson(cursorPath, cursor)
}

function appendProgress(progressDir, sessionId, entry) {
  try {
    fs.mkdirSync(progressDir, { recursive: true })
    const line = {
      ts: entry.ts,
      sessionId,
      runId: entry.runId,
      workflowName: entry.workflowName,
      status: entry.status,
      agentCount: entry.agentCount,
      summary: `${entry.workflowName || 'workflow'} → ${entry.status}（${entry.agentCount ?? '?'} agents）`,
    }
    fs.appendFileSync(path.join(progressDir, `${sessionId}.jsonl`), JSON.stringify(line) + '\n', 'utf8')
  } catch {
    /* ignore */
  }
}

/** 不自己实现 projectDir 编码规则，直接按 sessionId 目录名去找 */
function findWorkflowsDir(sessionId) {
  const projects = path.join(os.homedir(), '.claude', 'projects')
  let dirs
  try {
    dirs = fs.readdirSync(projects, { withFileTypes: true }).filter(d => d.isDirectory())
  } catch {
    return null
  }
  for (const d of dirs) {
    const p = path.join(projects, d.name, sessionId, 'workflows')
    try {
      if (fs.statSync(p).isDirectory()) return p
    } catch {
      /* next */
    }
  }
  return null
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

const sha1 = s => crypto.createHash('sha1').update(s).digest('hex')
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex')

try {
  main()
} catch {
  /* hook 绝不阻断会话 */
}
process.exit(0)
