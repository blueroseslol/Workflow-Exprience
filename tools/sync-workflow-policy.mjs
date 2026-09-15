import fs from 'node:fs'
const policy = fs.readFileSync(new URL('lib/workflow-policy.cjs', import.meta.url), 'utf8').trim()
for (const file of ['gitnexus-routed.js', 'openspec-incremental.js']) {
  const target = new URL(`../templates/${file}`, import.meta.url)
  let source = fs.readFileSync(target, 'utf8')
  const block = `// workflow-policy:start\n${policy}\nvalidateWorkflowArgs(args)\n// workflow-policy:end`
  if (source.includes('// workflow-policy:start')) source = source.replace(/\/\/ workflow-policy:start[\s\S]*?\/\/ workflow-policy:end/, () => block)
  else source = source.replace('// effort-policy:end', `// effort-policy:end\n\n${block}`)
  fs.writeFileSync(target, source)
}
const main = fs.readFileSync(new URL('../templates/openspec-incremental.js', import.meta.url), 'utf8')
const effort = main.match(/\/\/ effort-policy:start[^\n]*\n([\s\S]*?)\/\/ effort-policy:end/)[1]
const recoveryFile = new URL('../templates/recover-verify.js', import.meta.url)
const recovery = fs.readFileSync(recoveryFile, 'utf8').replace(/\/\/ recovery-effort:start[\s\S]*?\/\/ recovery-effort:end/,
  () => `// recovery-effort:start\n${effort}// recovery-effort:end`)
fs.writeFileSync(recoveryFile, recovery)
