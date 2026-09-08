'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { ensure, hash, id, real, within } = require('./contracts.cjs')
const MAX_JSON = 2 * 1024 * 1024
function safePath(root, relative) {
  ensure(!path.isAbsolute(relative), 'invalid-path', 'store 路径必须相对')
  const target = path.resolve(root, relative)
  ensure(within(root, target), 'path-outside-root', 'store 路径越界')
  let cur = root
  // State storage never follows symlinks, even links pointing back inside the store.
  for (const part of ['.', ...path.relative(root, target).split(path.sep).filter(Boolean)]) {
    cur = path.resolve(cur, part)
    try { ensure(!fs.lstatSync(cur).isSymbolicLink(), 'unsafe-store', 'store 不允许符号链接/junction') } catch (e) { if (e.code !== 'ENOENT') throw e }
  }
  return target
}
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${crypto.randomUUID()}.tmp`
  const fd = fs.openSync(tmp, 'wx', 0o600)
  try { fs.writeFileSync(fd, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, 'utf8'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  try { fs.renameSync(tmp, file) } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) }
}
function readJson(file, limit = MAX_JSON) {
  ensure(fs.statSync(file).size <= limit, 'context-too-large', 'JSON 文件超出读取预算')
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true
  try { process.kill(pid, 0); return true } catch (e) { return e.code !== 'ESRCH' }
}
class Store {
  constructor(cwd, root = path.join(cwd, '.workflow-bridge'), { create = false } = {}) {
    this.cwd = real(cwd)
    this.transactions = new Set()
    this.root = path.resolve(root)
    this.runtimeRoot = path.resolve(process.env.WORKFLOW_BRIDGE_RUNTIME_DIR || path.join(os.tmpdir(), `workflow-experience-bridge-${hash(os.homedir()).slice(0, 12)}`))
    ensure(within(this.cwd, this.root) && this.root !== this.cwd, 'path-outside-root', 'store 必须位于工作区独立子目录')
    safePath(this.cwd, path.relative(this.cwd, this.root))
    if (create) fs.mkdirSync(this.root, { recursive: true })
  }
  file(p) { return safePath(this.root, p) }
  read(p) { return readJson(this.file(p)) }
  maybe(p) { try { return this.read(p) } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
  write(p, data) { const file = this.file(p); atomic(file, data); return file }
  run(requestId, file = 'request.json') { ensure(id(requestId) && /^[a-zA-Z0-9._-]+$/.test(file), 'invalid-reference', '无效运行文件名'); return `runs/${requestId}/${file}` }
  runtimeFile(p) { return safePath(this.runtimeRoot, p) }
  lockFile(key) {
    const base = /^(?:session|scheduler):/.test(key) ? this.runtimeRoot : safePath(this.cwd, '.workflow-bridge')
    return safePath(base, `locks/${hash(key)}.lock/owner.json`)
  }
  lock(key) {
    // Session/scheduler locks are per-user so the same Claude session cannot be
    // resumed from two worktrees. Other locks remain anchored to the worktree.
    const ownerFile = this.lockFile(key)
    const dir = path.dirname(ownerFile)
    fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    try { fs.mkdirSync(dir) } catch (e) { if (e.code === 'EEXIST') { const error = new Error('资源正在占用；即使 lease 过期也不自动抢锁'); error.code = 'busy'; throw error } throw e }
    const owner = { pid: process.pid, token: crypto.randomUUID(), createdAt: new Date().toISOString(), key }
    atomic(ownerFile, owner)
    return { owner, update: patch => { Object.assign(owner, patch); atomic(ownerFile, owner) }, release: () => {
      const current = readJson(ownerFile)
      ensure(current.token === owner.token, 'owner-mismatch', '锁拥有者已改变')
      fs.unlinkSync(ownerFile); fs.rmdirSync(dir)
    } }
  }
  reclaim(key, requestId) {
    const ownerFile = this.lockFile(key)
    const dir = path.dirname(ownerFile)
    const owner = readJson(ownerFile)
    if (requestId) ensure(owner.requestId === requestId, 'owner-mismatch', '该资源锁不属于当前 request')
    ensure(!alive(owner.pid) && !(owner.relatedPids || []).some(alive) && !owner.workflowUnresolved, 'owner-unknown', '拥有者/子进程仍存在或 Workflow 未终结，不能夺锁')
    fs.unlinkSync(ownerFile); fs.rmdirSync(dir)
    return { reclaimed: true, token: owner.token }
  }
  transact(key, fn) {
    if (this.transactions.has(key)) return fn()
    const l = this.lock(key); this.transactions.add(key)
    try { return fn() } finally { this.transactions.delete(key); l.release() }
  }
}
module.exports = { Store, safePath, atomic, readJson, alive }
