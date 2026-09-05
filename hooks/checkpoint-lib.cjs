#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const os = require('os')

const STATE_SCHEMA_VERSION = 2
const MAX_STATE_FILES = 50
const MAX_BACKFILL_RAW = 120
const STATE_LOCK_STALE_MS = 30_000
const CONTINUATION_STATUSES = new Set([
  'need-decision',
  'route-escalation-required',
  'replan-required',
  'implementation-escalation-required',
])

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex')
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) out[key] = canonicalize(value[key])
  }
  return out
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value))
}

function writeJsonAtomic(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, p)
    return true
  } finally {
    try { fs.unlinkSync(tmp) } catch { /* already renamed */ }
  }
}

function acquireStateLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx')
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }))
      return fd
    } catch (error) {
      if (error?.code !== 'EEXIST') return null
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs <= STATE_LOCK_STALE_MS) return null
        fs.unlinkSync(lockPath)
      } catch {
        return null
      }
    }
  }
  return null
}

function releaseStateLock(lockPath, fd) {
  try { fs.closeSync(fd) } catch { /* best effort */ }
  try { fs.unlinkSync(lockPath) } catch { /* best effort */ }
}

// 纯 JS FNV-1a(32-bit):workflow 模板沙箱禁 require/crypto,
// nochg checkpointKey 的 task 摘要必须在模板与 hook 两侧用同一可复现弱 hash。
// 仅防同 repo 同 milestone 碰撞,不承担安全语义。
function fnv1aHex(s) {
  let h = 0x811c9dc5
  const str = String(s || '')
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return ('0000000' + h.toString(16)).slice(-8)
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

// Resume 可能只回传本轮覆盖项；普通字段后者优先，三类 map 按 key 合并。
// null 有明确语义（恢复调用点默认值），必须保留，不能用 truthy 过滤掉。
function mergeResumeArgs(base, next) {
  const left = cloneJson(base) || {}
  const right = cloneJson(next) || {}
  const merged = { ...left, ...right }
  for (const key of ['decisions', 'modelEfforts', 'phaseEfforts']) {
    const a = left[key] && typeof left[key] === 'object' && !Array.isArray(left[key]) ? left[key] : {}
    const b = right[key] && typeof right[key] === 'object' && !Array.isArray(right[key]) ? right[key] : {}
    if (Object.keys(a).length || Object.keys(b).length || key in left || key in right) merged[key] = { ...a, ...b }
  }
  return merged
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

function isDirectory(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

function isFile(p) {
  try { return fs.statSync(p).isFile() } catch { return false }
}

function inferProjectRoot(cwd, checkpoint, result, runArgs, changeDir) {
  const candidates = [
    ['checkpoint', checkpoint?.projectRoot],
    ['result', result?.projectRoot],
    ['args.projectRoot', runArgs?.projectRoot],
    ['args.repo', runArgs?.repo],
    ['args.worktree', runArgs?.worktree],
  ]
  for (const [source, value] of candidates) {
    if (typeof value !== 'string' || rejectPlaceholder(value)) continue
    const resolved = resolveProjectPath(cwd, value)
    if (isDirectory(resolved)) return { path: resolved, source }
  }
  const changeAbs = changeDir ? resolveProjectPath(cwd, changeDir) : null
  if (changeAbs) {
    const normalized = normalizeSlash(changeAbs)
    const marker = '/openspec/changes/'
    const i = normalized.toLowerCase().indexOf(marker)
    if (i > 0) {
      const inferred = path.normalize(normalized.slice(0, i))
      if (isDirectory(inferred)) return { path: inferred, source: 'changeDir' }
    }
  }
  return { path: path.resolve(cwd), source: 'cwd-fallback' }
}

function hasGlobMagic(p) {
  return /[*?{}[\]!]/.test(String(p || ''))
}

function resolveDependency(cwd, projectRoot, value) {
  if (typeof value !== 'string' || rejectPlaceholder(value)) return { unsupported: String(value || '') }
  if (hasGlobMagic(value) || /[\r\n]/.test(value)) return { unsupported: value }
  if (path.isAbsolute(value)) {
    const abs = path.normalize(value)
    if (!isUnderDir(abs, projectRoot)) return { unsupported: value }
    return isFile(abs) ? { abs } : { missing: storedPath(projectRoot, abs) }
  }
  // Array#map 会把 index/array 也传给回调；不能直接传 path.resolve，
  // 否则第二项会把数字 index 当作路径参数并抛 ERR_INVALID_ARG_TYPE。
  const roots = [...new Set([projectRoot, cwd].map(p => path.resolve(p)))]
  const matches = roots.map(root => path.resolve(root, value)).filter(isFile)
  const unique = [...new Set(matches.map(path.normalize))]
  if (unique.length > 1) return { ambiguous: value }
  if (unique.length === 1) return { abs: unique[0] }
  return { missing: normalizeSlash(value) }
}

function fingerprintPlanDependencies(cwd, projectRoot, paths) {
  const absFiles = []
  const missingDependencies = []
  const unsupportedDependencies = []
  const ambiguousDependencies = []
  for (const value of [...new Set((paths || []).filter(Boolean))]) {
    const resolved = resolveDependency(cwd, projectRoot, value)
    if (resolved.abs) absFiles.push(resolved.abs)
    else if (resolved.missing) missingDependencies.push(resolved.missing)
    else if (resolved.ambiguous) ambiguousDependencies.push(resolved.ambiguous)
    else unsupportedDependencies.push(resolved.unsupported)
  }
  const files = [...new Set(absFiles.map(p => storedPath(projectRoot, p)))].sort().map(p => fileEntry(projectRoot, p))
  return {
    kind: 'exact-files',
    digest: digestEntries(files),
    files,
    complete: missingDependencies.length === 0 && unsupportedDependencies.length === 0 && ambiguousDependencies.length === 0,
    missingDependencies: missingDependencies.sort(),
    unsupportedDependencies: unsupportedDependencies.sort(),
    ambiguousDependencies: ambiguousDependencies.sort(),
  }
}

function globRegex(pattern) {
  const normalized = normalizeSlash(pattern)
  let out = '^'
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]
    if (ch === '*' && normalized[i + 1] === '*') {
      const slash = normalized[i + 2] === '/'
      out += slash ? '(?:.*/)?' : '.*'
      i += slash ? 2 : 1
    } else if (ch === '*') out += '[^/]*'
    else if (ch === '?') out += '[^/]'
    else out += /[\\^$+?.()|]/.test(ch) ? `\\${ch}` : ch
  }
  return new RegExp(out + '$', process.platform === 'win32' ? 'i' : '')
}

function walkFiles(root, out = []) {
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const p = path.join(root, entry.name)
    if (entry.isDirectory()) walkFiles(p, out)
    else if (entry.isFile()) out.push(p)
  }
  return out
}

function resolveGlobPattern(cwd, projectRoot, pattern) {
  if (typeof pattern !== 'string' || rejectPlaceholder(pattern) || /[{}[\]!]/.test(pattern)) return null
  const resolved = path.isAbsolute(pattern) ? path.normalize(pattern) : path.resolve(projectRoot, pattern)
  const normalized = normalizeSlash(resolved)
  const magicAt = normalized.search(/[*?]/)
  const prefix = magicAt < 0 ? normalized : normalized.slice(0, magicAt)
  const anchor = path.resolve(prefix.endsWith('/') ? prefix : path.dirname(prefix))
  if (!isUnderDir(anchor, projectRoot)) return null
  return resolved
}

function fingerprintGlobFiles(cwd, projectRoot, patterns) {
  const resolvedPatterns = []
  const missingDependencies = []
  const unsupportedDependencies = []
  const absFiles = []
  for (const pattern of [...new Set((patterns || []).filter(Boolean))]) {
    const resolved = resolveGlobPattern(cwd, projectRoot, pattern)
    if (!resolved) { unsupportedDependencies.push(String(pattern)); continue }
    const normalized = normalizeSlash(resolved)
    const magicAt = normalized.search(/[*?]/)
    const prefix = magicAt < 0 ? normalized : normalized.slice(0, magicAt)
    const root = path.resolve(prefix.endsWith('/') ? prefix : path.dirname(prefix))
    if (!isDirectory(root)) { missingDependencies.push(String(pattern)); continue }
    const re = globRegex(normalized)
    const matches = walkFiles(root).filter(file => re.test(normalizeSlash(file)))
    if (!matches.length) missingDependencies.push(String(pattern))
    else absFiles.push(...matches)
    resolvedPatterns.push(normalized)
  }
  const files = [...new Set(absFiles.map(p => storedPath(projectRoot, p)))].sort().map(p => fileEntry(projectRoot, p))
  return {
    kind: 'glob-files',
    patterns: resolvedPatterns.sort(),
    digest: digestEntries(files),
    files,
    complete: missingDependencies.length === 0 && unsupportedDependencies.length === 0,
    missingDependencies: missingDependencies.sort(),
    unsupportedDependencies: unsupportedDependencies.sort(),
  }
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
  const missingDependencies = files.filter(e => e.missing).map(e => e.path)
  return { kind: 'exact-files', digest: digestEntries(files), files, complete: missingDependencies.length === 0, missingDependencies, unsupportedDependencies: [] }
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
  const key = `${path.resolve(cwd)}\0${[...(roots || [])].sort().join('\n')}`
  if (!cache.md.has(key)) cache.md.set(key, fingerprintMarkdownTree(cwd, roots))
  return cache.md.get(key)
}

function fingerprintExactFilesCached(cwd, paths, cache) {
  if (!cache) return fingerprintExactFiles(cwd, paths)
  const uniq = [...new Set((paths || []).filter(Boolean).map(p => storedPath(cwd, p)).filter(Boolean))].sort()
  const files = uniq.map(p => {
    const key = `${path.resolve(cwd)}\0${p}`
    if (!cache.file.has(key)) cache.file.set(key, fileEntry(cwd, p))
    return cache.file.get(key)
  })
  const missingDependencies = files.filter(e => e.missing).map(e => e.path)
  return { kind: 'exact-files', digest: digestEntries(files), files, complete: missingDependencies.length === 0, missingDependencies, unsupportedDependencies: [] }
}

function validateState(cwd, state, cache = null) {
  if (state?.legacyUnverified || state?.schemaVersion !== STATE_SCHEMA_VERSION) {
    return {
      valid: false,
      sourceValid: false,
      codeValid: false,
      dependencyComplete: false,
      legacyUnverified: true,
      changedPaths: [state?.legacyUnverified ? '<legacy-unverified>' : '<incompatible-schema>'],
    }
  }
  if (!state?.fingerprint) return { valid: false, sourceValid: false, codeValid: false, dependencyComplete: false, legacyUnverified: false, changedPaths: ['<missing-fingerprint>'] }
  const projectRoot = resolveStoredPath(cwd, state.projectRoot || '.')
  if (!isDirectory(projectRoot)) {
    return { valid: false, sourceValid: false, codeValid: false, dependencyComplete: false, legacyUnverified: false, changedPaths: ['<invalid-project-root>'] }
  }
  const oldSource = state.fingerprint.source
  const oldExtra = state.fingerprint.sourceExtra
  const oldGlob = state.fingerprint.sourceGlob
  const oldCode = state.fingerprint.code
  const codeNow = fingerprintExactFilesCached(projectRoot, (oldCode?.files || []).map(e => e.path), cache)
  const codeComplete = !oldCode || oldCode.complete === true
  const codeValid = codeComplete && (!oldCode || oldCode.digest === codeNow.digest)
  let extraValid = true
  let extraChanged = []
  if (oldExtra) {
    const extraNow = fingerprintExactFilesCached(projectRoot, (oldExtra.files || []).map(e => e.path), cache)
    extraValid = oldExtra.complete === true && oldExtra.digest === extraNow.digest
    extraChanged = diffFingerprint(oldExtra, extraNow)
  }
  let globValid = true
  let globChanged = []
  if (oldGlob) {
    const globNow = fingerprintGlobFiles(cwd, projectRoot, oldGlob.patterns || [])
    globValid = oldGlob.complete === true && globNow.complete === true && oldGlob.digest === globNow.digest
    globChanged = diffFingerprint(oldGlob, globNow)
  }
  const dependencyComplete = codeComplete && extraValid && globValid
  if (oldSource?.kind === 'none') {
    return {
      valid: false,
      sourceValid: false,
      codeValid,
      dependencyComplete,
      legacyUnverified: false,
      sourceKind: 'none',
      changedPaths: [...new Set([...diffFingerprint(oldCode, codeNow), ...extraChanged, ...globChanged])].sort(),
    }
  }
  const sourceNow = fingerprintMarkdownTreeCached(cwd, oldSource?.roots || [], cache)
  const sourceEmpty = (oldSource?.roots || []).length > 0 && (oldSource?.files || []).length === 0
  const sourceValid = !!oldSource && !sourceEmpty && oldSource.digest === sourceNow.digest && extraValid && globValid
  return {
    valid: sourceValid && codeValid && dependencyComplete,
    sourceValid,
    codeValid,
    dependencyComplete,
    legacyUnverified: false,
    changedPaths: [...new Set([
      ...diffFingerprint(oldSource, sourceNow),
      ...extraChanged,
      ...globChanged,
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

// cwd 下一级子目录探测(拍板 changeDirProbe=A):script 里写的 openspec/changes/<id>
// 在单层嵌套仓库(如 LDL_UGC 的 backend/)下真实位置是 <sub>/openspec/changes/<id>。
// 恰 1 个命中即用;≥2 命中 fail-closed 拒建(按 changeId 粒度判定,不做全仓递归 glob)。
function probeChangeDirSubdir(relChangeDir, cwd) {
  const hits = []
  let entries
  try {
    entries = fs.readdirSync(cwd, { withFileTypes: true })
  } catch {
    return { hit: null, ambiguous: false }
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const candidate = path.join(cwd, e.name, relChangeDir)
    try {
      if (fs.statSync(candidate).isDirectory()) hits.push(candidate)
    } catch { /* next */ }
  }
  if (hits.length === 1) return { hit: hits[0], ambiguous: false }
  if (hits.length > 1) return { hit: null, ambiguous: true }
  return { hit: null, ambiguous: false }
}

// 返回值统一为 { ok:true, ...inferred } | { ok:false, reason },
// reason 供 harvest 写 state-build-skipped warn 行(消灭静默 null)。
function inferCheckpoint(run, cwd) {
  const fail = reason => ({ ok: false, reason })
  const result = run?.result && typeof run.result === 'object' ? run.result : null
  if (!result) return fail('no-result')
  const runArgs = extractRunArgs(run)
  const cp = result.checkpoint && typeof result.checkpoint === 'object' ? result.checkpoint : {}
  const candidatePlan = result.effectivePlan || result.basePlan || result.plan || null
  // :251 门放宽:candidatePlan 存在时才要求 slices 数组;无 plan(planless run)放行,
  // 由 buildStateFromRun 置 basePlan/effectivePlan=null(服务于 native-resume 与取证可见)。
  if (candidatePlan && !Array.isArray(candidatePlan.slices)) return fail('no-slices')

  let changeDir = firstString(cp.changeDir, runArgs.changeDir, result.changeDir)
  if (!changeDir && candidatePlan) changeDir = inferChangeDirFromPlan(candidatePlan)
  if (!changeDir) {
    // script 正则级:先按原样 resolve 并验证存在性;不存在则走一级子目录探测。
    const script = run.script
    if (typeof script === 'string') {
      const normalized = normalizeSlash(script)
      const matches = normalized.match(/openspec\/changes\/[^/'"`\s<>]+/gi) || []
      for (const m of matches) {
        if (rejectPlaceholder(m)) continue
        const direct = path.resolve(cwd, m)
        try {
          if (fs.statSync(direct).isDirectory()) { changeDir = direct; break }
        } catch { /* not here */ }
        const probe = probeChangeDirSubdir(normalizeSlash(m), cwd)
        if (probe.ambiguous) return fail('ambiguous-change-dir')
        if (probe.hit) { changeDir = probe.hit; break }
      }
    }
  }
  if (changeDir && rejectPlaceholder(changeDir)) changeDir = null

  const milestone = firstString(cp.milestone, result.milestone, runArgs.milestone) || 'default'
  const task = firstString(cp.task, result.task, runArgs.task) || ''
  // changeDir=null 时不得退化为 "null::<milestone>"(同 repo 无 changeDir 同 milestone
  // 的 run 会共享 statePathForKey 互相踩踏 resumeArgs/scriptSha1)——混入 task 弱 hash,
  // 公式与 gitnexus-routed.js 模板侧 CHECKPOINT_META.key 推导一致(沙箱无 crypto,统一 fnv1a)。
  const checkpointKey = firstString(cp.key, result.checkpointKey, runArgs.checkpointKey)
    || (changeDir
      ? `${storedPath(cwd, changeDir)}::${milestone}`
      : `nochg:${fnv1aHex(task)}::${milestone}`)
  const cacheVersion = Number(cp.cacheVersion || result.cacheVersion || (candidatePlan?.sourceMode?.startsWith?.('openspec') ? 1 : 0)) || 0
  const projectRootInfo = inferProjectRoot(cwd, cp, result, runArgs, changeDir)
  const specsGlob = firstString(cp.specsGlob, result.specsGlob, runArgs.specsGlob)

  return {
    ok: true,
    result,
    runArgs,
    changeDir,
    milestone,
    task,
    checkpointKey,
    cacheVersion,
    projectRoot: projectRootInfo.path,
    projectRootSource: projectRootInfo.source,
    specsGlob,
    planless: !candidatePlan,
  }
}

function statePathForKey(cwd, checkpointKey) {
  return path.join(cwd, 'docs', 'ultracode', 'state', `${sha256(checkpointKey).slice(0, 24)}.json`)
}

function rawRevisionFromFile(file) {
  const match = String(file || '').match(/\.r(\d+)\.json$/)
  return match ? Number(match[1]) : 1
}

function terminalOutcome(runtimeStatus, resultStatus) {
  if (['green', 'success', 'passed', 'pushed', 'completed'].includes(resultStatus)) return 'success'
  if (['red', 'failed', 'commit-failed', 'needs-rework'].includes(resultStatus)) return 'failure'
  if (CONTINUATION_STATUSES.has(resultStatus) || ['blocked', 'escalate', 'escalate-to-human'].includes(resultStatus)) return 'action-required'
  if (['killed', 'cancelled'].includes(runtimeStatus)) return 'interrupted'
  return 'unknown'
}

function runStartedAtMs(run) {
  for (const value of [run?.startedAt, run?.startTime, run?.createdAt, run?.timestamp]) {
    const parsed = typeof value === 'number' ? value : Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function compareStateFreshness(existing, candidate) {
  if (!existing) return { accept: true }
  if (candidate.legacyUnverified && existing.legacyUnverified === false) return { accept: false, reason: 'trusted-state-exists' }
  if (existing.schemaVersion !== STATE_SCHEMA_VERSION && candidate.schemaVersion === STATE_SCHEMA_VERSION && !candidate.legacyUnverified) return { accept: true }
  if (existing.sourceRunId && existing.sourceRunId === candidate.sourceRunId) {
    const oldRevision = Number(existing.sourceRunRevision || 1)
    const newRevision = Number(candidate.sourceRunRevision || 1)
    if (newRevision < oldRevision) return { accept: false, reason: 'stale-state-update' }
    if (newRevision === oldRevision) {
      if (existing.sourceResultDigest === candidate.sourceResultDigest) return { accept: false, reason: 'state-unchanged', unchanged: true }
      return { accept: false, reason: 'ambiguous-state-freshness' }
    }
    return { accept: true, preserveResumeArgs: true }
  }
  const oldStarted = Number(existing.sourceStartedAtMs)
  const newStarted = Number(candidate.sourceStartedAtMs)
  if (!Number.isFinite(oldStarted) || !Number.isFinite(newStarted) || oldStarted === newStarted) {
    return { accept: false, reason: 'ambiguous-state-freshness' }
  }
  return newStarted > oldStarted ? { accept: true } : { accept: false, reason: 'stale-state-update' }
}

function writeStateFresh(statePath, candidate) {
  const lockPath = `${statePath}.lock`
  const fd = acquireStateLock(lockPath)
  if (fd == null) return { skipped: 'state-write-contended' }
  try {
    const existing = readJson(statePath)
    const freshness = compareStateFreshness(existing, candidate)
    if (!freshness.accept) {
      if (freshness.unchanged) return { statePath, state: existing, unchanged: true }
      return { skipped: freshness.reason }
    }
    if (freshness.preserveResumeArgs && existing?.resumeArgs) {
      candidate.resumeArgs = mergeResumeArgs(existing.resumeArgs, candidate.resumeArgs)
      candidate.effortPolicy = {
        modelEfforts: cloneJson(candidate.resumeArgs.modelEfforts) || {},
        phaseEfforts: cloneJson(candidate.resumeArgs.phaseEfforts) || {},
      }
    }
    candidate.stateRevision = Number(existing?.stateRevision || 0) + 1
    if (!writeJsonAtomic(statePath, candidate)) return { skipped: 'write-failed' }
    return { statePath, state: candidate }
  } catch {
    return { skipped: 'write-failed' }
  } finally {
    releaseStateLock(lockPath, fd)
  }
}

// 返回 { statePath, state } | { skipped: reason } —— 不再静默 null,
// 调用方(harvest/backfill)负责把 reason 落成 warn 行(失败可观测)。
function buildStateFromRun({ run, cwd, sessionId = null, legacyUnverified = false, rawRevision = 1, resultDigest = null }) {
  try {
    const inferred = inferCheckpoint(run, cwd)
    if (!inferred.ok) return { skipped: inferred.reason }
    const {
      result, runArgs, changeDir, milestone, task, checkpointKey, cacheVersion,
      projectRoot, projectRootSource, specsGlob,
    } = inferred
    const specSyncDone = result.specSync?.done === true
    const hasExplicitBase = Object.prototype.hasOwnProperty.call(result, 'basePlan')
    const hasExplicitEffective = Object.prototype.hasOwnProperty.call(result, 'effectivePlan')
    const legacyPlanFallback = result.basePlan || (result.at === 'DecisionApply' ? result.plan : null) || result.plan || null
    const rawBasePlan = hasExplicitBase ? result.basePlan : (cacheVersion >= 2 ? (result.at === 'DecisionApply' ? result.plan : null) : legacyPlanFallback)
    const rawEffectivePlan = hasExplicitEffective ? result.effectivePlan : (cacheVersion >= 2 ? rawBasePlan : (result.effectivePlan || result.plan || rawBasePlan))
    const candidatePlan = result.effectivePlan || result.basePlan || result.plan || null
    if (cacheVersion >= 2 && candidatePlan && !hasExplicitBase) return { skipped: 'missing-base-plan' }

    const basePlan = rawBasePlan ? sanitizePlan(rawBasePlan, specSyncDone) : null
    const effectivePlan = rawEffectivePlan ? sanitizePlan(rawEffectivePlan, specSyncDone) : null
    const source = changeDir
      ? fingerprintMarkdownTree(cwd, [changeDir])
      : { kind: 'none', roots: [], digest: null, files: [] }
    const sourceDocs = [runArgs.proposalDoc, runArgs.designDoc, runArgs.tasksDoc, runArgs.planDoc]
      .filter(p => typeof p === 'string' && p && !rejectPlaceholder(p))
    const sourceExtra = sourceDocs.length ? fingerprintPlanDependencies(cwd, projectRoot, sourceDocs) : null
    const sourceGlob = specsGlob ? fingerprintGlobFiles(cwd, projectRoot, [specsGlob]) : null
    const code = fingerprintPlanDependencies(cwd, projectRoot, collectPlanCodePaths(rawBasePlan, rawEffectivePlan))

    const resumeArgs = cloneJson(runArgs) || {}
    delete resumeArgs.priorState
    delete resumeArgs.checkpointValidation

    const resultStatus = result.status || null
    const runtimeStatus = run.status || null
    const outcome = terminalOutcome(runtimeStatus, resultStatus)
    const decisionApply = cloneJson(result.decisionApply) || { decisions: cloneJson(runArgs.decisions) || {} }
    if (!decisionApply.decisions) decisionApply.decisions = cloneJson(runArgs.decisions) || {}
    const continuationArgs = CONTINUATION_STATUSES.has(resultStatus) ? (cloneJson(result.nextArgs) || {}) : {}
    if (resultStatus === 'need-decision') {
      continuationArgs.decisions = {
        ...(cloneJson(runArgs.decisions) || {}),
        ...(cloneJson(decisionApply.decisions) || {}),
        ...(cloneJson(continuationArgs.decisions) || {}),
      }
    }
    const sourceResultDigest = resultDigest || sha256(stableStringify(result))
    const pendingTransition = CONTINUATION_STATUSES.has(resultStatus)
      ? { status: resultStatus, at: result.at || null, runId: run.runId || null, runRevision: Number(rawRevision || 1), resultDigest: sourceResultDigest }
      : null

    const reachedImplementation = !!(result.impl || result.verify || result.audit || result.commitResult
      || ['Implement', 'Verify', 'Audit', 'Commit'].includes(result.at))
    const auditRejected = result.audit && result.audit.verdict !== 'accept'
    const commitFailed = resultStatus === 'commit-failed' || (result.commitResult && result.commitResult.committed === false)
    const explicitDirty = result.dirtyWorktree === true || ['red', 'needs-rework', 'escalate-to-human', 'failed', 'escalate'].includes(resultStatus)
    const dirtyWorktree = explicitDirty || auditRejected || commitFailed || (reachedImplementation && result.verify?.status !== 'green')
    const legacy = legacyUnverified || cacheVersion < 2
    const reviewReusable = !legacy && !dirtyWorktree && result.review?.verdict === 'approve'
    const reviewInputCanonical = typeof result.reviewInputCanonical === 'string' ? result.reviewInputCanonical : null

    const statePath = statePathForKey(cwd, checkpointKey)
    const state = {
      schemaVersion: STATE_SCHEMA_VERSION,
      cacheVersion,
      kind: 'ultracode-semantic-state',
      templateKind: firstString(result.checkpoint?.kind, result.templateKind) || null,
      checkpointKey,
      updatedAt: run.timestamp || new Date().toISOString(),
      sourceRunId: run.runId || null,
      sourceRunRevision: Number(rawRevision || 1),
      sourceStartedAtMs: runStartedAtMs(run),
      sourceResultDigest,
      runId: run.runId || null,
      sessionId: sessionId || run.sessionId || run.session_id || null,
      workflowName: run.workflowName || null,
      runtimeStatus,
      resultStatus,
      terminalOutcome: outcome,
      workflowStatus: resultStatus || runtimeStatus,
      scriptPath: run.scriptPath || null,
      scriptSha1: run.script ? sha1(run.script) : null,
      task,
      workspaceRoot: '.',
      projectRoot: storedPath(cwd, projectRoot),
      projectRootSource,
      changeDir: changeDir ? storedPath(cwd, changeDir) : null,
      milestone,
      resumeArgs,
      effortPolicy: {
        modelEfforts: cloneJson(resumeArgs.modelEfforts) || {},
        phaseEfforts: cloneJson(resumeArgs.phaseEfforts) || {},
      },
      continuationArgs,
      pendingTransition,
      dirtyWorktree,
      reviewReusable,
      recon: cloneJson(result.recon),
      basePlan,
      effectivePlan,
      effectivePlanDigest: effectivePlan ? sha256(stableStringify(effectivePlan)) : null,
      reviewInputCanonical,
      reviewInputDigest: reviewInputCanonical ? sha256(reviewInputCanonical) : null,
      review: cloneJson(result.review),
      decisionApply,
      decisionPoints: cloneJson(result.decisionPoints) ?? null,
      questions: cloneJson(result.openQuestionsForUser ?? result.questions) ?? null,
      routing: cloneJson(result.routing),
      artifactCache: cloneJson(result.artifactCache),
      patchRounds: result.patchRounds ?? 0,
      specSyncDone,
      legacyUnverified: legacy,
      appliedOpenSpecEdits: specSyncDone ? cloneJson(result.appliedOpenSpecEdits || rawEffectivePlan?.openspecEdits || []) : [],
      fingerprint: {
        source,
        sourceExtra,
        sourceGlob,
        code,
        complete: code.complete === true && (!sourceExtra || sourceExtra.complete === true) && (!sourceGlob || sourceGlob.complete === true),
      },
    }

    return writeStateFresh(statePath, state)
  } catch {
    return { skipped: 'build-exception' }
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
      .map(f => ({ f, revision: rawRevisionFromFile(f), mtime: fs.statSync(path.join(rawDir, f)).mtimeMs }))
      .sort((a, b) => a.revision - b.revision || a.mtime - b.mtime)
      .slice(-MAX_BACKFILL_RAW)
  } catch {
    return 0
  }
  // .rN 版本化(harvest v2)后,同一 runId 可能有 wf_x.json / wf_x.r2.json 多个版本:
  // 按 runId(strip .rN 后缀)分组,每组只取 mtime 最新版本建档,替代脆弱的纯时间序守卫。
  const latestByRun = new Map()
  for (const x of files) {
    const runId = x.f.replace(/\.json$/, '').replace(/\.r\d+$/, '')
    const prev = latestByRun.get(runId)
    if (!prev || x.revision > prev.revision || (x.revision === prev.revision && x.mtime >= prev.mtime)) latestByRun.set(runId, { ...x, runId })
  }
  let built = 0
  for (const x of latestByRun.values()) {
    const run = readJson(path.join(rawDir, x.f))
    if (!run) continue
    const inferred = inferCheckpoint(run, cwd)
    if (!inferred.ok) continue
    const existing = readJson(statePathForKey(cwd, inferred.checkpointKey))
    // 已有可信 v0.4 state 永远不能被旧 raw 降级覆盖。legacy state 也只接受时间更新的 raw,
    // 避免每个 Stop 都重写同一 state / 刷新 mtime 干扰候选排序。
    if (existing && !existing.legacyUnverified) continue
    if (existing?.updatedAt && run.timestamp) {
      const oldTs = Date.parse(existing.updatedAt)
      const runTs = Date.parse(run.timestamp)
      if (Number.isFinite(oldTs) && Number.isFinite(runTs) && oldTs >= runTs) continue
    }
    const runId = run.runId || x.runId
    const sessionId = findSessionForRun(cwd, runId)
    // 旧 raw 没有生成当时的 fingerprint,绝不能用今天计算的 hash 冒充历史基线。
    // 这类 state 只可用于 native resume;否则必须先走廉价 CheckpointValidate。
    if (buildStateFromRun({ run, cwd, sessionId, legacyUnverified: true, rawRevision: x.revision }).state) built++
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
  return DIRTY_STATUSES.has(state?.resultStatus || state?.workflowStatus)
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
    if (!state || state.kind !== 'ultracode-semantic-state' || ![1, STATE_SCHEMA_VERSION].includes(state.schemaVersion)) continue
    scored.push({ p, state, mtime: x.mtime, score: tokenScore(requirement, state) })
  }
  scored.sort((a, b) => b.score - a.score || b.mtime - a.mtime)

  const cache = { md: new Map(), file: new Map() }
  return scored.slice(0, Math.max(1, Math.min(limit, 5))).map(({ p, state, mtime, score }) => {
    const dirty = stateDirtyWorktree(state)
    const contractCompatible = state.schemaVersion === STATE_SCHEMA_VERSION && state.cacheVersion === 2
    const validation = validateState(cwd, state, cache)
    return {
      path: storedPath(cwd, p),
      checkpointKey: state.checkpointKey,
      changeDir: state.changeDir,
      milestone: state.milestone,
      task: state.task,
      status: state.resultStatus || state.workflowStatus,
      runtimeStatus: state.runtimeStatus || null,
      resultStatus: state.resultStatus || null,
      terminalOutcome: state.terminalOutcome || null,
      runId: state.runId,
      scriptPath: state.scriptPath,
      scriptSha1: state.scriptSha1,
      sessionId: state.sessionId,
      schemaVersion: state.schemaVersion,
      cacheVersion: state.cacheVersion,
      templateKind: state.templateKind || null,
      contractCompatible,
      incompatibility: contractCompatible ? null : (state.schemaVersion !== STATE_SCHEMA_VERSION ? 'schema-version' : 'cache-version'),
      legacyUnverified: !!state.legacyUnverified || !contractCompatible,
      sourceKind: state.fingerprint?.source?.kind ?? 'none',
      dependencyComplete: validation.dependencyComplete ?? false,
      dirtyWorktree: dirty,
      reviewReusable: state.reviewReusable === true && !dirty,
      continuationArgs: state.pendingTransition ? (cloneJson(state.continuationArgs) || {}) : {},
      pendingTransition: cloneJson(state.pendingTransition),
      validation,
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
  // 供 harvest live 通道预判与 tools/verify-state-pipeline.mjs 干跑使用(latestFeedback:
  // inferCheckpoint 未导出时「live 强制 legacy」与「LDL_UGC backfill 干跑」均不可实现)。
  inferCheckpoint,
  fnv1aHex,
  rawRevisionFromFile,
  stableStringify,
  terminalOutcome,
  mergeResumeArgs,
  // 仅导出纯解析 helper，供离线边界夹具验证项目根/cwd 的唯一、歧义与越界语义。
  resolveDependency,
}
