/**
 * Local embedding generation — no API key, no cost, runs entirely on-device.
 *
 * Uses @xenova/transformers (a WASM/ONNX port of HuggingFace models) with
 * all-MiniLM-L6-v2, a small, fast sentence-embedding model producing 384-dim
 * vectors. The model is downloaded once (cached under node_modules/.cache or
 * the OS cache dir) and reused for every subsequent embed() call.
 *
 * This is the same embedding step described in the RAG architecture: text in,
 * a dense vector out, where semantic similarity becomes geometric closeness.
 */
import { pipeline } from "@xenova/transformers";

let embedderPromise = null;

/** Lazily loads the embedding pipeline once, and reuses it for all calls. */
function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  }
  return embedderPromise;
}

/**
 * Embeds a piece of text into a fixed-length vector (384 numbers).
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function embed(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("embed() requires a non-empty string");
  }
  const embedder = await getEmbedder();
  // mean-pool the token embeddings into one sentence vector, and normalize it
  // so cosine similarity and dot product agree (unit-length vectors).
  const output = await embedder(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

/**
 * Cosine similarity between two equal-length vectors, in [-1, 1].
 * Since embed() already returns normalized vectors, this is just a dot product,
 * but we compute it generally in case a caller passes in a non-normalized vector.
 */
export function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: length mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
