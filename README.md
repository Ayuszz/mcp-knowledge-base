# mcp-knowledge-base

An [MCP](https://modelcontextprotocol.io) server that gives Claude Desktop, Cursor, or any other MCP client a personal knowledge base with **real semantic search** — store notes, then ask questions and get back the notes that actually *mean* the same thing, not just ones that share the same words.

Runs with **zero infrastructure**: no API keys, no cloud account, no database server. `npm install && npm start` and it works, using a fully local embedding model.

## Why this exists

Most demo MCP servers wrap one trivial API call. This one is deliberately built to real-system standards: real vector embeddings, a cache with a genuine fail-open design, input validation, and a real MCP-protocol end-to-end test suite — while still being honest in the README about every simplification made and why.

## What it exposes

| Type | Name | Description |
|---|---|---|
| Tool | `add_note` | Store a note; content is embedded for later search |
| Tool | `search_notes` | Semantic search — ranks notes by meaning via cosine similarity over embeddings, not keyword overlap |
| Tool | `list_notes` | List notes, optionally filtered by tag |
| Tool | `delete_note` | Delete a note by id |
| Resource | `note://{id}` | A single note's full content, addressable as MCP resource data, not a tool call |

## Quickstart

```bash
npm install
npm start          # runs the server on stdio, ready for an MCP host to connect
```

To use it from **Claude Desktop**, add to its MCP config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "knowledge-base": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-knowledge-base/src/server.js"]
    }
  }
}
```

Restart Claude Desktop, and you'll have `add_note` / `search_notes` / `list_notes` / `delete_note` available in the tool picker.

## Architecture

Two transports share one core — the tools/resources are defined once, and don't know or care how a client is talking to them:

```text
MCP client                              MCP client
(Claude Desktop, Cursor — local)         (a remote/deployed client)
        |  JSON-RPC over stdio                   |  JSON-RPC over HTTP
        v                                         v
  src/server.js                            api/mcp.js  (Vercel serverless)
  (stdio entrypoint)                       (Streamable HTTP entrypoint,
        |                                   stateless: fresh server per request)
        +-------------------+---------------------+
                             v
                    src/createServer.js
              registers 4 tools + 1 resource, validates input with Zod
                             |
              store (injectable)              +--> src/cache.js
              +-----------------------+              Redis search-result cache,
              |                       |              fails open if unavailable
        src/store.js          src/storePostgres.js
        (local JSON file,     (Postgres/pgvector via Supabase,
         default, used by      used by the HTTP/Vercel path since
         stdio + tests)        serverless has no persistent local disk)
              |                       |
              +-----------+-----------+
                          v
              src/embeddings.js  <- local model (@xenova/transformers), no API key
```

## Design decisions worth explaining out loud

**Why local embeddings instead of an API (OpenAI, etc.)?**
Zero cost, zero setup, zero dependency on a service being up — a genuinely self-contained portfolio project. The trade-off: a local model (`all-MiniLM-L6-v2`, 384 dimensions) is smaller and slightly less accurate than a large hosted embedding model. For a personal notes app, that trade-off is clearly worth it; for a production system at scale, I'd default to a hosted embedding API for quality and offload the compute.

**Why a JSON file instead of a real vector database?**
This is the same "don't over-engineer for the actual scale" argument I make about my hotel assistant's keyword retrieval: brute-force cosine search over a few hundred notes is milliseconds. A real vector database earns its cost once you need thousands+ of documents and an ANN index like HNSW — or once you need to run serverless, where a local file can't persist between requests at all. Both are true for the Vercel deployment, so `src/storePostgres.js` implements the identical interface against pgvector (schema in `db/schema.sql`) with **zero changes to any tool definition** in `createServer.js` — the store was made swappable from day one for exactly this reason.

**Why does the Redis cache "fail open"?**
If `REDIS_URL` isn't set, or Redis is unreachable, `search_notes` still works — it's just not cached. A cache is an optimization, not a correctness requirement, so a broken cache should never break the feature it's speeding up. `test/cache.test.js` verifies this directly, including against a genuinely unreachable address, with a short connect timeout so a dead cache can't hang a real search.

**Why Zod for input validation?**
Every tool's `inputSchema` is a Zod schema. The MCP SDK validates incoming tool calls against it before my handler code ever runs, and reports invalid input as a normal `isError: true` result with a specific message — not a crash, not a protocol-level failure. `test/e2e.test.js` confirms this by actually calling `add_note` with a missing field through a real client.

## Testing

```bash
npm test           # everything (26 tests)
npm run test:unit  # embeddings, store, cache — fast, no subprocess
npm run test:e2e   # spawns the real server and drives it through a genuine MCP client (stdio)
npm run test:http  # a real HTTP server + a real MCP client talking over fetch (the Vercel path)
```

**26 tests, all real, none mocked**, including:
- Real embedding generation and a real semantic-ranking assertion (a "pool" note outranks a "refund policy" note for a "somewhere to swim" query — actual cosine similarity, not a hand-picked score)
- Real Redis fail-open behavior against a genuinely unreachable address
- A true stdio end-to-end suite that spawns `server.js` as a subprocess and talks to it via `@modelcontextprotocol/sdk`'s own `Client` and `StdioClientTransport` — the exact mechanism Claude Desktop uses
- A true HTTP end-to-end suite that spins up a real `http.createServer` wired exactly like `api/mcp.js`, and a real MCP `Client` connecting over `fetch` — including a test that each request creates a brand-new, stateless server instance and prior data still shows up, proving the serverless assumption ("never trust in-memory state between requests") actually holds

**Honest gap:** `storePostgres.js` (the Supabase-backed store used by the deployed version) is not covered by this suite, because that needs real database credentials this project doesn't have baked in. It was written to match the exact interface `store.js` already has passing tests for, but you should run it once against your own Supabase instance and confirm it before relying on it (see "Deploying to Vercel" below).

## Two real bugs hit while building this (kept here on purpose)

Good interview material, and honest documentation of what "debugging skills" actually looks like in practice:

1. **A Windows-specific entrypoint bug.** The original code guarded the server's stdio startup with `import.meta.url === \`file://${process.argv[1]}\``, intending to only start when run directly. On Windows, `import.meta.url` for a script is `file:///C:/...` (three slashes before the drive letter); the manually-built comparison string only had two. The comparison silently never matched, so the server loaded, did nothing, and exited cleanly — no error, no crash, just silence. Found by spawning it directly and watching it exit instantly with no output, then reasoning through what "silent, instant, zero-error exit" could mean for a script with no other early-return path. Fixed by removing the fragile string comparison entirely, since nothing else imports this file as a library.
2. **A Windows-only native dependency failure.** `@xenova/transformers` pulls in `sharp` (for image models we don't use) as a dependency requiring a compiled native binary. Installing from a shell without access to spawn `cmd.exe` broke its postinstall step; running the equivalent command from PowerShell instead let the prebuilt binary download correctly. A reminder that "it doesn't work" and "it's not installed correctly" are different bugs with different fixes.

## Deploying to Vercel

The stdio server (`src/server.js`) **cannot** be deployed to Vercel — Vercel runs HTTP-triggered serverless functions, not long-running local processes talking over stdin/stdout, which is what Claude Desktop needs. `api/mcp.js` is the separate, HTTP-based version built specifically for this, using MCP's **Streamable HTTP** transport and a Postgres-backed store instead of the local JSON file (serverless functions don't keep a persistent disk between requests).

### 1. Set up Supabase with pgvector

1. Create a project at [supabase.com](https://supabase.com) (or reuse an existing one).
2. Open the **SQL Editor** and run the contents of `db/schema.sql` — it creates the `notes` table with a `vector(384)` column and an HNSW index.
3. Go to **Project Settings → Database → Connection string** and copy the **URI** (starts with `postgresql://...`). This is your `DATABASE_URL`.

### 2. Deploy to Vercel

```bash
npm install -g vercel   # if you don't have it
vercel
```

Follow the prompts (link or create a project). When it asks about the framework, accept the default — `vercel.json` already configures `api/mcp.js` correctly.

### 3. Set environment variables

In the Vercel dashboard → your project → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | The Supabase connection string from step 1 |
| `REDIS_URL` | Optional — an Upstash Redis URL, if you want the search cache active on the deployed version too |

**Set these directly in Vercel's dashboard, never commit them to a file.** `.env.example` documents every variable this project reads, with no real values.

Redeploy after adding them (`vercel --prod`, or push a commit if connected to GitHub).

### 4. Verify it live

Your deployed endpoint will be `https://<your-project>.vercel.app/api/mcp`. Any MCP client configured for a remote server (Streamable HTTP transport) can connect to it. `npm run test:http` shows exactly the shape of a working request/response if you want to sanity-check the wiring locally first.

### Known trade-offs of this deployment, documented honestly

- **Cold-start latency:** the embedding model loads fresh (or from `/tmp`'s best-effort cache) on a cold serverless instance, which can take several seconds — noticeably slower than a warm local server. For consistent low latency at real scale, swap `embeddings.js` for a hosted embedding API instead of the local model; the interface (`embed(text)`) stays the same either way.
- **`storePostgres.js` is untested against a live database** as part of this project's own test suite, for the reason explained in the Testing section above — verify it against your real Supabase instance before depending on it.
- **Serverless timeout limits vary by plan.** `vercel.json` requests a 60-second function timeout for the embedding model's first load; confirm your plan actually allows that duration.

## What I'd still change for production scale

- Add per-client rate limiting on `search_notes` (embedding calls aren't free at API scale)
- Add authentication on the HTTP transport (currently open to anyone with the URL)
- Add `list_notes` pagination once the note count grows past a page or two
- Swap the local embedding model for a hosted API on the deployed version, to avoid the cold-start cost above
