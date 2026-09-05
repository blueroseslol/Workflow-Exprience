#!/usr/bin/env node
// 离线验证 v0.4.5：Stop/harvest 精确识别 Haiku 上下文失败，阻止主会话停止并要求 Sonnet 恢复。
// 不联网、不调用模型；夹具只写 os.tmpdir()。

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const {
  classifyContextFailure,
  needsContextRecovery,
  phaseModelArg,
  summarizeModelFallback,
} = require('../hooks/harvest-workflow.cjs')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const harvest = path.join(root, 'hooks', 'harvest-workflow.cjs')
const templateExpectations = {
  'templates/four-phase.js': ['preflightModel', 'verifyModel'],
  'templates/gitnexus-routed.js': ['reconModel', 'preflightModel', 'verifyModel', 'commitModel'],
  'templates/openspec-incremental.js': ['reconModel', 'preflightModel', 'verifyModel', 'commitModel'],
  'templates/stage-with-gates.js': ['verifyModel'],
  'templates/readonly-recon.js': ['reconModel'],
}

for (const [relative, modelArgs] of Object.entries(templateExpectations)) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8')
  const executableAgentCalls = source
    .split(/\r?\n/)
    .filter(line => !line.trimStart().startsWith('//') && /\b(?:return|await) agent\s*\(/.test(line))
  assert.equal(executableAgentCalls.length, 1, `${relative}: 必须只有统一 wrapper 能直接调用 agent()`)
  assert.match(source, /disallowedTools:[\s\S]*'SendMessage'[\s\S]*'ListAgents'/, `${relative}: wrapper 安全门缺失`)
  for (const arg of modelArgs) assert.ok(source.includes(`args?.${arg}`), `${relative}: 缺少 ${arg} 覆盖`)
}

const contextRun = {
  runId: 'wf_context_test',
  status: 'killed',
  result: null,
  error: 'Error: Workflow aborted',
  logs: ['[recon:code] failed: Prompt is too long · automatic compaction failed: summarization produced empty response'],
  workflowProgress: [
    {
      type: 'workflow_agent', label: 'recon:code', phaseTitle: 'Recon', model: 'claude-haiku-4-5',
      state: 'error', error: 'Prompt is too long · automatic compaction failed: summarization produced empty response',
    },
  ],
}
const classified = classifyContextFailure(contextRun)
assert.equal(classified.detected, true)
assert.equal(classified.haikuLane, true)
assert.equal(classified.recommendedFallbackModel, 'sonnet')
assert.ok(classified.signatures.includes('compaction-empty-response'))
assert.equal(classified.agents.length, 1, 'progress/logs 的同一错误应去重')
assert.equal(needsContextRecovery(contextRun, classified, null), true)
assert.equal(phaseModelArg('Preflight'), 'preflightModel')
assert.equal(phaseModelArg('Commit'), 'commitModel')
assert.equal(phaseModelArg('Audit'), 'reviewModel')
assert.equal(needsContextRecovery({ ...contextRun, status: 'completed', result: { status: 'green' } }, classified, null), false)

const genericFailure = {
  status: 'failed', result: null, error: 'Workflow aborted', logs: ['[verify] failed: schema mismatch'],
  workflowProgress: [
    { type: 'workflow_agent', label: 'verify', model: 'claude-haiku-4-5', state: 'error', error: 'schema mismatch' },
  ],
}
assert.equal(classifyContextFailure(genericFailure), null, '普通 Haiku 失败不得误报为上下文错误')

const recoveredFallback = summarizeModelFallback({ logs: [
  '[model-fallback] event=attempt label=recon primary=haiku reason=haiku-null-unclassified fallback=sonnet',
  '[model-fallback] event=result label=recon outcome=recovered',
] })
assert.equal(needsContextRecovery(contextRun, classified, recoveredFallback), false, '已恢复的 run 不得再次续起')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-model-fallback-'))
try {
  const sessionId = `session-${process.pid}`
  const workflowDir = path.join(tmp, 'projects', 'project', sessionId, 'workflows')
  const cwd = path.join(tmp, 'workspace')
  fs.mkdirSync(workflowDir, { recursive: true })
  fs.mkdirSync(cwd, { recursive: true })
  fs.writeFileSync(path.join(workflowDir, 'wf_context_test.json'), JSON.stringify({
    ...contextRun,
    timestamp: new Date().toISOString(),
    taskId: 'task-test',
    workflowName: 'context-test',
    script: 'export const meta = {}',
    scriptPath: path.join(cwd, 'context-test.workflow.js'),
    agentCount: 1,
    totalTokens: 175000,
    totalToolCalls: 12,
    phases: [{ title: 'Recon', model: 'haiku' }],
  }))

  const env = { ...process.env, ULTRACODE_PROJECTS_DIR: path.join(tmp, 'projects') }
  const first = execFileSync(process.execPath, [harvest], {
    input: JSON.stringify({ session_id: sessionId, cwd, stop_hook_active: false }), env, encoding: 'utf8',
  })
  const decision = JSON.parse(first)
  assert.equal(decision.decision, 'block', '明确 Haiku 上下文失败必须阻止主会话停止')
  assert.match(decision.reason, /reconModel: "sonnet"/, '恢复指令必须给出单阶段 Sonnet override')
  assert.match(decision.reason, /resumeFromRunId/, '恢复指令必须优先原生 resume')

  const indexRows = fs.readFileSync(path.join(cwd, 'docs', 'ultracode', 'index.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map(line => JSON.parse(line))
  const runEntry = indexRows.find(row => row.runId === 'wf_context_test' && row.rawFile)
  assert.equal(runEntry.contextFailure.haikuLane, true)
  assert.equal(runEntry.contextRecoveryRecommended, true)

  const second = execFileSync(process.execPath, [harvest], {
    input: JSON.stringify({ session_id: sessionId, cwd, stop_hook_active: false }), env, encoding: 'utf8',
  })
  assert.equal(second, '', '同一终态不得重复触发恢复')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`context fallback 验证通过：${Object.keys(templateExpectations).length} 个模板 + Stop/harvest 恢复链`)
