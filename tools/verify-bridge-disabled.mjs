#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const env = { ...process.env }
delete env.WORKFLOW_BRIDGE_ENABLE_EXPERIMENTAL
const manifest = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8'))
const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'))
const hooks = JSON.parse(fs.readFileSync(path.join(root, 'hooks/hooks.json'), 'utf8'))
assert.equal(manifest.channels, undefined)
assert.equal(mcp.mcpServers['workflow-bridge'], undefined)
assert(!JSON.stringify(hooks).includes('channel-session.cjs'))
assert(hooks.hooks.Stop && hooks.hooks.PreToolUse && hooks.hooks.UserPromptSubmit)
for (const [script, args] of [
  ['tools/session-bridge.mjs', ['dispatch', '--request-id', 'disabled-probe']],
  ['tools/session-bridge.mjs', ['drain', '--request-id', 'disabled-probe']],
  ['bridge/channel-server.cjs', []],
  ['tools/install-codex-skill.mjs', []],
]) {
  const p = spawnSync(process.execPath, [path.join(root, script), ...args], { env, cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 })
  assert.equal(p.status, 1, p.stderr)
  assert.match(p.stderr, /bridge-disabled|Workflow Bridge 已暂时停用/)
}
console.log('Bridge 默认停用验证通过：无 MCP/Channel 注册，派发/回传/服务器/Skill 安装均被阻止，普通 Workflow hooks 保留。')
