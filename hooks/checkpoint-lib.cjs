#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const os = require('os')

const STATE_SCHEMA_VERSION = 1
const MAX_STATE_FILES = 50
const MAX_BACKFILL_RAW = 120

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex')
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex')
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
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

function cloneJson(v) {
  if (v == null) return v
  try {
    return JSON.parse(JSON.stringify(v))
  } catch {
    return null
  }
}

function firstString(...xs) {
  for (const x of xs) if (typeof x === 'string' && x.trim()) return x.trim()
  return null
}

function extractRunArgs(run) {
  const candidates = [
    run?.args,
    run?.workflowArgs,
    run?.input?.args,
    run?.request?.args,
    run?.options?.args,
  ]
  for (const x of candidates) if (x && typeof x === 'object' && !Array.isArray(x)) return x
  return {}
}

function rejectPlaceholder(s) {
  return !s || /<[^>]+>/.test(s)
}

function normalizeSlash(s) {
  return String(s || '').replace(/\\/g, '/')
}

function inferChangeDirFromPlan(plan) {
  const paths = []
  for (const e of plan?.openspecEdits ?? []) if (e?.path) paths.push(e.path)
  for (const p0 of paths) {
    const p = normalizeSlash(p0)
    const m = p.match(/^(.*?openspec\/changes\/[^/]+)(?:\/|$)/i)
    if (m && !rejectPlaceholder(m[1])) return m[1]
  }
  return null
}

function inferChangeDirFromScript(script, cwd) {
  if (typeof script !== 'string') return null
  const normalized = normalizeSlash(script)
  const matches = normalized.match(/openspec\/changes\/[^/'"`\s<>]+/gi) || []
  for (const m of matches) {
    if (rejectPlaceholder(m)) continue
    return path.resolve(cwd, m)
  }
  return null
}

function resolveProjectPath(cwd, p) {
  if (!p) return null
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p)
}

function storedPath(cwd, p) {
  const abs = resolveProjectPath(cwd, p)
  if (!abs) return null
  const rel = path.relative(cwd, abs)
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return normalizeSlash(rel || '.')
  return normalizeSlash(abs)
}

function resolveStoredPath(cwd, p) {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p)
}

function isUnderDir(abs, dirAbs) {
  const rel = path.relative(dirAbs, abs)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function walkMarkdown(root, out = []) {
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(root, e.name)
    if (e.isDirectory()) walkMarkdown(p, out)
    else if (e.isFile() && /\.md$/i.test(e.name)) out.push(p)
  }
  return out
}

function fileEntry(cwd, p) {
  const abs = resolveStoredPath(cwd, p)
  const key = storedPath(cwd, abs)
  try {
    const st = fs.statSync(abs)
    if (!st.isFile()) return { path: key, sha256: null, size: null, missing: true }
    const body = fs.readFileSync(abs)
    return { path: key, sha256: sha256(body), size: st.size, missing: false }
  } catch {
    return { path: key, sha256: null, size: null, missing: true }
  }
}

function digestEntries(entries) {
  return sha256(entries.map(e => `${e.path}\0${e.sha256 ?? 'MISSING'}\0${e.size ?? ''}`).join('\n'))
}

function fingerprintExactFiles(cwd, paths) {
  const uniq = [...new Set((paths || []).filter(Boolean).map(p => storedPath(cwd, p)).filter(Boolean))].sort()
  const files = uniq.map(p => fileEntry(cwd, p))
  return { kind: 'exact-files', digest: digestEntries(files), files }
}

function fingerprintMarkdownTree(cwd, roots) {
  const storedRoots = [...new Set((roots || []).filter(Boolean).map(p => storedPath(cwd, p)).filter(Boolean))].sort()
  const absFiles = []
  for (const r of storedRoots) walkMarkdown(resolveStoredPath(cwd, r), absFiles)
  const files = [...new Set(absFiles.map(p => storedPath(cwd, p)))].sort().map(p => fileEntry(cwd, p))
  return { kind: 'markdown-tree', roots: storedRoots, digest: digestEntries(files), files }
}

function diffFingerprint(oldFp, newFp) {
  const oldMap = new Map((oldFp?.files || []).map(e => [e.path, e.sha256]))
  const newMap = new Map((newFp?.files || []).map(e => [e.path, e.sha256]))
  const keys = new Set([...oldMap.keys(), ...newMap.keys()])
  const changed = []
  for (const k of keys) if (oldMap.get(k) !== newMap.get(k)) changed.push(k)
  return changed.sort()
}

// resolver 热路径缓存：同一 changeDir 的 markdown tree / 同一代码文件只重算一次 hash。
// UserPromptSubmit hook 只有 5 秒预算，不能对每个候选 state 重复全量 hash。
function fingerprintMarkdownTreeCached(cwd, roots, cache) {
  if (!cache) return fingerprintMarkdownTree(cwd, roots)
  const key = [...(roots || [])].sort().join('\n')
  if (!cache.md.has(key)) cache.md.set(key, fingerprintMarkdownTree(cwd, roots))
  return cache.md.get(key)
}

function fingerprintExactFilesCached(cwd, paths, cache) {
  if (!cache) return fingerprintExactFiles(cwd, paths)
  const uniq = [...new Set((paths || []).filter(Boolean).map(p => storedPath(cwd, p)).filter(Boolean))].sort()
  const files = uniq.map(p => {
    if (!cache.file.has(p)) cache.file.set(p, fileEntry(cwd, p))
    return cache.file.get(p)
  })
  return { kind: 'exact-files', digest: digestEntries(files), files }
}

function validateState(cwd, state, cache = null) {
  if (state?.legacyUnverified) {
    return { valid: false, sourceValid: false, codeValid: false, legacyUnverified: true, changedPaths: ['<legacy-unverified>'] }
  }
  if (!state?.fingerprint) return { valid: false, sourceValid: false, codeValid: false, legacyUnverified: false, changedPaths: ['<missing-fingerprint>'] }
  const oldSource = state.fingerprint.source
  const oldExtra = state.fingerprint.sourceExtra
  const oldCode = state.fingerprint.code
  const sourceNow = fingerprintMarkdownTreeCached(cwd, oldSource?.roots || [], cache)
  const codeNow = fingerprintExactFilesCached(cwd, (oldCode?.files || []).map(e => e.path), cache)
  // sourceExtra：changeDir 之外的自定义 proposal/design/tasks/plan 文档（v0.4.1+）。
  // 旧 state 没有该字段时跳过，不因此判失效。
  let extraValid = true
  let extraChanged = []
  if (oldExtra) {
    const extraNow = fingerprintExactFilesCached(cwd, (oldExtra.files || []).map(e => e.path), cache)
    extraValid = oldExtra.digest === extraNow.digest
    extraChanged = diffFingerprint(oldExtra, extraNow)
  }
  const sourceValid = !!oldSource && oldSource.digest === sourceNow.digest && extraValid
  const codeValid = !!oldCode && oldCode.digest === codeNow.digest
  return {
    valid: sourceValid && codeValid,
    sourceValid,
    codeValid,
    legacyUnverified: false,
    changedPaths: [...new Set([
      ...diffFingerprint(oldSource, sourceNow),
      ...extraChanged,
      ...diffFingerprint(oldCode, codeNow),
    ])].sort(),
  }
}

// fingerprint 覆盖的不只是「将被修改」的文件：mustNotTouch / evidenceDependencies
// （caller、public contract、关键测试）变化同样会推翻 Plan/Review 的证据基础。
function collectPlanCodePaths(...plans) {
  const out = []
  for (const plan of plans) {
    for (const p of plan?.whitelist ?? []) out.push(p)
    for (const p of plan?.mustNotTouch ?? []) out.push(p)
    for (const p of plan?.evidenceDependencies ?? []) out.push(p)
    for (const s of plan?.slices ?? []) for (const p of s?.files ?? []) out.push(p)
  }
  return [...new Set(out.filter(p => typeof p === 'string' && p && !rejectPlaceholder(p)))]
}

function sanitizePlan(plan, specSyncDone) {
  const copy = cloneJson(plan)
  if (!copy) return null
  if (specSyncDone && Array.isArray(copy.openspecEdits)) copy.openspecEdits = []
  return copy
}

function inferCheckpoint(run, cwd) {
  const result = run?.result && typeof run.result === 'object' ? run.result : null
  if (!result) return null
  const runArgs = extractRunArgs(run)
  const cp = result.checkpoint && typeof result.checkpoint === 'object' ? result.checkpoint : {}
  const candidatePlan = result.effectivePlan || result.basePlan || result.plan || null
  if (!candidatePlan || !Array.isArray(candidatePlan.slices)) return null

  let changeDir = firstString(cp.changeDir, runArgs.changeDir, result.changeDir)
  if (!changeDir) changeDir = inferChangeDirFromPlan(candidatePlan)
  if (!changeDir) changeDir = inferChangeDirFromScript(run.script, cwd)
  if (!changeDir || rejectPlaceholder(changeDir)) return null

  const milestone = firstString(cp.milestone, result.milestone, runArgs.milestone) || 'default'
  const task = firstString(cp.task, result.task, runArgs.task) || ''
  const checkpointKey = firstString(cp.key, result.checkpointKey, runArgs.checkpointKey)
    || `${storedPath(cwd, changeDir)}::${milestone}`
  const cacheVersion = Number(cp.cacheVersion || result.cacheVersion || (candidatePlan.sourceMode?.startsWith?.('openspec') ? 1 : 0)) || 0
  if (cacheVersion < 1) return null

  return { result, runArgs, changeDir, milestone, task, checkpointKey, cacheVersion }
}

function statePathForKey(cwd, checkpointKey) {
  return path.join(cwd, 'docs', 'ultracode', 'state', `${sha256(checkpointKey).slice(0, 24)}.json`)
}

function buildStateFromRun({ run, cwd, sessionId = null, legacyUnverified = false }) {
  try {
    const inferred = inferCheckpoint(run, cwd)
    if (!inferred) return null
    const { result, runArgs, changeDir, milestone, task, checkpointKey, cacheVersion } = inferred
    const specSyncDone = result.specSync?.done === true
    const rawBasePlan = result.basePlan || (result.at === 'DecisionApply' ? result.plan : null) || result.plan || null
    const rawEffectivePlan = result.effectivePlan || result.plan || rawBasePlan
    if (!rawBasePlan || !rawEffectivePlan) return null

    const basePlan = sanitizePlan(rawBasePlan, specSyncDone)
    const effectivePlan = sanitizePlan(rawEffectivePlan, specSyncDone)
    const source = fingerprintMarkdownTree(cwd, [changeDir])
    // 项目自定义 proposal/design/tasks/plan 文档可能位于 changeDir 之外（args.*Doc 显式覆盖）；
    // 它们同样是 Plan 的证据基础，必须进入 fingerprint，否则改了也不会失效。
    const changeDirAbs = resolveProjectPath(cwd, changeDir)
    const extraSourceDocs = [...new Set(
      [runArgs.proposalDoc, runArgs.designDoc, runArgs.tasksDoc, runArgs.planDoc]
        .filter(p => typeof p === 'string' && p && !rejectPlaceholder(p))
        .map(p => resolveProjectPath(cwd, p))
        .filter(abs => abs && changeDirAbs && !isUnderDir(abs, changeDirAbs))
    )]
    const sourceExtra = extraSourceDocs.length ? fingerprintExactFiles(cwd, extraSourceDocs) : null
    const code = fingerprintExactFiles(cwd, collectPlanCodePaths(rawBasePlan, rawEffectivePlan))
    // resume 的 args 是全量替换不是合并：必须保存首轮完整 args，否则 native resume 时
    // 脚本回退 <占位> 默认值 → prompt/route/model 变化 → Plan 及以后粘滞 miss。
    // priorState/checkpointValidation 是恢复通道自身的载体，递归保存会让 state 逐代膨胀。
    const resumeArgs = cloneJson(runArgs) || {}
    delete resumeArgs.priorState
    delete resumeArgs.checkpointValidation
    // 实现已执行但 Verify 未绿（失败/escalate/中途 Stop）：fingerprint 对着 partial workspace
    // 计算，而 Reviewer 从未审过这份代码。标 dirty，禁止直接 Plan/Review ARTIFACT HIT。
    const reachedImplementation = !!(result.impl || result.verify || result.audit || result.commitResult
      || ['Implement', 'Verify', 'Audit', 'Commit'].includes(result.at))
    const dirtyWorktree = reachedImplementation && result.verify?.status !== 'green'
    const state = {
      schemaVersion: STATE_SCHEMA_VERSION,
      cacheVersion,
      kind: 'ultracode-semantic-state',
      checkpointKey,
      updatedAt: run.timestamp || new Date().toISOString(),
      runId: run.runId || null,
      sessionId: sessionId || run.sessionId || run.session_id || null,
      workflowName: run.workflowName || null,
      workflowStatus: run.status || result.status || null,
      scriptPath: run.scriptPath || null,
      scriptSha1: run.script ? sha1(run.script) : null,
      task,
      changeDir: storedPath(cwd, changeDir),
      milestone,
      resumeArgs,
      dirtyWorktree,
      reviewReusable: !dirtyWorktree,
      recon: cloneJson(result.recon),
      basePlan,
      effectivePlan,
      review: cloneJson(result.review),
      decisionApply: cloneJson(result.decisionApply) || { decisions: {} },
      routing: cloneJson(result.routing),
      patchRounds: result.patchRounds ?? 0,
      specSyncDone,
      legacyUnverified: !!legacyUnverified,
      appliedOpenSpecEdits: specSyncDone ? cloneJson(rawEffectivePlan.openspecEdits || []) : [],
      fingerprint: { source, sourceExtra, code },
    }

    const statePath = statePathForKey(cwd, checkpointKey)
    if (!writeJson(statePath, state)) return null
    return { statePath, state }
  } catch {
    return null
  }
}

function findSessionForRun(cwd, runId) {
  if (!runId) return null
  const progressDir = path.join(cwd, '.claude', 'progress')
  let files
  try {
    files = fs.readdirSync(progressDir).filter(f => f.endsWith('.jsonl')).slice(-200)
  } catch {
    return null
  }
  for (const f of files) {
    let body
    try { body = fs.readFileSync(path.join(progressDir, f), 'utf8') } catch { continue }
    if (!body.includes(runId)) continue
    for (const line of body.split('\n')) {
      if (!line.includes(runId)) continue
      try {
        const row = JSON.parse(line)
        if (row.runId === runId) return row.sessionId || f.replace(/\.jsonl$/, '')
      } catch { /* next */ }
    }
  }
  return null
}

function backfillStates(cwd) {
  const rawDir = path.join(cwd, 'docs', 'ultracode', 'raw')
  let files
  try {
    files = fs.readdirSync(rawDir)
      .filter(f => /^wf_.*\.json$/.test(f))
      .map(f => ({ f, mtime: fs.statSync(path.join(rawDir, f)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime)
      .slice(-MAX_BACKFILL_RAW)
  } catch {
    return 0
  }
  let built = 0
  for (const x of files) {
    const run = readJson(path.join(rawDir, x.f))
    if (!run) continue
    const inferred = inferCheckpoint(run, cwd)
    if (!inferred) continue
    const existing = readJson(statePathForKey(cwd, inferred.checkpointKey))
    // 已有可信 v0.4 state 永远不能被旧 raw 降级覆盖。legacy state 也只接受时间更新的 raw，
    // 避免每个 Stop 都重写同一 state / 刷新 mtime 干扰候选排序。
    if (existing && !existing.legacyUnverified) continue
    if (existing?.updatedAt && run.timestamp) {
      const oldTs = Date.parse(existing.updatedAt)
      const runTs = Date.parse(run.timestamp)
      if (Number.isFinite(oldTs) && Number.isFinite(runTs) && oldTs >= runTs) continue
    }
    const runId = run.runId || x.f.replace(/\.json$/, '')
    const sessionId = findSessionForRun(cwd, runId)
    // 旧 raw 没有生成当时的 fingerprint，绝不能用今天计算的 hash 冒充历史基线。
    // 这类 state 只可用于 native resume；否则必须先走廉价 CheckpointValidate。
    if (buildStateFromRun({ run, cwd, sessionId, legacyUnverified: true })) built++
  }
  return built
}

function tokenScore(requirement, state) {
  const q = String(requirement || '').toLowerCase()
  let score = 0
  const changeId = path.basename(normalizeSlash(state.changeDir || ''))
  if (changeId && q.includes(changeId.toLowerCase())) score += 20
  if (state.milestone && state.milestone !== 'default' && q.includes(String(state.milestone).toLowerCase())) score += 10
  const tokens = String(state.task || '').toLowerCase().match(/[a-z0-9_.-]{3,}|[\u4e00-\u9fff]{2,6}/g) || []
  for (const t of [...new Set(tokens)].slice(0, 20)) if (q.includes(t)) score += 1
  return score
}

function projectsDir() {
  // env 覆盖主要给测试用；生产默认 ~/.claude/projects
  return process.env.ULTRACODE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects')
}

// 原生 resume 的真正计算缓存是 journal.jsonl。session/script 匹配但 journal 缺失
// （插件重装、缓存清理、旧 session 数据残缺）时 resume 会静默返回空缓存然后全量重跑 ——
// 这种情况必须回落 Semantic Artifact Restore，而不是谎报 nativeResumeEligible。
function journalExists(sessionId, runId) {
  if (!sessionId || !runId) return false
  const projects = projectsDir()
  let dirs
  try {
    dirs = fs.readdirSync(projects, { withFileTypes: true })
  } catch {
    return false
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    try {
      if (fs.statSync(path.join(projects, d.name, sessionId, 'subagents', 'workflows', runId, 'journal.jsonl')).isFile()) return true
    } catch { /* next */ }
  }
  return false
}

function nativeResumeCheck(cwd, sessionId, state) {
  if (!sessionId || state.sessionId !== sessionId || !state.scriptPath || !state.scriptSha1 || !state.runId) return false
  const p = resolveProjectPath(cwd, state.scriptPath)
  try {
    if (sha1(fs.readFileSync(p, 'utf8')) !== state.scriptSha1) return false
  } catch {
    return false
  }
  return journalExists(sessionId, state.runId)
}

// v0.4.0 的 state 没有 dirtyWorktree 字段；用终态 status 兜底推断
// （实现后未 Verify green 即视为 dirty，宁可多走一次廉价 CheckpointValidate）。
const DIRTY_STATUSES = new Set(['red', 'needs-rework', 'commit-failed', 'escalate-to-human', 'unknown', 'failed', 'escalate'])
function stateDirtyWorktree(state) {
  if (state?.dirtyWorktree != null) return state.dirtyWorktree === true
  return DIRTY_STATUSES.has(state?.workflowStatus)
}

function resolveCheckpointCandidates({ cwd, sessionId = null, requirement = '', limit = 3 }) {
  const stateDir = path.join(cwd, 'docs', 'ultracode', 'state')
  let files
  try {
    files = fs.readdirSync(stateDir)
      .filter(f => f.endsWith('.json'))
      .map(f => ({ f, mtime: fs.statSync(path.join(stateDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_STATE_FILES)
  } catch {
    return []
  }

  // 先只读 JSON + tokenScore 排序，再对 top-N 做昂贵的 fingerprint 重算；
  // 同一 changeDir / 代码文件的 hash 在候选间 memoize。
  const scored = []
  for (const x of files) {
    const p = path.join(stateDir, x.f)
    const state = readJson(p)
    if (!state || state.kind !== 'ultracode-semantic-state' || state.schemaVersion !== STATE_SCHEMA_VERSION) continue
    scored.push({ p, state, mtime: x.mtime, score: tokenScore(requirement, state) })
  }
  scored.sort((a, b) => b.score - a.score || b.mtime - a.mtime)

  const cache = { md: new Map(), file: new Map() }
  return scored.slice(0, Math.max(1, Math.min(limit, 5))).map(({ p, state, mtime, score }) => {
    const dirty = stateDirtyWorktree(state)
    return {
      path: storedPath(cwd, p),
      checkpointKey: state.checkpointKey,
      changeDir: state.changeDir,
      milestone: state.milestone,
      task: state.task,
      status: state.workflowStatus,
      runId: state.runId,
      scriptPath: state.scriptPath,
      scriptSha1: state.scriptSha1,
      sessionId: state.sessionId,
      cacheVersion: state.cacheVersion,
      legacyUnverified: !!state.legacyUnverified,
      dirtyWorktree: dirty,
      reviewReusable: !dirty,
      validation: validateState(cwd, state, cache),
      nativeResumeEligible: nativeResumeCheck(cwd, sessionId, state),
      score,
      mtime,
    }
  })
}

module.exports = {
  STATE_SCHEMA_VERSION,
  buildStateFromRun,
  backfillStates,
  resolveCheckpointCandidates,
  validateState,
  journalExists,
}
