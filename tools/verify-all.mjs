#!/usr/bin/env node
// 单一离线验收入口：语法 + checkpoint + context fallback + effort routing。

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function scriptsBelow(relative) {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? scriptsBelow(`${relative}/${e.name}`) : /\.(?:cjs|mjs)$/.test(e.name) ? [`${relative}/${e.name}`] : [])
}
const syntaxFiles = [
  ...fs.readdirSync(path.join(root, 'hooks')).filter(f => f.endsWith('.cjs')).map(f => `hooks/${f}`),
  ...fs.readdirSync(path.join(root, 'templates')).filter(f => f.endsWith('.js')).map(f => `templates/${f}`),
  ...fs.readdirSync(path.join(root, 'tools')).filter(f => f.endsWith('.mjs') && f !== 'verify-all.mjs').map(f => `tools/${f}`),
  ...scriptsBelow('bridge'),
  ...scriptsBelow('tools/lib'),
  ...scriptsBelow('tools/fixtures/session-bridge'),
]

JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8'))
const skillLength = fs.readFileSync(path.join(root, 'skills/workflow-experience/SKILL.md'), 'utf8').length
if (skillLength > 7000) throw new Error(`SKILL.md 超过 7000 字符门禁: ${skillLength}`)

for (const relative of syntaxFiles) {
  execFileSync(process.execPath, ['--check', path.join(root, relative)], { stdio: 'inherit' })
}

for (const relative of [
  'tools/verify-state-pipeline.mjs',
  'tools/verify-model-fallback.mjs',
  'tools/verify-effort-routing.mjs',
  'tools/verify-workflow-repair.mjs',
  'tools/verify-session-bridge.mjs',
  'tools/verify-channel.mjs',
]) {
  console.log(`\n[verify-all] ${relative}`)
  execFileSync(process.execPath, [path.join(root, relative)], { stdio: 'inherit' })
}

console.log(`\n离线验收全部通过：manifest JSON + SKILL ${skillLength}/7000 字符 + ${syntaxFiles.length} 个语法检查 + 6 组行为验证`)
