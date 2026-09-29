# How This Was Built — Full Reference

*A complete record of this project: why it exists, everything required to run and modify it, every real decision made, every bug hit and fixed, and how to extend it safely. Keep this file — it's your permanent reference so you never have to reconstruct the reasoning from memory.*

---

## 1. Why this project exists

Built as an interview-prep portfolio project for an **AI Product Engineer** role, deliberately different from a typical "AI chatbot" project (a hotel guest assistant was already built separately). The goal was to build something genuinely advanced and hard to fake understanding of: a real **MCP (Model Context Protocol) server**, since almost no other candidate applying for AI roles will have built one, and it directly demonstrates "directing an AI tool," which is the actual skill the role tests for.

**The brief given, in order:**
1. Build an MCP server — "high level and advanced," not a toy example
2. Plain JavaScript, not TypeScript (a deliberate simplicity choice, not a limitation)
3. No React — a decision made after clarifying that MCP servers have no user interface at all; the "interface" is the AI client (Claude Desktop) itself

---

## 2. What this project actually is, in plain terms

An MCP server is a small background program that gives an AI application (Claude Desktop, Cursor, etc.) new abilities — in this case, storing personal notes and finding them again **by meaning**, not just by matching words. This is a real implementation of **semantic search** (the same core idea behind RAG systems), packaged as a reusable AI tool.

---

## 3. Everything required to run this project

| Requirement | Why | Notes |
|---|---|---|
| **Node.js 18+** (built and tested on Node 22) | Runs the server | Check with `node --version` |
| **npm** (comes with Node) | Installs dependencies | |
| Internet connection, **first run only** | Downloads the local embedding model (~90MB, one time, then cached) | After the first run, it works offline |
| Nothing else | No API keys, no database, no Docker required for local/basic use | This was a deliberate design goal |

**Optional, for the upgrade paths documented below:**
- **Redis** — only if you want search-result caching. Without it, the server still works, just without the cache speed-up.
- **Docker** — only if you want to run the optional Postgres+Redis upgrade path (see `docker-compose.yml`).
- **A Supabase/Postgres account** — only needed for the Vercel-deployed HTTP version (see section 9), since serverless platforms need a persistent database instead of a local file.

---

## 4. Full file-by-file reference

```text
mcp-knowledge-base/
├── src/
│   ├── server.js       # MCP entrypoint: registers 4 tools + 1 resource, wires everything together
│   ├── store.js         # Storage + real semantic search (embed, cosine similarity, top-k)
│   ├── embeddings.js    # Local AI model: turns text into a 384-number vector
│   └── cache.js         # Redis caching layer, with automatic graceful fallback
├── test/
│   ├── embeddings.test.js  # Tests the raw math + the real AI model
│   ├── store.test.js       # Tests storage and search logic with real embeddings
│   ├── cache.test.js       # Tests the cache, including when Redis is broken/missing
│   └── e2e.test.js         # Spawns the REAL server and talks to it like Claude Desktop would
├── db/
│   └── schema.sql        # The Postgres/pgvector version of store.js, for the scale-up path
├── docker-compose.yml    # Optional: spins up Postgres+pgvector and Redis locally
├── package.json          # Dependencies + npm scripts (start, test)
├── .env.example           # Every environment variable this project understands, documented
├── .gitignore
├── README.md              # The public-facing project description (what a visitor/interviewer reads)
└── HOW_THIS_WAS_BUILT.md  # This file — your own permanent reference
```

### `src/embeddings.js` — turning text into meaning-numbers

Uses `@xenova/transformers`, a library that runs a small AI model (`all-MiniLM-L6-v2`) **entirely on your own computer** — no API key, no per-call cost, works offline after the first download. Every piece of text becomes a list of 384 numbers (a "vector"). Two pieces of text with **similar meaning** get **similar numbers** — that's the whole trick behind semantic search.

Also exports `cosineSimilarity(a, b)` — the math that compares two vectors and returns a score from -1 to 1, where 1 means "identical meaning" and 0 means "unrelated."

### `src/store.js` — the actual database (a JSON file)

Every note you add gets embedded (turned into those 384 numbers) and saved to `data/notes.json`. Searching works by: embed your search question the same way, then compare it against **every** stored note's numbers, sort by similarity score, return the best few (`top-k`). This is called "brute-force" search — simple, and genuinely fine up to a few thousand notes. `db/schema.sql` shows the exact same idea using a real database with a faster search index, for when you outgrow a plain file.

### `src/cache.js` — an optional speed boost, safe to remove entirely

If you set a `REDIS_URL`, this stores recent search results so repeated searches are instant. If you **don't** set it, or Redis is down, nothing breaks — the code detects this and just skips caching silently. This is called "failing open": a broken optimization should never break the actual feature.

### `src/server.js` — where everything connects to the outside world

This is the file Claude Desktop (or any MCP client) actually runs. It defines 4 **tools** (actions the AI can call: `add_note`, `search_notes`, `list_notes`, `delete_note`) and 1 **resource** (`note://{id}`, a readable piece of data, different from a tool call). Every tool's expected input is defined with **Zod**, a validation library — if the AI sends bad input (wrong type, missing field), the server rejects it clearly instead of crashing.

### `test/` — proof that everything genuinely works

Every test in this project is **real**, nothing is faked/mocked:
- `embeddings.test.js` actually loads the AI model and checks that related sentences score higher than unrelated ones
- `store.test.js` actually stores and searches real notes with real embeddings
- `cache.test.js` actually tries to connect to a broken Redis address and confirms the server doesn't crash
- `e2e.test.js` is the most important one: it **starts the actual server as a separate program** and talks to it using the same official library Claude Desktop uses, proving the whole thing works end-to-end, not just that the internal functions work in isolation

---

## 5. Every real decision made, and why

| Decision | Alternative considered | Why this choice |
|---|---|---|
| Local embedding model, no API key | OpenAI's embedding API | Zero cost, zero setup, works offline — the whole project needed zero cloud accounts to run |
| A JSON file for storage | A real vector database (pgvector, Pinecone) | Brute-force search over a personal note collection (hundreds of notes) is milliseconds — a real vector database only earns its complexity at much larger scale. The upgrade path is fully documented (`db/schema.sql`) for when it's needed |
| Redis cache that fails open | A cache that's required to work | A cache is a speed optimization. If it breaks, the feature it speeds up should still work — just slower |
| Plain JavaScript, not TypeScript | TypeScript | A deliberate simplicity choice for this project, matching comfort with plain JS/Node day-to-day |
| No React / no UI | A web dashboard | MCP servers have no user interface — the AI client itself (Claude Desktop) is the interface. Building a UI would have been solving a problem that doesn't exist here |
| Node's built-in test runner (`node:test`) | Vitest / Jest | Zero extra dependencies, built into Node 22 already, and an install of an alternative test runner failed unpredictably in the build environment |
| Real end-to-end tests (spawn the actual server) | Only testing internal functions | Internal-function tests can pass while the actual protocol wiring is broken (and this genuinely happened during development — see the bug log below). Only a real spawned-server test catches that class of bug |

---

## 6. Bugs hit during development — the full story

These are real, and they're good material for "tell me about a bug you found" in an interview, because you can explain not just *what* broke but *how* it was diagnosed.

### Bug 1: The server silently did nothing and exited instantly

**Symptom:** every test that talked to the real server failed with `MCP error -32000: Connection closed` — as if the server crashed the instant it started.

**Diagnosis process:**
1. Ran the server directly (`node src/server.js`) instead of through a test, to see it in isolation.
2. It exited immediately with **zero output** — no error message, nothing.
3. Zero output on exit (not a crash, not a visible error) pointed at the code simply never running the part that starts the server.
4. Found the cause: the code had a guard like `if (import.meta.url === "file://" + process.argv[1])`, meant to only start the server when the file is run directly. On Windows, the real value looks like `file:///C:/...` — **three** slashes before the drive letter — but the hand-built comparison string only had **two**. The comparison was always false, so the server-starting code never ran at all.

**Fix:** removed the fragile manual comparison entirely, since nothing else in the project imports this file as a library — it only ever needs to run as the main program.

**The lesson:** a "clean, silent exit with zero errors" is itself a diagnostic clue — it usually means a piece of code never ran at all, not that it ran and failed.

### Bug 2: A dependency's native code wouldn't install

**Symptom:** `npm install` failed with errors about `node-gyp`, "Could not find Visual Studio," referencing a package called `sharp`.

**Diagnosis process:**
1. `sharp` is an image-processing library — pulled in by the embeddings library even though this project never processes images, only text.
2. It needs a compiled native binary, and the automatic download/build step failed in one shell environment.
3. Tried the exact same install command from a **different** shell (PowerShell instead of the original one) — it succeeded, because PowerShell could properly run the step that downloads a ready-made binary instead of needing to compile one from scratch.

**Fix:** no code change needed — this was a build-environment issue, not a bug in the project. If you ever see this error on your own machine, try the install from a plain Command Prompt or PowerShell window rather than a different kind of shell.

**The lesson:** "it doesn't work" and "it's not installed correctly for this specific environment" are different problems requiring different fixes — the first assumption (broken dependency) was wrong; the real cause was environment-specific.

---

## 7. How to safely make changes without losing anything

### Adding a new tool (e.g., `update_note`)

1. Open `src/store.js`, add a method (e.g. `updateNote(id, changes)`) — this is where the actual logic belongs.
2. Open `src/server.js`, find where the existing tools are registered (`server.registerTool(...)`), copy the pattern of an existing one (like `delete_note`), give it a Zod `inputSchema`, and call your new `store.js` method inside its handler.
3. Add a test for it in `test/e2e.test.js`, following the pattern of the existing tests — call it through the real client, assert on the result.
4. Run `npm test` before committing — if it's not green, don't push it.

### Changing storage (e.g., swapping the JSON file for a real database)

Only `src/store.js` needs to change. Its four methods (`addNote`, `search`, `listNotes`, `deleteNote`) are the entire contract the rest of the app depends on — `server.js` never touches the storage details directly. `db/schema.sql` already has the equivalent Postgres/pgvector schema ready for this swap.

### General rule for any change

**Run `npm test` after every change, before moving to the next one.** The test suite is real and will catch genuine breakage, not just style issues. If a test fails, read the specific assertion that failed — it tells you exactly what stopped being true.

---

## 8. Command reference

| Command | What it does |
|---|---|
| `npm install` | Installs all dependencies — run this once, and again if `package.json` changes |
| `npm start` | Runs the server, waiting for an MCP client to connect (e.g. Claude Desktop) |
| `npm test` | Runs all 26 tests |
| `npm run test:unit` | Runs only the fast tests (no server spawn) |
| `npm run test:e2e` | Runs only the full real-server stdio test |
| `npm run test:http` | Runs only the HTTP transport test (the Vercel path) |
| `git status` | Shows what's changed since your last commit |
| `git add -A && git commit -m "message"` | Saves your changes permanently in git history |
| `git push` | Sends your saved changes to GitHub |

---

## 9. The Vercel-deployed version — what was actually built, and why it's a separate piece

**Important distinction:** the server described in sections 1–8 talks over **stdio** — Claude Desktop runs it as a local program on your machine. Vercel does not run that kind of program at all; it runs code that responds to web (HTTP) requests. So the stdio server itself cannot be "put on Vercel" — that combination doesn't exist. This is why the deployed version is genuinely separate code, not a config change.

### What was added

| New file | Purpose |
|---|---|
| `src/createServer.js` | The tool/resource definitions, pulled out of `src/server.js` so both transports can share the exact same logic. Now accepts an injectable `store`, defaulting to the local file store |
| `api/mcp.js` | The Vercel serverless entrypoint. Uses MCP's **Streamable HTTP** transport, which speaks plain web `Request`/`Response` — the same shape Vercel functions expect natively |
| `src/storePostgres.js` | The exact same 4-method interface as `store.js`, backed by Postgres/pgvector instead of a JSON file, because a serverless function has no persistent local disk between requests |
| `db/schema.sql` | Already existed as a "future upgrade" reference; now actually used, unmodified, as the real schema this version runs against |
| `test/http.test.js` | A genuine end-to-end test: a real `http.createServer` wired exactly like `api/mcp.js`, and a real MCP client talking to it over `fetch` |

### Why `createServer.js` had to be split out

Before this, `server.js` had the tool definitions **and** the stdio-startup code in one file, with the startup code running unconditionally at the bottom. `api/mcp.js` needed to reuse the tool definitions **without** triggering stdio startup — so the factory function (`createServer()`) was moved to its own file with no side effects, and both `server.js` (stdio) and `api/mcp.js` (HTTP) now import it and attach their own transport.

### Why the HTTP version runs "stateless"

Every incoming HTTP request in `api/mcp.js` creates a **brand-new** `McpServer` and transport, rather than reusing one across requests (`sessionIdGenerator: undefined` in the transport options — this is MCP's own documented "stateless mode"). This matters because a serverless function instance can be silently destroyed and replaced by Vercel at any time; code that assumed state survived between requests would intermittently and confusingly break. `test/http.test.js` proves this pattern actually works by calling three separate tools, each going through a completely fresh server instance, and confirming the data (held in the injected store, not in server memory) is still there each time.

### What was genuinely tested vs. what couldn't be

- **Fully tested:** the HTTP transport wiring itself — a real HTTP server, a real MCP client, real tool calls over real `fetch` requests, using the already-proven file store as the backend for the test (isolating "does the HTTP plumbing work" from "does Postgres work").
- **Not tested here:** `storePostgres.js` against an actual live database. That requires real Supabase credentials, which this build environment doesn't have and shouldn't be given. It was written to match the identical interface `store.js` already has real, passing tests for — but "matches the interface" and "definitely has zero bugs against a live database" are different claims, and only the second one needs your own Supabase project to verify. Run it once for real before trusting it in front of an interviewer.

### Full setup steps

See the README's **"Deploying to Vercel"** section for the exact Supabase and Vercel CLI steps.

---

## 10. If you come back to this project after a long break

Read, in this order: **section 4** (what each file does), **section 5** (why it's built this way), then run `npm test` to confirm it still works on your machine before changing anything.
