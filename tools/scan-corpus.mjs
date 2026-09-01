#!/usr/bin/env node
/**
 * scan-corpus.mjs — 扫描历史 Ultracode 运行记录，产出 CSV 索引与统计
 *
 * 需求 2 的「优化」部分：用户拍板砍掉了自动闭环（hook 自改 skill 无人复核、
 * 且与 resume 缓存机制互斥），改为这个人工触发的分析工具。
 *
 * 用法：
 *   node tools/scan-corpus.mjs                    # 统计概览
 *   node tools/scan-corpus.mjs --csv out.csv      # 导出 CSV 索引
 *   node tools/scan-corpus.mjs --top 5            # 按 token 倒序看最贵的 N 个
 *   node tools/scan-corpus.mjs --failed           # 只看 killed/failed 的
 *   node tools/scan-corpus.mjs --root <dir>       # 指定扫描根目录
 *
 * 设计原则：只读、不联网、不调用模型。产出给人看，由人决定改什么。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const argv = process.argv.slice(2)
const flag = (name, def) => {
  const i = argv.indexOf(name)
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : def
}

const ROOT = flag('--root', path.join(os.homedir(), '.claude', 'projects'))
const CSV_OUT = flag('--csv', null)
const TOP = Number(flag('--top', 0)) || 0
const ONLY_FAILED = !!flag('--failed', false)

function walk(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/^wf_.*\.json$/.test(e.name)) out.push(p)
  }
  return out
}

const files = walk(ROOT)
const runs = []

for (const f of files) {
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    runs.push({
      runId: j.runId || path.basename(f, '.json'),
      ts: j.timestamp || '',
      name: j.workflowName || '',
      status: j.status || '',
      agents: j.agentCount ?? null,
      tokens: j.totalTokens ?? null,
      toolCalls: j.totalToolCalls ?? null,
      durationMs: j.durationMs ?? null,
      phases: Array.isArray(j.phases) ? j.phases.map(p => `${p.title}:${p.model ?? '-'}`).join('|') : '',
      scriptLen: j.script ? j.script.length : 0,
      scriptSha1: j.script ? crypto.createHash('sha1').update(j.script).digest('hex').slice(0, 12) : '',
      project: path.basename(path.dirname(path.dirname(path.dirname(f)))),
      file: f,
    })
  } catch {
    /* 跳过坏文件 */
  }
}

runs.sort((a, b) => (a.ts < b.ts ? 1 : -1))

const filtered = ONLY_FAILED ? runs.filter(r => r.status !== 'completed') : runs

// ---------- CSV 导出 ----------
if (CSV_OUT && typeof CSV_OUT === 'string') {
  const cols = ['runId', 'ts', 'name', 'status', 'agents', 'tokens', 'toolCalls', 'durationMs', 'phases', 'scriptLen', 'scriptSha1', 'project']
  const esc = v => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = [cols.join(','), ...filtered.map(r => cols.map(c => esc(r[c])).join(','))].join('\n')
  fs.writeFileSync(CSV_OUT, csv, 'utf8')
  console.log(`已导出 ${filtered.length} 行 → ${CSV_OUT}`)
}

// ---------- 统计 ----------
const num = xs => xs.filter(x => typeof x === 'number' && !Number.isNaN(x))
const pct = (xs, p) => {
  const s = num(xs).sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0
}

const byStatus = {}
for (const r of runs) byStatus[r.status || '(空)'] = (byStatus[r.status || '(空)'] || 0) + 1

const tokens = runs.map(r => r.tokens)
const agents = runs.map(r => r.agents)

console.log(`\n=== 语料概览（${ROOT}）===`)
console.log(`运行记录：${runs.length} 个`)
console.log(`状态分布：${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join('  ')}`)

const failedCount = runs.length - (byStatus.completed || 0)
const failRate = runs.length ? ((failedCount / runs.length) * 100).toFixed(1) : '0'
console.log(`★ 非 completed 占比：${failRate}%（${failedCount}/${runs.length}）← 这是本项目的核心指标`)

console.log(`\ntoken：中位 ${pct(tokens, 0.5).toLocaleString()}  p90 ${pct(tokens, 0.9).toLocaleString()}  max ${Math.max(...num(tokens), 0).toLocaleString()}`)
console.log(`agent 数：中位 ${pct(agents, 0.5)}  p90 ${pct(agents, 0.9)}  max ${Math.max(...num(agents), 0)}（警告线 25）`)

// 越线预警
const overLine = runs.filter(r => (r.agents ?? 0) >= 25)
if (overLine.length) {
  console.log(`\n⚠️ 越过 25 agent 警告线的 run：${overLine.length} 个`)
  for (const r of overLine.slice(0, 5)) console.log(`   ${r.name} · ${r.agents} agents · ${r.ts}`)
}

// ---------- 最贵的 N 个 ----------
if (TOP > 0) {
  const top = [...runs].sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0)).slice(0, TOP)
  console.log(`\n=== token 最贵的 ${TOP} 个 ===`)
  for (const r of top) {
    console.log(`${(r.tokens ?? 0).toLocaleString().padStart(10)}  ${r.status.padEnd(10)} ${r.name}`)
    console.log(`            ${r.phases}`)
    console.log(`            ${r.file}`)
  }
}

// ---------- 失败清单 ----------
if (ONLY_FAILED) {
  console.log(`\n=== 非 completed 的 run（${filtered.length} 个）===`)
  for (const r of filtered) {
    console.log(`${r.status.padEnd(10)} ${(r.tokens ?? 0).toLocaleString().padStart(10)}  ${r.name}  ${r.ts}`)
  }
  console.log('\n下一步：Read 上面 run 的 journal.jsonl，看它们停在哪个 phase、为什么。')
  console.log('反复失败的 phase 就是模板该改的地方。')
}

if (!CSV_OUT && !TOP && !ONLY_FAILED) {
  console.log('\n提示：--top 5 看最贵的 run，--failed 看失败清单，--csv out.csv 导出索引')
}
