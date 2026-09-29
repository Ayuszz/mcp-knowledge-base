/**
 * End-to-end test: spawns the real server.js as a child process and drives
 * it through a genuine MCP Client over stdio — the exact same transport
 * Claude Desktop uses. This is the strongest proof the server actually
 * works as an MCP server, not just that the internal functions do.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "src", "server.js");

let client, transport, tempDir;

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mcp-kb-e2e-"));
  transport = new StdioClientTransport({
    command: process.execPath, // the current node binary
    args: [SERVER_PATH],
    // Deliberately NOT spreading the full process.env here: the transport's
    // own getDefaultEnvironment() already supplies a safe, minimal Windows
    // env (PATH, etc). Passing only what the server needs avoids leaking an
    // oversized/host-specific environment into the spawned child.
    env: {
      KB_DATA_FILE: join(tempDir, "notes.json"),
    },
  });
  client = new Client({ name: "e2e-test-client", version: "1.0.0" });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  await rm(tempDir, { recursive: true, force: true });
});

test("listTools: the server advertises all 4 tools with schemas", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["add_note", "delete_note", "list_notes", "search_notes"]);
  const addNote = tools.find((t) => t.name === "add_note");
  assert.ok(addNote.inputSchema, "add_note should expose an input schema for the model");
});

test("add_note -> search_notes: a real round trip through the MCP protocol", async () => {
  const addResult = await client.callTool({
    name: "add_note",
    arguments: {
      title: "Pool hours",
      content: "Our outdoor pool is open 7am to 9pm daily, heated year-round.",
      tags: ["amenity"],
    },
  });
  assert.equal(addResult.isError, undefined, "add_note should not error");
  assert.match(addResult.content[0].text, /Saved note "Pool hours"/);

  await client.callTool({
    name: "add_note",
    arguments: { title: "Refunds", content: "Refunds are processed within 30 days of cancellation." },
  });

  const searchResult = await client.callTool({
    name: "search_notes",
    arguments: { query: "Is there somewhere to swim here?", topK: 3 },
  });
  const text = searchResult.content[0].text;
  assert.match(text, /Pool hours/, `expected the pool note to be the top semantic match, got:\n${text}`);
});

test("list_notes and delete_note: full lifecycle over the real protocol", async () => {
  const added = await client.callTool({
    name: "add_note",
    arguments: { title: "Temporary note", content: "This note will be deleted in this test." },
  });
  const idMatch = added.content[0].text.match(/id: ([0-9a-f-]+)/i);
  assert.ok(idMatch, "expected the add_note response to include the new id");
  const id = idMatch[1];

  const listed = await client.callTool({ name: "list_notes", arguments: {} });
  assert.match(listed.content[0].text, /Temporary note/);

  const deleted = await client.callTool({ name: "delete_note", arguments: { id } });
  assert.match(deleted.content[0].text, /Deleted note/);

  const deletedAgain = await client.callTool({ name: "delete_note", arguments: { id } });
  assert.equal(deletedAgain.isError, true, "deleting an already-deleted id should be reported as an error");
});

test("readResource: note://{id} returns the note's full content as an MCP resource", async () => {
  const added = await client.callTool({
    name: "add_note",
    arguments: { title: "Resource test", content: "Resources are a distinct MCP primitive from tools." },
  });
  const id = added.content[0].text.match(/id: ([0-9a-f-]+)/i)[1];

  const resource = await client.readResource({ uri: `note://${id}` });
  assert.match(resource.contents[0].text, /Resources are a distinct MCP primitive/);
});

test("Zod validation: calling add_note with a missing required field is rejected before it reaches store logic", async () => {
  // MCP reports tool-input validation failures as a normal result with
  // isError: true (an RPC-level error, code -32602), not a rejected
  // callTool() promise — that's reserved for transport/protocol failures.
  const result = await client.callTool({ name: "add_note", arguments: { title: "No content here" } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Invalid arguments for tool add_note/);
});
