#!/usr/bin/env node
// codex-handoff.mjs — 从 codex rollout 提取「接力开发上下文包」
// 用法：
//   node codex-handoff.mjs <uuid|codex://threads/<uuid>|任意含 uuid 的文本> [--out <dir>] [--json] [--force-full] [--force-lite]
//   node codex-handoff.mjs --grep "关键词"      # 从 history.jsonl 反查 session_id
// 输出：<out>/codex-handoff-<uuid8>.md 与 <out>/codex-handoff-<uuid8>.json
// 硬约束：只读 ~/.codex，绝不写入；绝不 JSON.parse 巨型 CommandExecution 行。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const CODEX = path.join(os.homedir(), '.codex')
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/

// ---------- 预算旋钮 ----------
const B = {
  HEAD_TURNS: 6,        // 早期 task_complete 保留条数
  TAIL_TURNS: 16,       // 近期 task_complete 保留条数
  HEAD_CLIP: 220,       // 早期每条字符上限
  TAIL_CLIP: 700,       // 近期每条字符上限
  USER_CLIP: 300,       // 用户原话每条字符上限
  TOP_FILES: 60,        // 文件清单条数
  TOP_FAILS: 40,        // 失败签名条数
  FAIL_TAIL: 200,       // 失败输出尾部字符
  MAX_BYTES: 30 * 1024, // Markdown 目标上限
}
const DEGRADE = [       // 超预算时的降级阶梯
  { TAIL_TURNS: 14, TAIL_CLIP: 600, TOP_FILES: 50, TOP_FAILS: 30 },
  { TAIL_TURNS: 12, TAIL_CLIP: 550, TOP_FILES: 40, TOP_FAILS: 24 },
  { TAIL_TURNS: 10, TAIL_CLIP: 450, TOP_FILES: 30, TOP_FAILS: 18 },
]

// ---------- 参数 ----------
const argv = process.argv.slice(2)
const flag = n => argv.includes(n)
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const OUT_DIR = path.resolve(opt('--out', path.join(process.cwd(), '.codex-handoff')))
const WANT_JSON = flag('--json')
const FORCE_FULL = flag('--force-full')
const FORCE_LITE = flag('--force-lite')

function die(msg, extra) {
  console.error('[codex-handoff] ' + msg)
  if (extra) console.error(extra)
  process.exit(2)
}

// ---------- 1. uuid 解析（忽略 scheme） ----------
function grepHistory(kw) {
  const hp = path.join(CODEX, 'history.jsonl')
  if (!fs.existsSync(hp)) return []
  const hits = []
  for (const line of fs.readFileSync(hp, 'utf8').split('\n')) {
    if (!line || line.indexOf(kw) < 0) continue
    try { const o = JSON.parse(line); if (o.session_id) hits.push({ id: o.session_id, ts: o.ts, text: o.text }) } catch { }
  }
  return hits
}

let uuid = null
if (flag('--grep')) {
  const kw = opt('--grep', '')
  const hits = grepHistory(kw)
  if (!hits.length) die('history.jsonl 中未找到含「' + kw + '」的用户输入；请直接给 uuid。')
  hits.sort((a, b) => b.ts - a.ts)
  console.error('[codex-handoff] 命中候选（按时间倒序）：')
  for (const h of hits.slice(0, 10)) console.error('  ' + h.id + '  ' + String(h.text).slice(0, 60))
  uuid = hits[0].id
  console.error('[codex-handoff] 取最新：' + uuid)
} else {
  const raw = argv.filter(a => !a.startsWith('--')).join(' ')
  const m = raw.match(UUID_RE)
  if (!m) die('未能从输入中提取 uuid。支持 codex://threads/<uuid>、裸 uuid，或 --grep "关键词"。')
  uuid = m[0].toLowerCase()
}

// ---------- 2. 三级反查 rollout 路径 ----------
function stripLong(p) { return typeof p === 'string' ? p.replace(/^\\\\\?\\/, '') : p }

function fromSqlite(id) {
  const db = path.join(CODEX, 'state_5.sqlite')
  if (!fs.existsSync(db)) return null
  let d = null
  try {
    // readOnly 而非 immutable：codex 可能正在写，必须让 SQLite 应用 -wal
    d = new DatabaseSync(db, { readOnly: true })
    return d.prepare(
      'SELECT id, rollout_path, cwd, title, name, archived, created_at, updated_at, tokens_used, cli_version, git_branch, git_sha FROM threads WHERE id = ?'
    ).get(id) || null
  } catch (e) {
    console.error('[codex-handoff] sqlite 查询失败，回退 glob：' + e.message)
    return null
  } finally { try { if (d) d.close() } catch { } }
}

function globFallback(id) {
  const roots = [path.join(CODEX, 'sessions'), path.join(CODEX, 'archived_sessions')]
  const out = []
  const walk = dir => {
    let ents
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.jsonl') && e.name.includes(id)) out.push(p)
    }
  }
  for (const r of roots) if (fs.existsSync(r)) walk(r)
  return out
}

function fromSummaries(id) {
  const dir = path.join(CODEX, 'memories', 'rollout_summaries')
  if (!fs.existsSync(dir)) return null
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue
    let head
    try { head = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 1200) } catch { continue }
    if (head.includes(id)) {
      const m = head.match(/^rollout_path:\s*(.+)$/m)
      if (m) return stripLong(m[1].trim())
    }
  }
  return null
}

const t0 = process.hrtime.bigint()
const row = fromSqlite(uuid)
let rolloutPath = row ? stripLong(row.rollout_path) : null
let resolvedBy = row ? 'state_5.sqlite/threads' : null

if (!rolloutPath || !fs.existsSync(rolloutPath)) {
  const g = globFallback(uuid)
  if (g.length === 1) { rolloutPath = g[0]; resolvedBy = 'filename-glob' }
  else if (g.length > 1) {
    g.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    rolloutPath = g[0]; resolvedBy = 'filename-glob(' + g.length + ' 候选取最新)'
  } else {
    const s = fromSummaries(uuid)
    if (s && fs.existsSync(s)) { rolloutPath = s; resolvedBy = 'memories/rollout_summaries' }
  }
}
if (!rolloutPath || !fs.existsSync(rolloutPath)) {
  die('uuid ' + uuid + ' 三级反查全部失败（threads 表 / 文件名 glob / rollout_summaries）。',
    '可能原因：线程已被 codex delete；uuid 属于另一台机器；或 ~/.codex 路径被改写。')
}

const stat = fs.statSync(rolloutPath)
const archived = rolloutPath.includes('archived_sessions')

// ---------- 3. Triage ----------
const MB = stat.size / 1048576
let mode = MB >= 10 ? 'full' : 'lite'
if (FORCE_FULL) mode = 'full'
if (FORCE_LITE) mode = 'lite'

// ---------- 4. 流式单遍抽取 ----------
const S = {
  lines: 0, badJson: 0, skipped: 0,
  meta: null, cwd: row ? stripLong(row.cwd) : null,
  firstTs: null, lastTs: null,
  models: [], goals: [],
  userMsgs: [], turns: [], legacyAgentMsgs: [],
  files: new Map(),
  cmdTop: new Map(), mcpTop: new Map(),
  cmdCount: 0, cmdFail: 0, gitCommit: 0,
  fails: new Map(),
  compactions: 0, aborts: [],
}

const INJECT_RE = /^<[A-Za-z_][\w:-]{2,40}[\s>]/
// 旧格式把 AGENTS.md / environment_context 混在 role=user 的第一条里，不以 < 开头
const INJECT_EXTRA = /^#\s*AGENTS\.md|<environment_context>|<INSTRUCTIONS>/
function pushUser(ts, txt) {
  if (!txt) return
  const t = txt.trimStart()
  if (INJECT_RE.test(t) || INJECT_EXTRA.test(t)) return
  const c = clip(txt, B.USER_CLIP)
  // 同一条指令可能同时出现在 event_msg/user_message 与 response_item/message。
  // 只与「上一条」比对去重——相隔很远的同一句话（例如多次「继续」）必须各自保留。
  const last = S.userMsgs[S.userMsgs.length - 1]
  if (last && last.text === c) return
  S.userMsgs.push({ ts, text: c })
}
const clip = (s, n) => {
  s = String(s == null ? '' : s).replace(/\s*\n\s*/g, ' / ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}
const norm = p => String(p || '').replace(/\\/g, '/')
const unesc = s => s.replace(/\\n/g, ' ').replace(/\\r/g, '').replace(/\\t/g, ' ')
  .replace(/\\"/g, '"').replace(/\\\\/g, '\\')

function scanRawCommand(line) {
  // 巨型行（平均 27KB，最大数 MB）：绝不 JSON.parse，只取三个锚点
  S.cmdCount++
  const ei = line.lastIndexOf('"exit_code":')
  let code = 0
  if (ei > 0) {
    const m = line.slice(ei, ei + 32).match(/"exit_code":(-?\d+)/)
    if (m) code = Number(m[1])
  }
  let cmd = ''
  const pi = line.indexOf('"parsed_cmd":')
  if (pi > 0) {
    const m = line.slice(pi, pi + 1200).match(/"cmd":"((?:[^"\\]|\\.)*)"/)
    if (m) cmd = unesc(m[1])
  }
  const head = cmd.trim().split(/\s+/).slice(0, 2).join(' ')
  if (head) S.cmdTop.set(head, (S.cmdTop.get(head) || 0) + 1)
  if (/(^|[\s;|&(])git\s+commit\b/.test(cmd)) S.gitCommit++
  if (code !== 0) {
    S.cmdFail++
    // 取真实输出尾部。字段顺序固定：stdout, stderr, aggregated_output, exit_code。
    // 用「下一个字段名」做结束锚点——字段值内部的同名字面量必带反斜杠转义，不会误命中。
    const grab = (openTok, closeTok) => {
      const ki = line.indexOf(openTok)
      if (ki < 0) return ''
      const start = ki + openTok.length
      const end = closeTok === null ? (ei > start ? ei - 2 : -1) : line.indexOf(closeTok, start)
      if (end <= start) return ''
      return unesc(line.slice(Math.max(start, end - B.FAIL_TAIL * 4), end)).slice(-B.FAIL_TAIL)
    }
    const tail = grab('"aggregated_output":"', null)
      || grab('"stderr":"', '","aggregated_output":"')
      || grab('"stdout":"', '","stderr":"')
    const sig = (head || '(unparsed)') + ' → exit ' + code
    const cur = S.fails.get(sig)
    if (cur) cur.n++
    else S.fails.set(sig, { n: 1, code, cmd: clip(cmd, 120), sample: clip(tail, B.FAIL_TAIL) || '(无输出)' })
  }
}

function handleParsed(o) {
  const t = o.type, p = o.payload || {}, pt = p.type
  if (o.timestamp) { if (!S.firstTs) S.firstTs = o.timestamp; S.lastTs = o.timestamp }
  if (t === 'session_meta') {
    S.meta = { session_id: p.session_id, cwd: p.cwd, cli_version: p.cli_version, originator: p.originator, timestamp: p.timestamp }
    if (!S.cwd && p.cwd) S.cwd = stripLong(p.cwd)
    return
  }
  if (t === 'turn_context') {
    const eff = (p.collaboration_mode && p.collaboration_mode.settings && p.collaboration_mode.settings.reasoning_effort) || '?'
    const sig = (p.model || '?') + '/' + eff
    if (S.models[S.models.length - 1] !== sig) S.models.push(sig)
    if (!S.cwd && p.cwd) S.cwd = stripLong(p.cwd)
    return
  }
  if (t === 'compacted') { S.compactions++; return }
  if (t === 'response_item' && pt === 'message' && p.role === 'user') {
    pushUser(o.timestamp, (p.content || []).map(c => c.text || '').join('\n'))
    return
  }
  if (t !== 'event_msg') return
  if (pt === 'thread_goal_updated') {
    const g = p.goal || {}
    const sig = g.objective + '|' + g.status
    if (S.goals.length && S.goals[S.goals.length - 1].sig === sig) return
    S.goals.push({ sig, ts: o.timestamp, objective: clip(g.objective, 120), status: g.status })
    return
  }
  if (pt === 'turn_aborted') { S.aborts.push({ ts: o.timestamp, reason: p.reason, ms: p.duration_ms }); return }
  if (pt === 'task_complete') { S.turns.push({ ts: o.timestamp, msg: String(p.last_agent_message || '') }); return }
  // ---- 旧格式（约 2026-06 及更早的 rollout）兼容 ----
  if (pt === 'user_message') {                       // 旧格式的用户输入
    pushUser(o.timestamp, String(p.message || ''))
    return
  }
  if (pt === 'agent_message') {                      // 旧格式没有 task_complete，用它兜底
    if (p.message) S.legacyAgentMsgs.push({ ts: o.timestamp, msg: String(p.message) })
    return
  }
  if (pt === 'patch_apply_end') {                    // 旧格式的文件改动
    for (const k of Object.keys(p.changes || {})) {
      const key = norm(k)
      let e = S.files.get(key)
      if (!e) { e = { n: 0, types: new Set() }; S.files.set(key, e) }
      e.n++
      e.types.add('patch')
    }
    return
  }
  if (pt !== 'item_completed') return
  const it = p.item || {}
  if (it.type === 'FileChange') {
    for (const k of Object.keys(it.changes || {})) {
      const v = it.changes[k]
      const key = norm(k)
      let e = S.files.get(key)
      if (!e) { e = { n: 0, types: new Set() }; S.files.set(key, e) }
      e.n++
      e.types.add(v && v.type ? v.type : 'update')
    }
    return
  }
  if (it.type === 'McpToolCall') {
    const k = it.server + '/' + it.tool
    S.mcpTop.set(k, (S.mcpTop.get(k) || 0) + 1)
  }
}

// 头部前缀判别：90% 字节属于这些类型，直接丢弃，绝不解析
const DROP = [
  '"type":"custom_tool_call_output"', '"type":"reasoning"', '"type":"token_count"',
  '"type":"custom_tool_call"', '"type":"world_state"', '"type":"function_call"',
  '"type":"function_call_output"',
  // 不丢 agent_message：新格式的 response_item/agent_message 在 handleParsed 里天然被忽略，
  // 而旧格式（2026-06 及更早）的 event_msg/agent_message 是唯一的 agent 自述来源。
]

function consume(line) {
  if (!line) return
  S.lines++
  const head = line.length > 400 ? line.slice(0, 400) : line
  for (let i = 0; i < DROP.length; i++) {
    if (head.indexOf(DROP[i]) >= 0) { S.skipped++; return }
  }
  if (head.indexOf('"type":"CommandExecution"') >= 0) { scanRawCommand(line); return }
  if (line.length > 600000) { S.skipped++; return } // 异常巨行保护（compacted 最大 ~63KB）
  let o
  try { o = JSON.parse(line) } catch { S.badJson++; return }
  try { handleParsed(o) } catch { }
}

async function scan(file) {
  const rs = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 21 })
  let buf = ''
  for await (const chunk of rs) {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) { consume(buf.slice(0, i)); buf = buf.slice(i + 1) }
  }
  consume(buf)
}

await scan(rolloutPath)
// 旧格式没有 task_complete：用 agent_message 兜底充当「轮次自述」，并标注来源
const legacyTurns = S.turns.length === 0 && S.legacyAgentMsgs.length > 0
if (legacyTurns) S.turns = S.legacyAgentMsgs.map(m => ({ ts: m.ts, msg: m.msg }))
const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6

// ---------- 5. 渲染 ----------
const cwdN = norm(S.cwd || '')
const rel = p => (cwdN && p.startsWith(cwdN + '/')) ? p.slice(cwdN.length + 1) : p
const topN = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
const pct = (a, b) => b ? (a / b * 100).toFixed(1) : '0.0'

function renderLite() {
  const L = []
  L.push('# codex 交接包（lite） · ' + uuid)
  L.push('')
  L.push('- cwd: `' + (S.cwd || '(未知)') + '` · rollout: `' + rolloutPath + '` (' + MB.toFixed(1) + ' MiB, 定位 ' + resolvedBy + ')')
  L.push('- 时间跨度 ' + S.firstTs + ' → ' + S.lastTs + ' · 轮次 ' + S.turns.length + ' · 命令 ' + S.cmdCount + '（非零退出 ' + S.cmdFail + '） · git commit ' + S.gitCommit + ' 次')
  L.push('')
  L.push('## 用户原话（逐字 · 唯一不可重建的信息）')
  if (!S.userMsgs.length) L.push('- （无）')
  S.userMsgs.forEach((u, i) => L.push((i + 1) + '. ' + u.text))
  L.push('')
  L.push('## 最后 3 轮 agent 自述（未验证）')
  for (const t of S.turns.slice(-3)) L.push('- [' + t.ts + '] ' + (clip(t.msg, 600) || '**(空 — 该轮无收尾总结)**'))
  L.push('')
  L.push('## 改动文件（' + S.files.size + ' 个去重路径）')
  const fl = [...S.files.entries()].sort((a, b) => b[1].n - a[1].n)
  for (const [p, e] of fl.slice(0, 25)) L.push('- ' + e.n + 'x `' + rel(p) + '`')
  return L.join('\n')
}

function renderFull(b) {
  const L = []
  const lastEmpty = S.turns.length > 0 && !S.turns[S.turns.length - 1].msg.trim()
  L.push('# codex 交接包 · ' + uuid)
  L.push('')
  L.push('## 0. 机器事实（不可伪造 · 直接读自 rollout 字节）')
  L.push('- cwd: `' + (S.cwd || '(未知)') + '`')
  L.push('- rollout: `' + rolloutPath + '` — ' + MB.toFixed(1) + ' MiB / ' + S.lines + ' 行 / badJson ' + S.badJson + ' / 定位 ' + resolvedBy + (archived ? ' / 已归档' : ''))
  L.push('- 线程名: ' + (row ? String(row.name || row.title || '').replace(/\s+/g, ' ').slice(0, 80) : '(无 DB 行)') + ' · cli ' + ((row && row.cli_version) || (S.meta && S.meta.cli_version) || '?'))
  L.push('- 时间跨度: ' + S.firstTs + ' → ' + S.lastTs)
  L.push('- 模型轨迹: ' + (S.models.join(' → ') || '?'))
  L.push('- 完成轮次 ' + S.turns.length + ' · 中止 ' + S.aborts.length + ' · 上下文压缩 ' + S.compactions + ' 次')
  L.push('- 命令执行 ' + S.cmdCount + ' 次，非零退出 ' + S.cmdFail + ' 次（' + pct(S.cmdFail, S.cmdCount) + '%）')
  L.push('- **git commit 调用 ' + S.gitCommit + ' 次**' + (S.gitCommit === 0 ? ' — 零提交：全部改动悬在工作区。接力前必须先盘点，禁止任何 checkout / stash / clean / 切分支。' : ''))
  if (lastEmpty) L.push('- **最后一轮 last_agent_message 为空 —— 线程在一轮工作进行到一半时中断，无收尾总结。该轮完成度只能靠工作区 diff 判断。**')
  L.push('')
  L.push('## 1. 目标时间线（goal · 机器事实）')
  if (!S.goals.length) L.push('- （该线程未设置 /goal）')
  for (const g of S.goals) L.push('- [' + g.ts + '] **' + g.status + '** — ' + g.objective)
  L.push('')
  L.push('## 2. 用户原话逐字（' + S.userMsgs.length + ' 条 · 机器事实 · 唯一不可从工作区重建的信息）')
  if (!S.userMsgs.length) L.push('- （无）')
  S.userMsgs.forEach((u, i) => L.push((i + 1) + '. `' + u.ts + '` ' + u.text))
  L.push('')
  const fl = [...S.files.entries()].sort((a, b2) => b2[1].n - a[1].n)
  L.push('## 3. 改动文件（' + S.files.size + ' 个去重路径 · 机器事实 · 源自 FileChange，非 patch 文本正则）')
  for (const [p, e] of fl.slice(0, b.TOP_FILES)) L.push('- ' + e.n + 'x ' + [...e.types].join('+') + ' `' + rel(p) + '`')
  if (fl.length > b.TOP_FILES) L.push('- …另有 ' + (fl.length - b.TOP_FILES) + ' 个路径未列出（完整清单见同名 .json 的 files 字段）')
  const dirs = new Map()
  for (const [p] of fl) {
    const d = rel(p).split('/').slice(0, -1).join('/') || '.'
    dirs.set(d, (dirs.get(d) || 0) + 1)
  }
  L.push('')
  L.push('目录聚合（主战场）：' + topN(dirs, 8).map(x => '`' + x[0] + '` ' + x[1] + '个').join(' · '))
  L.push('')
  L.push('## 4. 工具画像（机器事实）')
  L.push('- 命令 top: ' + topN(S.cmdTop, 10).map(x => '`' + x[0] + '` ' + x[1]).join(' · '))
  L.push('- MCP top: ' + (S.mcpTop.size ? topN(S.mcpTop, 8).map(x => '`' + x[0] + '` ' + x[1]).join(' · ') : '（无）'))
  L.push('')
  const fa = [...S.fails.entries()].sort((a, b2) => b2[1].n - a[1].n)
  L.push('## 5. 失败签名（' + S.fails.size + ' 个唯一签名 / ' + S.cmdFail + ' 次非零退出 · 机器事实 · 记录「试过什么不行」）')
  for (const [sig, e] of fa.slice(0, b.TOP_FAILS)) L.push('- **' + e.n + 'x** `' + sig + '` — ' + (e.sample || '(无输出尾)'))
  if (fa.length > b.TOP_FAILS) L.push('- …另有 ' + (fa.length - b.TOP_FAILS) + ' 个签名未列出（见 .json 的 failureSignatures）')
  L.push('')
  L.push('## 6. 历史缺口（机器事实）')
  L.push('- 上下文压缩 ' + S.compactions + ' 次：原 agent 在本线程中遗忘过 ' + S.compactions + ' 次完整上下文，其后期「已完成」判断可能建立在已被截断的上下文之上。')
  L.push('  rollout 本身是 append-only 全量日志，**文件层面无缺口**；丢失的是 agent 的推理链（reasoning 全部 encrypted_content，永久不可读）。')
  L.push('  涉及早期决策时以仓库内 openspec/*/tasks.md 与 docs/handoff 为准，不要信任第 7 节的转述。')
  for (const a of S.aborts) L.push('- 轮次中止 [' + a.ts + '] reason=' + a.reason + ' 时长 ' + Math.round((a.ms || 0) / 1000) + 's —— 此处有被打断的未完成工作')
  L.push('')
  L.push('---')
  L.push('')
  L.push('## 7. AGENT 自述（未经验证 · 不得作为「已完成」的证据 · 共 ' + S.turns.length + ' 轮'
    + (legacyTurns ? ' · 旧格式 rollout：来源为 agent_message 而非 task_complete' : '') + '）')
  L.push('')
  L.push('> 以下全部是 codex 写给用户的话。其中的测试数字、「全绿」、「已完成」均为**自述**，')
  L.push('> 必须先按交叉验证协议逐条重跑核对；任一数字不符则整段降级为不可采信。')
  L.push('')
  const T = S.turns
  const headN = Math.min(b.HEAD_TURNS, T.length)
  const tailStart = Math.max(headN, T.length - b.TAIL_TURNS)
  T.slice(0, headN).forEach((t, i) => L.push('- T' + (i + 1) + ' `' + t.ts + '` ' + (clip(t.msg, b.HEAD_CLIP) || '(空)')))
  if (tailStart > headN) L.push('- …（中段 ' + (tailStart - headN) + ' 轮省略）…')
  T.slice(tailStart).forEach((t, i) => L.push('- T' + (tailStart + i + 1) + ' `' + t.ts + '` ' + (clip(t.msg, b.TAIL_CLIP) || '**(空 — 该轮无收尾总结)**')))
  L.push('')
  L.push('---')
  L.push('抽取口径：单遍流式扫描 ' + stat.size + ' 字节 / ' + S.lines + ' 行，耗时 ' + Math.round(elapsedMs) + ' ms，跳过 ' + S.skipped + ' 行，JSON 解析失败 ' + S.badJson + ' 行。')
  L.push('已丢弃：custom_tool_call_output / reasoning / token_count / world_state / function_call / agent_message / compacted.replacement_history / unified_diff。')
  L.push('未纳入：SubAgentActivity（哪个子 agent 负责哪一块，本包无法回答）。')
  return L.join('\n')
}

let md
let used = Object.assign({}, B)
if (mode === 'lite') md = renderLite()
else {
  md = renderFull(used)
  for (const step of DEGRADE) {
    if (Buffer.byteLength(md, 'utf8') <= B.MAX_BYTES) break
    used = Object.assign({}, used, step)
    md = renderFull(used)
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true })
const stem = path.join(OUT_DIR, 'codex-handoff-' + uuid.slice(0, 8))
fs.writeFileSync(stem + '.md', md, 'utf8')

const payload = {
  uuid, mode, rolloutPath, resolvedBy, archived,
  rolloutBytes: stat.size, lines: S.lines, skipped: S.skipped, badJson: S.badJson, elapsedMs: Math.round(elapsedMs),
  cwd: S.cwd, threadName: row ? (row.name || null) : null, cliVersion: (row && row.cli_version) || null,
  firstTs: S.firstTs, lastTs: S.lastTs, models: S.models,
  turnCount: S.turns.length, turnSource: legacyTurns ? 'agent_message(legacy)' : 'task_complete',
  aborts: S.aborts, compactions: S.compactions,
  commandCount: S.cmdCount, commandFailures: S.cmdFail, gitCommitCount: S.gitCommit,
  lastTurnEmpty: S.turns.length > 0 && !S.turns[S.turns.length - 1].msg.trim(),
  goals: S.goals.map(g => ({ ts: g.ts, objective: g.objective, status: g.status })),
  userDirectives: S.userMsgs,
  files: [...S.files.entries()].sort((a, b2) => b2[1].n - a[1].n)
    .map(x => ({ path: rel(x[0]), abs: x[0], touches: x[1].n, types: [...x[1].types] })),
  commandTop: topN(S.cmdTop, 20).map(x => ({ cmd: x[0], n: x[1] })),
  mcpTop: topN(S.mcpTop, 20).map(x => ({ tool: x[0], n: x[1] })),
  failureSignatures: [...S.fails.entries()].sort((a, b2) => b2[1].n - a[1].n)
    .map(x => ({ signature: x[0], n: x[1].n, exitCode: x[1].code, cmd: x[1].cmd, tail: x[1].sample })),
  markdownPath: stem + '.md',
  markdownBytes: Buffer.byteLength(md, 'utf8'),
  budgetUsed: used,
}
fs.writeFileSync(stem + '.json', JSON.stringify(payload, null, 2), 'utf8')

console.error('[codex-handoff] mode=' + mode + ' ' + MB.toFixed(1) + 'MiB/' + S.lines + '行 用时 ' + Math.round(elapsedMs) + 'ms')
console.error('[codex-handoff] md=' + stem + '.md (' + payload.markdownBytes + ' B)  json=' + stem + '.json')
if (WANT_JSON) process.stdout.write(JSON.stringify(payload))
else process.stdout.write(md)
