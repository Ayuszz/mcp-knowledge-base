import { test } from "node:test";
import assert from "node:assert/strict";
import { cosineSimilarity, embed } from "../src/embeddings.js";

test("cosineSimilarity: identical vectors score 1", () => {
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
});

test("cosineSimilarity: orthogonal vectors score 0", () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test("cosineSimilarity: opposite vectors score -1", () => {
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
});

test("cosineSimilarity: throws on mismatched lengths", () => {
  assert.throws(() => cosineSimilarity([1, 2], [1, 2, 3]), /length mismatch/);
});

test("cosineSimilarity: zero vector returns 0, not NaN", () => {
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
});

test("embed: rejects empty input", async () => {
  await assert.rejects(() => embed(""), /non-empty string/);
  await assert.rejects(() => embed("   "), /non-empty string/);
});

test("embed: real model produces a 384-dim vector, and related text scores higher than unrelated text", async () => {
  const pool = await embed("The hotel has a swimming pool open until 9pm.");
  const swim = await embed("Is there a place to swim?");
  const unrelated = await embed("What is the capital of France?");

  assert.equal(pool.length, 384);
  const simRelated = cosineSimilarity(pool, swim);
  const simUnrelated = cosineSimilarity(pool, unrelated);
  assert.ok(
    simRelated > simUnrelated,
    `expected related similarity (${simRelated}) > unrelated (${simUnrelated})`
  );
  assert.ok(simRelated > 0.3, `expected a meaningfully positive similarity, got ${simRelated}`);
});
