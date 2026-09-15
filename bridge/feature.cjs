'use strict'
// Bridge is parked until its setup and recovery experience is redesigned.
// The explicit opt-in exists for isolated maintenance tests only; no entrypoint
// or hook enables it on behalf of the user.
function enabled() { return process.env.WORKFLOW_BRIDGE_ENABLE_EXPERIMENTAL === '1' }
function assertEnabled() {
  if (!enabled()) throw Object.assign(new Error('Workflow Bridge 已暂时停用；普通 Workflow 仍可使用。'), { code: 'bridge-disabled' })
}
module.exports = { enabled, assertEnabled }
