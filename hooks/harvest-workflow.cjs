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
 *
 * v0.4.3（拍板语义）：
 *   - 游标从 runId 去重改为 runId→四字段指纹（status+result.status+agentCount+totalTokens）：
 *     原生 resume 原地覆写同一 wf_*.json 后指纹必变 → 终态重收（根因 RC3）
 *   - raw 版本化：首轮 wf_x.json 永不覆写，续收写 wf_x.r2.json/.r3.json（保留早退证据）
 *   - index.jsonl append-only：同 runId 允许多行，entry 带 rawFile/resultStatus
 *   - 比对走公共路径：cursor.fps 缺失时读 rawDir 最新版本算 fp，绝不凭引擎 status 判一致
 *     （index entry 的 status 是引擎 completed/killed，两轮同为 completed 会假一致）
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { buildStateFromRun, backfillStates } = require('./checkpoint-lib.cjs')

const MAX_SCAN = 200 // 单次最多处理的 wf 文件数，防御性上限
const MAX_CURSOR = 500 // done/fps 游标上限，fps 与 done 同步淘汰

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

  // v2 游标：文件名带版本段,0.4.3 对旧 v1 游标天然全量重扫(按 fp 比对,不盲重收)。
  const cursorPath = path.join(os.tmpdir(), `wfharvest-v2-${sha256(sessionId).slice(0, 16)}.json`)
  const cursor = readJson(cursorPath) || { done: [], fps: {}, warned: {} }
  if (!cursor.fps || typeof cursor.fps !== 'object') cursor.fps = {}
  if (!cursor.warned || typeof cursor.warned !== 'object') cursor.warned = {}
  const done = new Set(Array.isArray(cursor.done) ? cursor.done : [])

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

  // v0.4：把旧 raw snapshot 尝试回填成 checkpoint 候选。
  // 旧 v0.3 raw 会标记 legacyUnverified：只能 native resume，或先走廉价 CheckpointValidate。
  backfillStates(cwd)

  let harvested = 0

  for (const f of files) {
    const runId = f.replace(/\.json$/, '')

    const run = readJson(path.join(runsDir, f))
    if (!run) continue

    // 用 status 判完成，不用 mtime —— 快照是终态一次性写入
    const status = run.status
    if (!status || status === 'running') continue

    // 四字段指纹(拍板 harvestFingerprint=A,不加 mtime):
    // resume 原地覆写后 result.status/agentCount/totalTokens 至少一项必变 → 重收。
    const fpNow = runFingerprint(run)
    // 公共路径比对(latestFeedback):cursor 无记录时读 rawDir 最新版本算 fp ——
    // v1→v2 迁移窗口(journal 已被 resume 覆写)与 fps 淘汰窗口都靠它兜底,
    // 绝不凭引擎 run.status 判一致(两轮同为 completed 会假一致漏收)。
    const fpRecorded = cursor.fps[runId] ?? fingerprintRawLatest(rawDir, runId)
    if (fpRecorded && fpRecorded === fpNow) {
      cursor.fps[runId] = fpNow
      done.add(runId)
      continue
    }

    try {
      fs.mkdirSync(rawDir, { recursive: true })
      // raw 版本化(拍板 rawWritePolicy=B):首轮永不覆写,续收写 .r2/.r3。
      const rawFile = nextRawFileName(rawDir, runId)
      fs.copyFileSync(path.join(runsDir, f), path.join(rawDir, rawFile))
      // raw 是不可变历史；state 是最新可恢复 Plan/Review checkpoint。当前 run 在 Stop 时刻
      // 直接建立可信 fingerprint；与历史 backfill 的 legacyUnverified 明确区分。
      // buildStateFromRun 内部对 cacheVersion<1 强制 legacyUnverified(live 通道同规则)。
      const built = buildStateFromRun({ run, cwd, sessionId })
      if (built?.skipped) {
        warnOnce(cursor, indexPath, `state-build-skipped:${runId}:${built.skipped}`, {
          warn: 'state-build-skipped',
          runId,
          reason: built.skipped,
          sessionId,
        })
      }

      const entry = {
        runId: run.runId || runId,
        ts: run.timestamp || null,
        workflowName: run.workflowName || null,
        status,
        resultStatus: run.result?.status ?? null,
        rawFile,
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

      cursor.fps[runId] = fpNow
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
      warnOnce(cursor, indexPath, 'snapshot-not-on-disk', {
        warn: 'snapshot-not-on-disk',
        note: 'workflows 目录为空，本地快照可能未落盘',
        sessionId,
      })
    } catch {
      /* ignore */
    }
  }

  // done/fps 同步淘汰(latestFeedback:fps 无界增长):只保留最近 MAX_CURSOR 个 runId。
  cursor.done = [...done].slice(-MAX_CURSOR)
  const kept = new Set(cursor.done)
  for (const k of Object.keys(cursor.fps)) if (!kept.has(k)) delete cursor.fps[k]
  writeJson(cursorPath, cursor)
}

// 四字段终态指纹:任何一项变化都代表 run 进入了新终态。
function runFingerprint(run) {
  return sha256([
    String(run?.status ?? ''),
    String(run?.result?.status ?? ''),
    String(run?.agentCount ?? ''),
    String(run?.totalTokens ?? ''),
  ].join('|'))
}

// rawDir 中某 runId 的最新版本文件名(wf_x.json 为 rev 1,.r2/.r3 依次)。
function latestRawFile(rawDir, runId) {
  let names
  try {
    names = fs.readdirSync(rawDir)
  } catch {
    return null
  }
  let best = null
  let bestRev = 0
  for (const n of names) {
    const m = n.match(new RegExp(`^${runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.r(\\d+))?\\.json$`))
    if (!m) continue
    const rev = m[1] ? Number(m[1]) : 1
    if (rev >= bestRev) { best = n; bestRev = rev }
  }
  return best
}

// 读取 rawDir 最新版本并算同口径指纹;不存在 → null(fp 未知 → 按已变化处理)。
function fingerprintRawLatest(rawDir, runId) {
  const latest = latestRawFile(rawDir, runId)
  if (!latest) return null
  const run = readJson(path.join(rawDir, latest))
  if (!run) return null
  return runFingerprint(run)
}

// 下一个版本文件名:首轮 wf_x.json 已存在则写 .r2/.r3(取最大序号+1),首轮永不覆写。
function nextRawFileName(rawDir, runId) {
  const latest = latestRawFile(rawDir, runId)
  if (!latest) return `${runId}.json`
  const m = latest.match(/\.r(\d+)\.json$/)
  const nextRev = m ? Number(m[1]) + 1 : 2
  return `${runId}.r${nextRev}.json`
}

// warn 防刷屏:同一 key 每个 cursor 生命周期只写一行(沿用 snapshot-not-on-disk 语义)。
function warnOnce(cursor, indexPath, key, row) {
  if (cursor.warned[key]) return
  try {
    fs.appendFileSync(indexPath, JSON.stringify(row) + '\n', 'utf8')
    cursor.warned[key] = true
  } catch {
    /* ignore */
  }
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
      resultStatus: entry.resultStatus ?? null,
      agentCount: entry.agentCount,
      summary: `${entry.workflowName || 'workflow'} → ${entry.status}${entry.resultStatus ? `(${entry.resultStatus})` : ''}（${entry.agentCount ?? '?'} agents）`,
    }
    fs.appendFileSync(path.join(progressDir, `${sessionId}.jsonl`), JSON.stringify(line) + '\n', 'utf8')
  } catch {
    /* ignore */
  }
}

/** 不自己实现 projectDir 编码规则，直接按 sessionId 目录名去找 */
function findWorkflowsDir(sessionId) {
  // env 覆盖主要给测试用（与 checkpoint-lib projectsDir 同款）；生产默认 ~/.claude/projects
  const projects = process.env.ULTRACODE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects')
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
