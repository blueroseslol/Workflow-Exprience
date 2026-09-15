#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const name = 'workflow-bridge-controller'
const files = ['SKILL.md', 'agents/openai.yaml', 'scripts/locate-runtime.cjs']
export function install(destination = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills')) {
  require('../bridge/feature.cjs').assertEnabled()
  const source = path.join(root, 'codex-skills', name)
  const target = path.resolve(destination, name)
  const bytes = files.map(file => fs.readFileSync(path.join(source, file)))
  if (fs.existsSync(target)) {
    if (fs.lstatSync(target).isSymbolicLink() || !fs.statSync(target).isDirectory()) throw new Error('目标已存在且不是普通目录，已保留')
    const existing = []
    function visit(dir, prefix = '') {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isSymbolicLink()) throw new Error('已有 Skill 含链接，已保留')
        const relative = prefix + e.name
        if (e.isDirectory()) visit(path.join(dir, e.name), relative + '/')
        else existing.push(relative)
      }
    }
    visit(target)
    if (existing.length !== files.length || files.some((file, i) => !existing.includes(file) || !fs.readFileSync(path.join(target, file)).equals(bytes[i]))) throw new Error('目标 Skill 已存在且内容不同，未覆盖；请先比较并备份已有版本')
    return { status: 'unchanged', name, target }
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.mkdirSync(target)
  files.forEach((file, i) => {
    const to = path.join(target, file)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.writeFileSync(to, bytes[i], { flag: 'wx' })
  })
  return { status: 'installed', name, target }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.length && (args.length !== 2 || args[0] !== '--dest' || !path.isAbsolute(args[1]))) throw new Error('用法：node tools/install-codex-skill.mjs [--dest <绝对 skills 目录>]')
    console.log(JSON.stringify(install(args[1]), null, 2))
  } catch (e) { console.error(e.message); process.exitCode = 1 }
}
