'use strict'
const { Store } = require('./store.cjs')
const E = require('./engine.cjs')
const { runWorker } = require('./worker.cjs')
const args = process.argv.slice(2)
const arg = name => args[args.indexOf(name) + 1]
const requestId = arg('--request-id')
let store
async function main() {
  store = new Store(arg('--cwd'), arg('--store-root'))
  await runWorker(store, requestId, arg('--token'))
}
main().catch(e => {
  if (store) try { E.setState(store, requestId, { ...(!store.maybe(store.run(requestId, 'result.json')) ? { workStatus: 'blocked' } : {}), runnerStatus: 'error', errorCode: e.code || 'runner-error' }) } catch {}
  console.error(JSON.stringify({ error: e.code || 'runner-error' })); process.exitCode = 1
})
