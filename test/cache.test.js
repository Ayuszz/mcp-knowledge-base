import { test } from "node:test";
import assert from "node:assert/strict";
import { SearchCache } from "../src/cache.js";

test("SearchCache: with no REDIS_URL, is disabled and every call is a safe no-op", async () => {
  const cache = new SearchCache(undefined);
  assert.equal(cache.enabled, false);

  // get() on a disabled cache must return null, never throw
  const hit = await cache.get("some query", 5);
  assert.equal(hit, null);

  // set()/invalidateAll() must resolve quietly, never throw
  await assert.doesNotReject(() => cache.set("some query", 5, [{ id: "x" }]));
  await assert.doesNotReject(() => cache.invalidateAll());
});

test("SearchCache: with an unreachable Redis URL, disables itself instead of throwing (fail-open)", async () => {
  // A port nothing is listening on — connection must fail, and the cache
  // must swallow that failure and behave as disabled, not crash the caller.
  const cache = new SearchCache("redis://127.0.0.1:1"); // port 1 is reserved/unroutable
  const hit = await cache.get("query", 5);
  assert.equal(hit, null);
  assert.equal(cache.enabled, false, "cache should self-disable after a failed connection");
});

test("SearchCache.keyFor: normalizes whitespace/case so wording variants collide", () => {
  const a = SearchCache.keyFor("  What is RAG?  ", 5);
  const b = SearchCache.keyFor("what is rag?", 5);
  assert.equal(a, b);
});

test("SearchCache.keyFor: different topK values produce different keys", () => {
  const a = SearchCache.keyFor("same query", 3);
  const b = SearchCache.keyFor("same query", 10);
  assert.notEqual(a, b);
});
