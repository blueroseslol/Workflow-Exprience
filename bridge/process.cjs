'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { StringDecoder } = require('node:string_decoder')
const { ensure, fail } = require('./contracts.cjs')
function resolveExecutable(name, { env = process.env, platform = process.platform } = {}) {
  ensure(['codex', 'claude', 'git'].includes(name), 'unsupported', '不支持的 CLI')
  const dirs = (env.PATH || env.Path || '').split(path.delimiter)
  for (const dir of dirs) {
    if (!dir) continue
    const native = path.join(dir, name + (platform === 'win32' ? '.exe' : ''))
    if (fs.existsSync(native) && fs.statSync(native).isFile()) return { executable: native, prefix: [] }
    if (platform !== 'win32') continue
    const shim = path.join(dir, `${name}.cmd`)
    if (!fs.existsSync(shim)) continue
    // Only resolve npm's fixed executable target; never interpret the batch program.
    const contents = fs.readFileSync(shim, 'utf8')
    // npm shims mention "%dp0%\\node.exe" BEFORE their actual package entry.
    // Match the package entry specifically, otherwise every ordinary npm shim
    // is skipped and a different CLI later in PATH may be selected instead.
    const match = contents.match(/"%dp0%[\\/](node_modules[\\/][^"\r\n]+\.(?:exe|[cm]?js))"/i)
    if (!match || match[1].includes('%')) continue
    const target = path.resolve(dir, match[1])
    const relative = path.relative(path.resolve(dir, 'node_modules'), target)
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue
    if (!fs.existsSync(target)) continue
    if (/\.exe$/i.test(target)) return { executable: target, prefix: [] }
    return { executable: process.execPath, prefix: [target] }
  }
  fail('cli-not-found', `${name} 未找到可安全启动的 executable；请检查 PATH`)
}
function spawnCommand(command, args, opts = {}) {
  const resolved = typeof command === 'string' ? resolveExecutable(command) : command
  ensure(Array.isArray(args) && args.every(x => typeof x === 'string' && !x.includes('\0')), 'invalid-args', 'CLI args 必须是字符串数组')
  return spawn(resolved.executable, [...(resolved.prefix || []), ...args], { cwd: opts.cwd, env: opts.env || process.env, shell: false, windowsHide: true, detached: opts.detached || false, stdio: opts.stdio || ['pipe', 'pipe', 'pipe'] })
}
function run(command, args, { cwd, stdin = '', timeoutMs = 30000, maxBytes = 2 * 1024 * 1024, env, onEvent, onChild } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try { child = spawnCommand(command, args, { cwd, env }) } catch (e) { reject(e); return }
    let stdout = '', stderr = '', line = '', bytes = 0, timedOut = false, overflow = false
    const decoder = new StringDecoder('utf8')
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
    onChild?.(child)
    child.stdout.on('data', chunk => {
      bytes += chunk.length
      if (bytes > maxBytes) { overflow = true; child.kill(); return }
      const s = decoder.write(chunk); stdout += s
      if (onEvent) {
        line += s
        let i
        while ((i = line.indexOf('\n')) >= 0) { const row = line.slice(0, i); line = line.slice(i + 1); try { onEvent(JSON.parse(row)) } catch { /* malformed rows are not receipts */ } }
      }
    })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-32768) })
    child.on('error', e => { clearTimeout(timer); e.beforeSubmission = !child.pid; reject(e) })
    child.on('close', (exitCode, signal) => { clearTimeout(timer); stdout += decoder.end(); resolve({ exitCode, signal, stdout, stderr, timedOut, overflow }) })
    child.stdin.on('error', () => {})
    child.stdin.end(stdin)
  })
}
function gitSnapshot(cwd) {
  const call = args => {
    const p = spawnSync('git', args, { cwd, shell: false, windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 })
    ensure(p.status === 0, 'git-unavailable', '无法读取工作区 Git 状态')
    return p.stdout.trim()
  }
  return { repoRoot: call(['rev-parse', '--show-toplevel']), head: call(['rev-parse', 'HEAD']), branch: call(['branch', '--show-current']), dirtySnapshot: call(['status', '--porcelain=v1', '--untracked-files=all']) }
}
module.exports = { resolveExecutable, spawnCommand, run, gitSnapshot }
