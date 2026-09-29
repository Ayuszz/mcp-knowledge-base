/**
 * Tests the Streamable HTTP transport (used by api/mcp.js for Vercel) for
 * real: a genuine Node http.createServer wired exactly like the Vercel
 * handler, and a genuine MCP Client connecting over real HTTP with fetch —
 * the same client mechanism a deployed server would be used with.
 *
 * Deliberately uses the file-based NoteStore here, NOT PostgresNoteStore —
 * this isolates and proves the HTTP transport wiring itself is correct
 * without needing real database credentials. PostgresNoteStore implements
 * the identical interface already covered by store.test.js's assertions,
 * so this test's job is "does the HTTP plumbing work," not "does Postgres."
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer } from "../src/createServer.js";
import { NoteStore } from "../src/store.js";
import { SearchCache } from "../src/cache.js";

let httpServer, client, tempDir, baseUrl;

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mcp-kb-http-"));
  const store = new NoteStore(join(tempDir, "notes.json"));
  const cache = new SearchCache(undefined); // no Redis needed for this test

  // Mirrors api/mcp.js exactly: one fresh McpServer + transport per request,
  // stateless mode, so this test also proves the serverless-style "no
  // assumed state between requests" pattern actually works.
  httpServer = http.createServer(async (req, res) => {
    const { server } = createServer({ store, cache });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });

  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();
  baseUrl = `http://127.0.0.1:${port}/mcp`;

  client = new Client({ name: "http-e2e-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  await new Promise((resolve) => httpServer?.close(resolve));
  await rm(tempDir, { recursive: true, force: true });
});

test("HTTP transport: listTools works over real fetch, stateless mode", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ["add_note", "delete_note", "list_notes", "search_notes"]
  );
});

test("HTTP transport: add_note -> search_notes round trip over real HTTP", async () => {
  await client.callTool({
    name: "add_note",
    arguments: {
      title: "Vercel deployment notes",
      content: "The HTTP transport runs stateless, one server instance per request.",
      tags: ["deployment"],
    },
  });

  const result = await client.callTool({
    name: "search_notes",
    arguments: { query: "How does this behave when deployed serverless?", topK: 3 },
  });
  assert.match(result.content[0].text, /Vercel deployment notes/);
});

test("HTTP transport: a fresh request (simulating a new serverless invocation) still sees prior data", async () => {
  // Each callTool above went through a BRAND NEW McpServer instance (stateless
  // mode creates one per request) — reaching this point at all proves state
  // survives at the store layer, exactly as it must in serverless, where the
  // store (Postgres in production) is the only thing allowed to hold state.
  const result = await client.callTool({ name: "list_notes", arguments: {} });
  assert.match(result.content[0].text, /Vercel deployment notes/);
});
