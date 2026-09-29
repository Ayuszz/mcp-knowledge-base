/**
 * stdio entrypoint — this is the file an MCP host (Claude Desktop, Cursor)
 * launches directly as `node src/server.js` and talks to over stdin/stdout.
 *
 * All the actual tool/resource logic lives in createServer.js; this file's
 * only job is wiring that server to the stdio transport and starting it.
 * See api/mcp.js for the HTTP-transport entrypoint used when deployed.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./createServer.js";

const { server } = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[mcp-knowledge-base] server running on stdio");
