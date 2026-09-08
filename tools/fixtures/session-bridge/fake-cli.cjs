'use strict'
const readline = require('node:readline')
const mode = process.argv[2]
const args = process.argv.slice(3)
if (mode === 'rpc') {
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', line => {
    const q = JSON.parse(line)
    if (!q.id) return
    let result = {}
    if (q.method === 'thread/read') result = { thread: { id: q.params.threadId, cwd: process.cwd(), status: { type: 'notLoaded' }, turns: [] } }
    if (q.method === 'thread/turns/list') result = { data: [{ id: 'turn-1', items: [{ id: 'item-1', type: 'userMessage', content: [{ type: 'text', text: '只修改指定文件' }] }, { id: 'item-2', type: 'reasoning', text: 'hidden-do-not-export' }] }], nextCursor: null }
    process.stdout.write(`${JSON.stringify({ id: q.id, result })}\n`)
  })
} else {
  let input = ''
  process.stdin.setEncoding('utf8'); process.stdin.on('data', c => { input += c })
  process.stdin.on('end', () => {
    if (mode === 'echo') console.log(JSON.stringify({ args, input, cwd: process.cwd() }))
    else if (mode === 'codex') {
      if (args.includes('--help')) console.log('queue --thread <ID> --message <TEXT>')
      else console.log(`Queued message fake-queue-id for thread ${args[args.indexOf('--thread') + 1]}.`)
    } else if (mode === 'timeout') setTimeout(() => console.log('late'), 5000)
    else if (mode === 'overflow') console.log('x'.repeat(100000))
  })
}
