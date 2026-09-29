/**
 * Vercel serverless entrypoint — the Streamable HTTP version of this server,
 * for a remote MCP client to connect to over the internet, as opposed to
 * src/server.js's stdio version that Claude Desktop runs locally.
 *
 * Deliberately STATELESS (sessionIdGenerator: undefined): a fresh McpServer
 * + transport is created for every single request, because a serverless
 * function instance can be recycled at any time and must never be assumed
 * to still hold state from a previous request. All real state (the notes
 * themselves) lives in Postgres via PostgresNoteStore, not in memory here.
 *
 * Requires DATABASE_URL (a Supabase/Postgres connection string) to be set
 * as a Vercel environment variable — see README's "Deploying to Vercel"
 * section. Without it, every request fails fast with a clear error rather
 * than silently falling back to file storage that wouldn't work here anyway.
 */
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "../src/createServer.js";
import { PostgresNoteStore } from "../src/storePostgres.js";
import { SearchCache } from "../src/cache.js";

// @xenova/transformers caches the embedding model to disk on first use.
// Vercel's filesystem is read-only except /tmp, so point the cache there.
// (Best-effort: /tmp may not persist across cold starts, so a cold start
// can still pay the model-load cost again — see README for this trade-off.)
process.env.TRANSFORMERS_CACHE ||= "/tmp/transformers-cache";

export default async function handler(req, res) {
  if (!process.env.DATABASE_URL) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "DATABASE_URL is not configured on this deployment." }));
    return;
  }

  const store = new PostgresNoteStore(process.env.DATABASE_URL);
  const cache = new SearchCache(process.env.REDIS_URL);
  const { server } = createServer({ store, cache });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", async () => {
    await transport.close();
    await server.close();
    await store.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
