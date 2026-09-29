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

```text
MCP client (Claude Desktop, Cursor, ...)
        |  JSON-RPC over stdio
        v
   src/server.js        <- registers 4 tools + 1 resource, validates input with Zod
        |
        +--> src/store.js       <- embeds notes, brute-force top-k cosine search
        |         |
        |         +--> src/embeddings.js   <- local model (@xenova/transformers), no API key
        |
        +--> src/cache.js       <- Redis cache for search results, fails open if unavailable
```

## Design decisions worth explaining out loud

**Why local embeddings instead of an API (OpenAI, etc.)?**
Zero cost, zero setup, zero dependency on a service being up — a genuinely self-contained portfolio project. The trade-off: a local model (`all-MiniLM-L6-v2`, 384 dimensions) is smaller and slightly less accurate than a large hosted embedding model. For a personal notes app, that trade-off is clearly worth it; for a production system at scale, I'd default to a hosted embedding API for quality and offload the compute.

**Why a JSON file instead of a real vector database?**
This is the same "don't over-engineer for the actual scale" argument I make about my hotel assistant's keyword retrieval: brute-force cosine search over a few hundred notes is milliseconds. A real vector database earns its cost once you need thousands+ of documents and an ANN index like HNSW. `db/schema.sql` and `docker-compose.yml` show exactly what that upgrade looks like — a pgvector table with an HNSW index — without changing any of the MCP tool code in `server.js`, because the store is a swappable module (`store.js`), not tangled into the protocol layer.

**Why does the Redis cache "fail open"?**
If `REDIS_URL` isn't set, or Redis is unreachable, `search_notes` still works — it's just not cached. A cache is an optimization, not a correctness requirement, so a broken cache should never break the feature it's speeding up. `test/cache.test.js` verifies this directly, including against a genuinely unreachable address, with a short connect timeout so a dead cache can't hang a real search.

**Why Zod for input validation?**
Every tool's `inputSchema` is a Zod schema. The MCP SDK validates incoming tool calls against it before my handler code ever runs, and reports invalid input as a normal `isError: true` result with a specific message — not a crash, not a protocol-level failure. `test/e2e.test.js` confirms this by actually calling `add_note` with a missing field through a real client.

## Testing

```bash
npm test           # everything
npm run test:unit  # embeddings, store, cache — fast, no subprocess
npm run test:e2e   # spawns the real server and drives it through a genuine MCP client
```

**23 tests, all real, none mocked**, including:
- Real embedding generation and a real semantic-ranking assertion (a "pool" note outranks a "refund policy" note for a "somewhere to swim" query — actual cosine similarity, not a hand-picked score)
- Real Redis fail-open behavior against a genuinely unreachable address
- A true end-to-end suite that spawns `server.js` as a subprocess and talks to it via `@modelcontextprotocol/sdk`'s own `Client` and `StdioClientTransport` — the exact mechanism Claude Desktop uses, not a shortcut that calls the handler functions directly

## Two real bugs hit while building this (kept here on purpose)

Good interview material, and honest documentation of what "debugging skills" actually looks like in practice:

1. **A Windows-specific entrypoint bug.** The original code guarded the server's stdio startup with `import.meta.url === \`file://${process.argv[1]}\``, intending to only start when run directly. On Windows, `import.meta.url` for a script is `file:///C:/...` (three slashes before the drive letter); the manually-built comparison string only had two. The comparison silently never matched, so the server loaded, did nothing, and exited cleanly — no error, no crash, just silence. Found by spawning it directly and watching it exit instantly with no output, then reasoning through what "silent, instant, zero-error exit" could mean for a script with no other early-return path. Fixed by removing the fragile string comparison entirely, since nothing else imports this file as a library.
2. **A Windows-only native dependency failure.** `@xenova/transformers` pulls in `sharp` (for image models we don't use) as a dependency requiring a compiled native binary. Installing from a shell without access to spawn `cmd.exe` broke its postinstall step; running the equivalent command from PowerShell instead let the prebuilt binary download correctly. A reminder that "it doesn't work" and "it's not installed correctly" are different bugs with different fixes.

## What I'd change for production scale

- Swap `store.js`'s file-backed search for the pgvector schema in `db/schema.sql` (HNSW-indexed, same interface)
- Swap the local embedding model for a hosted API for better retrieval quality
- Add per-client rate limiting on `search_notes` (embedding calls aren't free at API scale)
- Add authentication if exposed over a network transport instead of local stdio
- Add `list_notes` pagination once the note count grows past a page or two
