#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
function locate(env = process.env) {
  let root = env.WORKFLOW_BRIDGE_PLUGIN_ROOT
  let source = 'WORKFLOW_BRIDGE_PLUGIN_ROOT'
  if (!root) {
    const registry = path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'plugins', 'installed_plugins.json')
    const data = JSON.parse(fs.readFileSync(registry, 'utf8'))
    const candidates = Object.entries(data.plugins || {}).flatMap(([id, entries]) =>
      id.startsWith('workflow-experience@') && Array.isArray(entries)
        ? entries.filter(e => e.scope === 'user').map(e => e.installPath) : [])
    const unique = [...new Set(candidates)]
    if (unique.length !== 1) throw new Error(`需要唯一的用户级 workflow-experience 安装，当前 ${unique.length} 个候选；请核对安装或明确 WORKFLOW_BRIDGE_PLUGIN_ROOT`)
    root = unique[0]; source = registry
  }
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('运行时目录必须是明确的绝对路径')
  root = fs.realpathSync(root)
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'))
  const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(manifest.version || '')
  if (manifest.name !== 'workflow-experience' || !version || (+version[1] === 0 && (+version[2] < 5 || (+version[2] === 5 && +version[3] < 3)))) throw new Error('需要正式版本 0.5.3 或更新的 workflow-experience 运行时')
  const result = { pluginRoot: root, version: manifest.version, source,
    cli: path.join(root, 'tools', 'session-bridge.mjs'),
    controllerGuide: path.join(root, 'docs', 'codex-controller.md'),
    channelGuide: path.join(root, 'docs', 'claude-channel.md'),
    resultContract: path.join(root, 'skills', 'workflow-experience', 'references', 'session-bridge.md') }
  for (const key of ['cli', 'controllerGuide', 'channelGuide', 'resultContract']) {
    if (!fs.statSync(result[key]).isFile()) throw new Error(`运行时缺少 ${key}`)
  }
  return result
}
if (require.main === module) {
  try { console.log(JSON.stringify(locate(), null, 2)) }
  catch (e) { console.error(JSON.stringify({ error: 'bridge-runtime-unavailable', message: e.message })); process.exitCode = 1 }
}
module.exports = { locate }
