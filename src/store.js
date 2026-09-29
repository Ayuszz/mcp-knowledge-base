/**
 * A local, file-backed vector store.
 *
 * Real embeddings + real cosine-similarity top-k search — the same retrieval
 * logic a vector database like pgvector or Pinecone runs internally, just
 * without a separate server to install. This is a deliberate, documented
 * trade-off (see README): brute-force O(n) search is fine for a personal
 * knowledge base of hundreds/low-thousands of notes; an ANN index like HNSW
 * (via pgvector) is the swap-in upgrade once it needs to scale further.
 */
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { embed, cosineSimilarity } from "./embeddings.js";

export class NoteStore {
  /** @param {string} filePath where notes are persisted as JSON */
  constructor(filePath) {
    this.filePath = filePath;
    this.notes = null; // lazy-loaded, array of {id, title, content, tags, embedding, createdAt}
  }

  async _load() {
    if (this.notes) return this.notes;
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.notes = JSON.parse(raw);
    } catch (err) {
      if (err.code === "ENOENT") this.notes = [];
      else throw err;
    }
    return this.notes;
  }

  async _save() {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.notes, null, 2), "utf8");
  }

  /**
   * Embeds and stores a note.
   * @returns {Promise<{id: string, title: string, tags: string[], createdAt: string}>}
   */
  async addNote({ title, content, tags = [] }) {
    const notes = await this._load();
    const embedding = await embed(`${title}\n\n${content}`);
    const note = {
      id: randomUUID(),
      title,
      content,
      tags,
      embedding,
      createdAt: new Date().toISOString(),
    };
    notes.push(note);
    await this._save();
    return { id: note.id, title: note.title, tags: note.tags, createdAt: note.createdAt };
  }

  /**
   * Semantic search: embeds the query, ranks every note by cosine similarity,
   * returns the top-k. This is the exact "score every item, sort, slice(0, k)"
   * pattern from the RAG walkthrough, just running against real vectors.
   */
  async search(query, { topK = 5, minScore = 0.15 } = {}) {
    const notes = await this._load();
    if (notes.length === 0) return [];
    const queryVector = await embed(query);
    return notes
      .map((n) => ({ ...n, score: cosineSimilarity(queryVector, n.embedding) }))
      .filter((n) => n.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ embedding, ...rest }) => rest); // don't leak raw vectors to the caller
  }

  async listNotes({ tag } = {}) {
    const notes = await this._load();
    return notes
      .filter((n) => !tag || n.tags.includes(tag))
      .map(({ embedding, ...rest }) => rest)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getNote(id) {
    const notes = await this._load();
    const note = notes.find((n) => n.id === id);
    if (!note) return null;
    const { embedding, ...rest } = note;
    return rest;
  }

  /** @returns {Promise<boolean>} whether a note was actually deleted */
  async deleteNote(id) {
    const notes = await this._load();
    const before = notes.length;
    this.notes = notes.filter((n) => n.id !== id);
    if (this.notes.length === before) return false;
    await this._save();
    return true;
  }
}
