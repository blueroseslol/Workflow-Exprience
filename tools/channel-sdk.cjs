// Bundle only the SDK: deployed Claude plugins do not install node_modules.
exports.Server = require('@modelcontextprotocol/sdk/server/index.js').Server
exports.StdioServerTransport = require('@modelcontextprotocol/sdk/server/stdio.js').StdioServerTransport
const schemas = require('@modelcontextprotocol/sdk/types.js')
exports.ListToolsRequestSchema = schemas.ListToolsRequestSchema
exports.CallToolRequestSchema = schemas.CallToolRequestSchema
