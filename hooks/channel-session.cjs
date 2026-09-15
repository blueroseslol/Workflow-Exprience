#!/usr/bin/env node
'use strict'
if (!require('../bridge/feature.cjs').enabled()) process.exit(0)
const { Store } = require('../bridge/store.cjs')
const { sessionEvent } = require('../bridge/channel.cjs')
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { input += chunk; if (input.length > 65536) process.exit(1) })
process.stdin.on('end', () => {
  try {
    const value = JSON.parse(input)
    sessionEvent(new Store(value.cwd), value.session_id, value.hook_event_name)
  } catch (e) { process.stderr.write(`workflow-channel: ${e.code || 'invalid-hook'}\n`); process.exitCode = 1 }
})
