#!/usr/bin/env node
// verify-state-pipeline.mjs — v0.4.3 语义缓存管道端到端检查(可提交,CI 友好)
// 覆盖:a) 可信建档 b) legacy 建档+防降级 c) changeDir 子目录探测命中
//      d) 多候选 fail-closed e) kind=none/planless 建档 f) harvest fp 续收/.r2 版本化
//      h) LDL_UGC 真实 raw backfill 干跑(只读;目录不存在时 SKIP)
// 夹具全部在 os.tmpdir() 动态创建再清理,不新增受版本控制的目录。
import { createRequire } from 'module'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'

const require = createRequire(import.meta.url)
const lib = require('../hooks/checkpoint-lib.cjs')

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const HARVEST = path.join(REPO_ROOT, 'hooks', 'harvest-workflow.cjs')

let failures = 0
function ok(cond, name, extra = '') {
  if (cond) console.log(`PASS ${name}`)
  else { failures++; console.error(`FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}
function skip(name, why) { console.log(`SKIP ${name} — ${why}`) }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-state-pipeline-'))
const cwd = tmp
process.env.ULTRACODE_PROJECTS_DIR = path.join(tmp, 'projects')

try {

// ---------- 脚手架 ----------
const changeDir = path.join(cwd, 'openspec/changes/test-change')
fs.mkdirSync(changeDir, { recursive: true })
fs.writeFileSync(path.join(changeDir, 'proposal.md'), '# proposal\n')
fs.mkdirSync(path.join(cwd, 'src'), { recursive: true })
fs.writeFileSync(path.join(cwd, 'src/a.ts'), 'export const a = 1\n')

const scriptV4 = 'const C = "openspec/changes/test-change"\nexport const meta = {}\n'
const scriptNoSpec = 'export const meta = {}\n// 无 openspec 引用的纯 gitnexus 链脚本\n'

function makePlan() {
  return {
    sourceMode: 'openspec-reuse',
    slices: [{ id: 's1', title: 't', sourceTaskIds: ['1'], files: ['src/a.ts'], rationale: 'r' }],
    whitelist: ['src/a.ts'], mustNotTouch: [], evidenceDependencies: [],
  }
}
let runSequence = 0
function makeRun(id, over = {}) {
  return {
    runId: id,
    timestamp: new Date(Date.UTC(2026, 8, 5, 0, 0, runSequence++)).toISOString(),
    script: scriptV4, scriptPath: path.join(cwd, 'wf.js'),
    status: 'completed', agentCount: 2, totalTokens: 1000,
    args: { task: `任务${id}`, milestone: 'M1', changeDir: 'openspec/changes/test-change', repo: cwd },
    result: {
      status: 'green',
      checkpoint: {
        key: `openspec/changes/test-change::M1`,
        kind: 'gitnexus-routed-v2',
        schemaVersion: 2,
        cacheVersion: 2,
        changeDir: 'openspec/changes/test-change',
        milestone: 'M1',
        task: `任务${id}`,
        projectRoot: cwd,
      },
      basePlan: makePlan(), effectivePlan: makePlan(),
      review: { verdict: 'approve' }, verify: { status: 'green' },
      ...(over.result || {}),
    },
    ...over,
  }
}
function statePathOf(key) {
  const crypto = require('crypto')
  return path.join(cwd, 'docs/ultracode/state', `${crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)}.json`)
}
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }

// ---------- a) 新契约 raw → 可信档 ----------
{
  const built = lib.buildStateFromRun({ run: makeRun('wf_a'), cwd, sessionId: 'sess-a' })
  ok(!!built.state && built.state.legacyUnverified === false && built.state.cacheVersion === 2, 'a1 v2 契约 → 可信档 legacy=false cacheVersion=2', built.skipped)
  ok(!!built.state && lib.validateState(cwd, built.state).valid === true, 'a2 可信档 validateState valid=true', built.skipped)
}

// ---------- b) 旧契约(cacheVersion=0)→ legacy 强制 + 防降级双向守卫 ----------
{
  // 旧契约 run:无 checkpoint meta 且 plan 无 sourceMode(三候选全落空 → cacheVersion=0)
  const noMetaPlan = () => ({ slices: [{ id: 's1', title: 't', files: ['src/a.ts'], rationale: 'r' }], whitelist: ['src/a.ts'], mustNotTouch: [] })
  const legacyRun = makeRun('wf_b1')
  delete legacyRun.result.checkpoint
  legacyRun.result.basePlan = noMetaPlan()
  legacyRun.result.effectivePlan = noMetaPlan()
  legacyRun.result.checkpointKey = 'openspec/changes/test-change::M1'
  const built = lib.buildStateFromRun({ run: legacyRun, cwd, sessionId: 'sess-a' })
  // 同 key 已有可信档(a 段所建)→ 防降级跳过
  ok(built.skipped === 'trusted-state-exists', 'b1 可信档存在时 legacy 建档被拒绝(双向防降级)')
  const otherKey = makeRun('wf_b2')
  delete otherKey.result.checkpoint
  otherKey.result.basePlan = noMetaPlan()
  otherKey.result.effectivePlan = noMetaPlan()
  otherKey.result.checkpointKey = 'openspec/changes/test-change::M-legacy'
  otherKey.result.milestone = 'M-legacy'
  const built2 = lib.buildStateFromRun({ run: otherKey, cwd, sessionId: 'sess-a' })
  ok(!!built2.state && built2.state.legacyUnverified === true && built2.state.cacheVersion === 0, 'b2 无 meta → cacheVersion=0 且 legacyUnverified=true(不伪造 1)')
  const v = lib.validateState(cwd, built2.state)
  ok(v.valid === false && v.legacyUnverified === true, 'b3 legacy 档 validateState 恒 invalid(只走 nativeResume/CheckpointValidate)')

  const v1Run = makeRun('wf_b3')
  v1Run.result.checkpoint = {
    ...v1Run.result.checkpoint,
    key: 'openspec/changes/test-change::M-v1',
    milestone: 'M-v1',
    cacheVersion: 1,
  }
  const built3 = lib.buildStateFromRun({ run: v1Run, cwd, sessionId: 'sess-a' })
  ok(!!built3.state && built3.state.cacheVersion === 1 && built3.state.legacyUnverified === true,
    'b4 v1 契约保持 legacy，不能直接可信复用', built3.skipped)
}

// ---------- c) changeDir 一级子目录探测:唯一命中建档 ----------
{
  const sub = path.join(cwd, 'backend', 'openspec/changes/nested-change')
  fs.mkdirSync(sub, { recursive: true })
  fs.writeFileSync(path.join(sub, 'proposal.md'), '# nested\n')
  const nestedRun = makeRun('wf_c')
  nestedRun.script = 'const C = "openspec/changes/nested-change"\n' // cwd 直下不存在,backend/ 下唯一命中
  nestedRun.args = { task: '嵌套任务C', milestone: 'MC' }
  nestedRun.result.checkpointKey = undefined
  delete nestedRun.result.checkpoint
  const inferred = lib.inferCheckpoint(nestedRun, cwd)
  ok(inferred.ok === true && /backend[\\/]openspec[\\/]changes[\\/]nested-change/.test(inferred.changeDir || ''), 'c1 一级子目录唯一命中 changeDir')
  const built = lib.buildStateFromRun({ run: nestedRun, cwd, sessionId: 'sess-a' })
  ok(!!built.state && built.state.changeDir && built.state.changeDir.includes('backend'), 'c2 命中后正常建档', built.skipped)
}

// ---------- d) 多候选 fail-closed 拒建 ----------
{
  fs.mkdirSync(path.join(cwd, 'ugc-backend', 'openspec/changes/dup-change'), { recursive: true })
  fs.mkdirSync(path.join(cwd, 'backend', 'openspec/changes/dup-change'), { recursive: true })
  const dupRun = makeRun('wf_d')
  dupRun.script = 'const C = "openspec/changes/dup-change"\n'
  dupRun.args = { task: '冲突任务D', milestone: 'MD' }
  delete dupRun.result.checkpoint
  const inferred = lib.inferCheckpoint(dupRun, cwd)
  ok(inferred.ok === false && inferred.reason === 'ambiguous-change-dir', 'd1 多候选 fail-closed(ambiguous-change-dir)')
}

// ---------- e) kind=none + planless 建档 + nochg key ----------
{
  const plainRun = makeRun('wf_e1')
  plainRun.script = scriptNoSpec
  plainRun.args = { task: '纯代码任务E', milestone: 'ME' }
  delete plainRun.result.checkpoint
  const built = lib.buildStateFromRun({ run: plainRun, cwd, sessionId: 'sess-a' })
  ok(!!built.state && built.state.fingerprint.source.kind === 'none', 'e1 无 openspec 引用 → kind=none 建档', built.skipped)
  ok(!!built.state && typeof built.state.checkpointKey === 'string' && built.state.checkpointKey.startsWith('nochg:') && !built.state.checkpointKey.startsWith('null::'), 'e2 checkpointKey=nochg:<taskhash>::ME(非 null::)', built.skipped)
  const v = built.state ? lib.validateState(cwd, built.state) : { valid: false, sourceValid: false }
  ok(v.valid === false && v.sourceValid === false, 'e3 kind=none validateState sourceValid 恒 false(永不 TRUSTED)')
  // planless run(result 无 plan): :251/:280 门放宽后仍可建档
  const planless = makeRun('wf_e2')
  planless.script = scriptNoSpec
  planless.args = { task: '无计划任务E2', milestone: 'ME2' }
  delete planless.result.checkpoint
  planless.result = { status: 'green', recon_summary: 'x', implement: { done: true }, verify: { status: 'green' } }
  const built2 = lib.buildStateFromRun({ run: planless, cwd, sessionId: 'sess-a' })
  ok(!!built2.state && built2.state.basePlan === null && built2.state.fingerprint.source.kind === 'none', 'e4 planless run 建档(basePlan=null)')
  const inferred2 = lib.inferCheckpoint(planless, cwd)
  ok(inferred2.ok === true, 'e5 planless run inferCheckpoint 放行(有 plan 但 slices 坏才拒)')
  const badPlan = makeRun('wf_e3')
  badPlan.script = scriptNoSpec
  badPlan.args = { task: '坏计划E3', milestone: 'ME3' }
  delete badPlan.result.checkpoint
  delete badPlan.result.basePlan
  delete badPlan.result.effectivePlan
  badPlan.result.plan = { verdict: 'implementable' } // 有 plan 但 slices 非数组
  const inferred3 = lib.inferCheckpoint(badPlan, cwd)
  ok(inferred3.ok === false && inferred3.reason === 'no-slices', 'e6 有 plan 但 slices 非数组 → 拒建(no-slices)')
}

// ---------- g) 相对依赖解析边界 ----------
{
  const projectRoot = path.join(cwd, 'dependency-project')
  const nestedCwd = path.join(projectRoot, 'packages/app')
  fs.mkdirSync(nestedCwd, { recursive: true })
  fs.writeFileSync(path.join(projectRoot, 'root-only.ts'), 'root\n')
  fs.writeFileSync(path.join(nestedCwd, 'cwd-only.ts'), 'cwd\n')
  fs.writeFileSync(path.join(projectRoot, 'duplicate.ts'), 'root duplicate\n')
  fs.writeFileSync(path.join(nestedCwd, 'duplicate.ts'), 'cwd duplicate\n')
  const outside = path.join(cwd, 'outside.ts')
  fs.writeFileSync(outside, 'outside\n')

  const same = lib.resolveDependency(projectRoot, projectRoot, 'root-only.ts')
  ok(same.abs === path.join(projectRoot, 'root-only.ts'), 'g1 cwd=projectRoot 时去重且唯一命中')
  const rootHit = lib.resolveDependency(nestedCwd, projectRoot, 'root-only.ts')
  ok(rootHit.abs === path.join(projectRoot, 'root-only.ts'), 'g2 cwd 不同时命中 projectRoot')
  const cwdHit = lib.resolveDependency(nestedCwd, projectRoot, 'cwd-only.ts')
  ok(cwdHit.abs === path.join(nestedCwd, 'cwd-only.ts'), 'g3 cwd 不同时命中当前 cwd')
  ok(lib.resolveDependency(nestedCwd, projectRoot, 'duplicate.ts').ambiguous === 'duplicate.ts', 'g4 双命中 fail-closed 为 ambiguous')
  ok(lib.resolveDependency(nestedCwd, projectRoot, 'missing.ts').missing === 'missing.ts', 'g5 缺失依赖保持 missing')
  ok(lib.resolveDependency(nestedCwd, projectRoot, outside).unsupported === outside, 'g6 项目外绝对路径保持 unsupported')
}

// ---------- f) harvest fp 续收:不变跳过 / 变化写 .r2 + index 两行 + state 覆盖 ----------
{
  const sess = `sess-f-${process.pid}-${path.basename(tmp)}`
  const wfDir = path.join(process.env.ULTRACODE_PROJECTS_DIR, 'projF', sess, 'workflows')
  fs.mkdirSync(wfDir, { recursive: true })
  const runV1 = makeRun('wf_f1')
  runV1.args.modelEfforts = { opus: 'max', sonnet: 'high' }
  runV1.args.phaseEfforts = { Review: 'high' }
  runV1.result.status = 'need-decision'
  runV1.result.verify = null
  fs.writeFileSync(path.join(wfDir, 'wf_f1.json'), JSON.stringify(runV1))
  const runHarvest = () => execFileSync(process.execPath, [HARVEST], {
    input: JSON.stringify({ session_id: sess, cwd }),
    env: { ...process.env, ULTRACODE_PROJECTS_DIR: process.env.ULTRACODE_PROJECTS_DIR },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  runHarvest()
  const rawDir = path.join(cwd, 'docs/ultracode/raw')
  ok(fs.existsSync(path.join(rawDir, 'wf_f1.json')), 'f1 首收写 wf_f1.json')
  const indexRows1 = fs.readFileSync(path.join(cwd, 'docs/ultracode/index.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  ok(indexRows1.filter(r => r.runId === 'wf_f1').length === 1, 'f2 首收 index 一行')
  ok(indexRows1[0].resultStatus === 'need-decision' && indexRows1[0].rawFile === 'wf_f1.json', 'f3 index 带 resultStatus/rawFile')
  // fp 不变 → 跳过(不重收、不制造伪 .r2)
  runHarvest()
  ok(!fs.existsSync(path.join(rawDir, 'wf_f1.r2.json')), 'f4 fp 不变 → 跳过,无伪 .r2')
  // resume 覆写(终态 green,tokens 变)→ 重收写 .r2 + index 追加 + state 覆盖
  const runV2 = makeRun('wf_f1')
  runV2.args = { phaseEfforts: { Review: 'xhigh', Implement: null } }
  runV2.result.status = 'green'
  runV2.totalTokens = 2500
  runV2.agentCount = 6
  fs.writeFileSync(path.join(wfDir, 'wf_f1.json'), JSON.stringify(runV2))
  runHarvest()
  ok(fs.existsSync(path.join(rawDir, 'wf_f1.r2.json')) && fs.existsSync(path.join(rawDir, 'wf_f1.json')), 'f5 fp 变化 → 写 wf_f1.r2.json 且首轮保留')
  const indexRows2 = fs.readFileSync(path.join(cwd, 'docs/ultracode/index.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const f1Rows = indexRows2.filter(r => r.runId === 'wf_f1' && r.rawFile)
  ok(f1Rows.length === 2, 'f6 重收 index 追加为两行(append-only)', `actual=${f1Rows.length}; rows=${JSON.stringify(f1Rows)}`)
  const st = readJson(statePathOf('openspec/changes/test-change::M1'))
  ok(st && st.workflowStatus === 'green' && st.runId === 'wf_f1', 'f7 state 被 resume 终态覆盖(只留最新)', JSON.stringify(st && { workflowStatus: st.workflowStatus, runId: st.runId, resultStatus: st.resultStatus, sourceRunRevision: st.sourceRunRevision }))
  ok(st?.resumeArgs?.modelEfforts?.opus === 'max' && st?.resumeArgs?.modelEfforts?.sonnet === 'high'
    && st?.resumeArgs?.phaseEfforts?.Review === 'xhigh' && st?.resumeArgs?.phaseEfforts?.Implement === null,
  'f8 resume 的 modelEfforts/phaseEfforts 按 key 合并并保留 null', JSON.stringify(st?.resumeArgs))
  // cursor v2 文件存在
  ok(fs.readdirSync(os.tmpdir()).some(f => f.startsWith('wfharvest-v2-')), 'f9 游标为 v2 命名')
}

// ---------- i) 纯 args merge：普通字段后者优先，嵌套覆盖不丢历史 ----------
{
  const merged = lib.mergeResumeArgs(
    { task: 'old', decisions: { a: 1 }, modelEfforts: { opus: 'max', sonnet: 'high' }, phaseEfforts: { Review: 'high' } },
    { task: 'new', decisions: { b: 2 }, phaseEfforts: { Review: 'xhigh', Implement: null } },
  )
  ok(merged.task === 'new' && merged.decisions.a === 1 && merged.decisions.b === 2,
    'i1 mergeResumeArgs 普通字段后者优先且 decisions 合并')
  ok(merged.modelEfforts.opus === 'max' && merged.modelEfforts.sonnet === 'high'
    && merged.phaseEfforts.Review === 'xhigh' && merged.phaseEfforts.Implement === null,
  'i2 mergeResumeArgs 保留模型覆盖并应用阶段增量/null')
}

// ---------- h) LDL_UGC 真实 raw backfill 干跑(只读) ----------
{
  const candidates = [
    'D:/AI/Website/LDL_UGC/docs/ultracode/raw',
    'D:/AI/Website/LDL_UGC/ugc-backend/docs/ultracode/raw',
  ]
  let surveyed = 0, buildable = 0
  const reasons = {}
  for (const rawRoot of candidates) {
    const projCwd = path.resolve(rawRoot, '../..')
    let files = []
    try { files = fs.readdirSync(rawRoot).filter(f => /^wf_.*\.json$/.test(f)) } catch { continue }
    for (const f of files) {
      const run = readJson(path.join(rawRoot, f))
      if (!run) continue
      surveyed++
      const inferred = lib.inferCheckpoint(run, projCwd)
      if (inferred.ok) buildable++
      else reasons[inferred.reason] = (reasons[inferred.reason] || 0) + 1
    }
  }
  if (!surveyed) skip('h1 LDL_UGC backfill 干跑', 'LDL_UGC raw 目录不存在')
  else {
    ok(buildable > 0, `h1 LDL_UGC 干跑:${surveyed} 份 raw 中 ${buildable} 份可建档`, JSON.stringify(reasons))
    ok(reasons['ambiguous-change-dir'] === undefined || buildable > 0, 'h2 不存在全部 ambiguous-change-dir 的异常', JSON.stringify(reasons))
    console.log(`   干跑明细:${JSON.stringify(reasons)}`)
  }
}

} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
