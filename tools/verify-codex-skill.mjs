#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { install } from './install-codex-skill.mjs'
const require = createRequire(import.meta.url)
const { locate } = require('../codex-skills/workflow-bridge-controller/scripts/locate-runtime.cjs')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-codex-skill-'))
try {
  const first = install(path.join(temp, 'skills'))
  assert.equal(first.status, 'installed')
  assert.equal(install(path.join(temp, 'skills')).status, 'unchanged')
  const skillFile = path.join(first.target, 'SKILL.md')
  fs.appendFileSync(skillFile, '\nUser customization\n')
  const modified = fs.readFileSync(skillFile, 'utf8')
  assert.throws(() => install(path.join(temp, 'skills')), /未覆盖/)
  assert.equal(fs.readFileSync(skillFile, 'utf8'), modified)
  const plugin = path.join(temp, 'plugin 中文')
  for (const file of ['.claude-plugin/plugin.json', 'tools/session-bridge.mjs', 'docs/codex-controller.md', 'docs/claude-channel.md', 'skills/workflow-experience/references/session-bridge.md']) {
    fs.mkdirSync(path.dirname(path.join(plugin, file)), { recursive: true })
    fs.writeFileSync(path.join(plugin, file), file.endsWith('plugin.json') ? JSON.stringify({ name: 'workflow-experience', version: '0.5.3' }) : 'fixture')
  }
  assert.equal(locate({ WORKFLOW_BRIDGE_PLUGIN_ROOT: plugin }).pluginRoot, fs.realpathSync(plugin))
  const config = path.join(temp, 'claude'); fs.mkdirSync(path.join(config, 'plugins'), { recursive: true })
  const registry = path.join(config, 'plugins', 'installed_plugins.json')
  fs.writeFileSync(registry, JSON.stringify({ plugins: { 'workflow-experience@test': [{ scope: 'user', installPath: plugin }] } }))
  assert.equal(locate({ CLAUDE_CONFIG_DIR: config }).version, '0.5.3')
  fs.writeFileSync(registry, JSON.stringify({ plugins: { 'workflow-experience@test': [{ scope: 'user', installPath: plugin }, { scope: 'user', installPath: path.join(temp, 'other') }] } }))
  assert.throws(() => locate({ CLAUDE_CONFIG_DIR: config }), /2 个候选/)
  fs.writeFileSync(path.join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'workflow-experience', version: '0.5.2' }))
  assert.throws(() => locate({ WORKFLOW_BRIDGE_PLUGIN_ROOT: plugin }), /0.5.3/)
  assert.throws(() => locate({ WORKFLOW_BRIDGE_PLUGIN_ROOT: 'relative' }), /绝对路径/)
  console.log('Codex Skill：安装、幂等、保留已有修改、运行时定位、歧义和旧版本拒绝均通过；未调用模型或发送消息。')
} finally {
  // Only the explicitly created test directory is removed.
  assert.equal(path.dirname(temp), fs.realpathSync(os.tmpdir()))
  fs.rmSync(temp, { recursive: true, force: true })
}
