// Build the parser into the plugin: installed hooks need only Node, not npm install.
const { parse } = require('acorn')
const { analyze } = require('eslint-scope')
const globals = new Set(('agent parallel pipeline workflow phase log args budget console setTimeout clearTimeout ' +
  'Object Array String Number Boolean JSON Math Date RegExp Map Set WeakMap WeakSet Promise Error TypeError RangeError SyntaxError ' +
  'undefined NaN Infinity parseInt parseFloat isNaN isFinite BigInt Symbol Intl encodeURIComponent decodeURIComponent encodeURI decodeURI').split(' '))
exports.checkSource = source => {
  try {
    const ast = parse(source, { ecmaVersion: 2022, sourceType: 'module', allowReturnOutsideFunction: true, locations: true, ranges: true })
    const scopes = analyze(ast, { ecmaVersion: 2022, sourceType: 'module', optimistic: true, ignoreEval: true })
    return scopes.globalScope.through.filter(r => !globals.has(r.identifier.name)).map(r =>
      `${r.identifier.loc.start.line}:${r.identifier.loc.start.column + 1} undefined variable: ${r.identifier.name}`)
  } catch (error) { return [`script parse failed: ${error.message}`] }
}
