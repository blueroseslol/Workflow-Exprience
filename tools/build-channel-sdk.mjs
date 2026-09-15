#!/usr/bin/env node
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const result = await build({ absWorkingDir: root, entryPoints: ['tools/channel-sdk.cjs'], bundle: true, platform: 'node', format: 'cjs', minify: true, legalComments: 'eof', outfile: 'bridge/vendor/mcp-sdk.cjs', metafile: true })
const packages = new Set(Object.keys(result.metafile.inputs).flatMap(p => {
  const match = p.replaceAll('\\', '/').match(/^node_modules\/((?:@[^/]+\/)?[^/]+)\//)
  return match ? [match[1]] : []
}))
const notices = [...packages].sort().map(name => {
  const dir = path.join(root, 'node_modules', name)
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const licenses = fs.readdirSync(dir).filter(file => /^licen[cs]e(?:\..+)?$/i.test(file) && fs.statSync(path.join(dir, file)).isFile())
  if (!licenses.length) throw new Error(`Missing license file for bundled package ${name}`)
  return `${name}@${pkg.version} (${pkg.license || 'see license'})\n\n${licenses.sort().map(file => fs.readFileSync(path.join(dir, file), 'utf8').trim()).join('\n\n')}`
})
fs.writeFileSync(path.join(root, 'bridge/vendor/THIRD_PARTY_NOTICES.txt'), `${notices.join('\n\n------------------------------------------------------------\n\n')}\n`)
console.log(`Bundled MCP SDK and ${packages.size} dependency license notices`)
