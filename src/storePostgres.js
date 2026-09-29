/**
 * A Postgres/pgvector-backed note store — the production-scale swap-in for
 * NoteStore (store.js), used by the Vercel HTTP deployment because
 * serverless functions don't keep a persistent local disk between requests.
 *
 * Implements the exact same 4-method interface as NoteStore
 * (addNote/search/listNotes/getNote/deleteNote), matching db/schema.sql.
 * This is what lets createServer.js accept either store with zero changes
 * to any tool definition.
 *
 * IMPORTANT: this file was written to match the interface store.js already
 * has passing tests for, and follows the standard pgvector query pattern,
 * but it has NOT been run against a live database as part of this project's
 * test suite — that requires real Supabase/Postgres credentials, which
 * aren't available in the environment this was built in. Before relying on
 * it, run it once against your own database and confirm add/search/list/
 * delete all behave as expected (see README's Supabase setup section).
 */
import pg from "pg";
import { embed } from "./embeddings.js";

const { Pool } = pg;

export class PostgresNoteStore {
  /** @param {string} connectionString e.g. process.env.DATABASE_URL */
  constructor(connectionString) {
    if (!connectionString) {
      throw new Error("PostgresNoteStore requires a connection string (DATABASE_URL)");
    }
    this.pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false }, // Supabase requires TLS; see README for details
    });
  }

  async addNote({ title, content, tags = [] }) {
    const embedding = await embed(`${title}\n\n${content}`);
    const { rows } = await this.pool.query(
      `INSERT INTO notes (title, content, tags, embedding)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, tags, created_at`,
      [title, content, tags, toVectorLiteral(embedding)]
    );
    return {
      id: rows[0].id,
      title: rows[0].title,
      tags: rows[0].tags,
      createdAt: rows[0].created_at.toISOString(),
    };
  }

  async search(query, { topK = 5, minScore = 0.15 } = {}) {
    const embedding = await embed(query);
    // 1 - cosine_distance = cosine_similarity, matching cosineSimilarity()'s
    // scale in store.js so the two stores behave identically to callers.
    const { rows } = await this.pool.query(
      `SELECT id, title, content, tags, created_at,
              1 - (embedding <=> $1) AS score
       FROM notes
       WHERE 1 - (embedding <=> $1) >= $2
       ORDER BY embedding <=> $1
       LIMIT $3`,
      [toVectorLiteral(embedding), minScore, topK]
    );
    return rows.map(rowToNote);
  }

  async listNotes({ tag } = {}) {
    const { rows } = tag
      ? await this.pool.query(
          `SELECT id, title, content, tags, created_at FROM notes
           WHERE $1 = ANY(tags) ORDER BY created_at DESC`,
          [tag]
        )
      : await this.pool.query(
          `SELECT id, title, content, tags, created_at FROM notes ORDER BY created_at DESC`
        );
    return rows.map(rowToNote);
  }

  async getNote(id) {
    const { rows } = await this.pool.query(
      `SELECT id, title, content, tags, created_at FROM notes WHERE id = $1`,
      [id]
    );
    return rows[0] ? rowToNote(rows[0]) : null;
  }

  async deleteNote(id) {
    const { rowCount } = await this.pool.query(`DELETE FROM notes WHERE id = $1`, [id]);
    return rowCount > 0;
  }

  async close() {
    await this.pool.end();
  }
}

function rowToNote(row) {
  const note = {
    id: row.id,
    title: row.title,
    content: row.content,
    tags: row.tags,
    createdAt: row.created_at.toISOString(),
  };
  if (row.score !== undefined) note.score = Number(row.score);
  return note;
}

/** pgvector expects a literal like "[0.1,0.2,...]", not a JS array. */
function toVectorLiteral(embedding) {
  return `[${embedding.join(",")}]`;
}
