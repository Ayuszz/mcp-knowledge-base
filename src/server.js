/**
 * MCP server entrypoint.
 *
 * Exposes a personal knowledge base to any MCP client (Claude Desktop,
 * Cursor, etc.) as:
 *   - 4 TOOLS (actions the model can call): add_note, search_notes,
 *     list_notes, delete_note
 *   - 1 RESOURCE TEMPLATE (readable data): note://{id}
 *
 * Search results are cached in Redis when REDIS_URL is set; without it the
 * cache silently disables itself (see cache.js) and the server still works,
 * just without the speed-up.
 *
 * Transport: stdio — the standard way an MCP host launches a local server as
 * a subprocess and talks JSON-RPC over stdin/stdout.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { NoteStore } from "./store.js";
import { SearchCache } from "./cache.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.KB_DATA_FILE || join(__dirname, "..", "data", "notes.json");

export function createServer({ dataFile = DATA_FILE, redisUrl = process.env.REDIS_URL } = {}) {
  const store = new NoteStore(dataFile);
  const cache = new SearchCache(redisUrl);

  const server = new McpServer({
    name: "personal-knowledge-base",
    version: "1.0.0",
  });

  // --- Tool: add_note ---------------------------------------------------
  server.registerTool(
    "add_note",
    {
      title: "Add note",
      description:
        "Store a new note in the personal knowledge base. The content is embedded " +
        "for later semantic search, so write it as a self-contained piece of text.",
      inputSchema: {
        title: z.string().min(1).max(200).describe("A short title for the note"),
        content: z.string().min(1).max(20000).describe("The full text content of the note"),
        tags: z.array(z.string()).optional().describe("Optional tags for filtering later"),
      },
    },
    async ({ title, content, tags }) => {
      const note = await store.addNote({ title, content, tags: tags ?? [] });
      await cache.invalidateAll(); // a new note can change what's most relevant for any query
      return {
        content: [
          { type: "text", text: `Saved note "${note.title}" (id: ${note.id}).` },
        ],
      };
    }
  );

  // --- Tool: search_notes -------------------------------------------------
  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description:
        "Semantically search the knowledge base — finds notes by MEANING, not just " +
        "exact keyword overlap, using vector similarity over embedded note content. " +
        "Returns the top-k most relevant notes with a similarity score.",
      inputSchema: {
        query: z.string().min(1).max(2000).describe("Natural-language search query"),
        topK: z.number().int().min(1).max(20).optional().describe("How many results to return (default 5)"),
      },
    },
    async ({ query, topK = 5 }) => {
      const cached = await cache.get(query, topK);
      if (cached) {
        return {
          content: [{ type: "text", text: formatResults(cached, { fromCache: true }) }],
        };
      }
      const results = await store.search(query, { topK });
      await cache.set(query, topK, results);
      return {
        content: [{ type: "text", text: formatResults(results, { fromCache: false }) }],
      };
    }
  );

  // --- Tool: list_notes -----------------------------------------------
  server.registerTool(
    "list_notes",
    {
      title: "List notes",
      description: "List stored notes, optionally filtered by tag, newest first.",
      inputSchema: {
        tag: z.string().optional().describe("Only return notes with this tag"),
      },
    },
    async ({ tag }) => {
      const notes = await store.listNotes({ tag });
      if (notes.length === 0) {
        return { content: [{ type: "text", text: "No notes found." }] };
      }
      const lines = notes.map((n) => `- [${n.id}] ${n.title}${n.tags.length ? ` (${n.tags.join(", ")})` : ""}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // --- Tool: delete_note -----------------------------------------------
  server.registerTool(
    "delete_note",
    {
      title: "Delete note",
      description: "Permanently delete a note by its id.",
      inputSchema: {
        id: z.string().uuid().describe("The note's id, from add_note or list_notes"),
      },
    },
    async ({ id }) => {
      const deleted = await store.deleteNote(id);
      if (deleted) await cache.invalidateAll();
      return {
        content: [
          {
            type: "text",
            text: deleted ? `Deleted note ${id}.` : `No note found with id ${id}.`,
          },
        ],
        isError: !deleted,
      };
    }
  );

  // --- Resource: note://{id} -------------------------------------------
  // Exposes a single note as readable MCP data, distinct from a tool call —
  // a client can fetch it directly by URI without "calling an action".
  server.registerResource(
    "note",
    new ResourceTemplate("note://{id}", {
      list: async () => {
        const notes = await store.listNotes();
        return {
          resources: notes.map((n) => ({
            uri: `note://${n.id}`,
            name: n.title,
            mimeType: "text/plain",
          })),
        };
      },
    }),
    {
      title: "Note",
      description: "A single note's full content, addressed by id.",
    },
    async (uri, { id }) => {
      const note = await store.getNote(id);
      if (!note) {
        throw new Error(`No note found with id ${id}`);
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/plain",
            text: `${note.title}\n\n${note.content}`,
          },
        ],
      };
    }
  );

  return { server, store, cache };
}

function formatResults(results, { fromCache }) {
  if (results.length === 0) return "No matching notes found.";
  const header = fromCache ? "(cached result)\n" : "";
  const lines = results.map(
    (r) => `- [${r.score.toFixed(3)}] "${r.title}" (id: ${r.id})\n  ${truncate(r.content, 200)}`
  );
  return header + lines.join("\n\n");
}

function truncate(text, max) {
  return text.length > max ? text.slice(0, max) + "..." : text;
}

// This file is the process entrypoint: an MCP host launches it directly as
// `node src/server.js`, over stdio. (createServer() above is exported
// separately for anything that wants the server instance without the
// transport attached, but nothing currently imports this file as a library.)
const { server } = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[mcp-knowledge-base] server running on stdio");
