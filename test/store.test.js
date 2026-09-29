import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoteStore } from "../src/store.js";

async function withTempStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), "mcp-kb-test-"));
  const store = new NoteStore(join(dir, "notes.json"));
  try {
    await fn(store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("addNote: stores a note and returns it without the raw embedding", async () => {
  await withTempStore(async (store) => {
    const note = await store.addNote({ title: "Wifi", content: "The wifi password is guestwifi2026." });
    assert.ok(note.id);
    assert.equal(note.title, "Wifi");
    assert.deepEqual(note.tags, []);
    assert.ok(!("embedding" in note), "addNote() should not leak the raw vector");
  });
});

test("search: finds a semantically related note above an unrelated one, real embeddings end to end", async () => {
  await withTempStore(async (store) => {
    await store.addNote({
      title: "Pool hours",
      content: "Our outdoor swimming pool is open from 7am to 9pm daily.",
      tags: ["amenity"],
    });
    await store.addNote({
      title: "Refund policy",
      content: "Refunds are available within 30 days of booking, minus a processing fee.",
      tags: ["policy"],
    });
    await store.addNote({
      title: "Parking",
      content: "Free self-parking is available in the north garage.",
      tags: ["amenity"],
    });

    const results = await store.search("Is there somewhere to swim?", { topK: 5 });
    assert.ok(results.length > 0, "expected at least one result");
    assert.equal(results[0].title, "Pool hours", `expected Pool hours to rank first, got: ${JSON.stringify(results.map(r => r.title))}`);
    assert.ok(!("embedding" in results[0]), "search() should not leak raw vectors");
    // scores should be sorted descending
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i - 1].score >= results[i].score, "results must be sorted by score descending");
    }
  });
});

test("search: respects topK", async () => {
  await withTempStore(async (store) => {
    for (const title of ["A", "B", "C", "D"]) {
      await store.addNote({ title, content: `This is note ${title} about hotel amenities and services.` });
    }
    const results = await store.search("hotel amenities", { topK: 2, minScore: -1 });
    assert.equal(results.length, 2);
  });
});

test("search: on an empty store returns an empty array, doesn't throw", async () => {
  await withTempStore(async (store) => {
    const results = await store.search("anything");
    assert.deepEqual(results, []);
  });
});

test("listNotes: filters by tag and sorts newest first", async () => {
  await withTempStore(async (store) => {
    const first = await store.addNote({ title: "First", content: "content one", tags: ["a"] });
    await new Promise((r) => setTimeout(r, 5)); // ensure a distinct createdAt ordering
    const second = await store.addNote({ title: "Second", content: "content two", tags: ["b"] });

    const all = await store.listNotes();
    assert.equal(all.length, 2);
    assert.equal(all[0].id, second.id, "expected newest note first");

    const onlyA = await store.listNotes({ tag: "a" });
    assert.equal(onlyA.length, 1);
    assert.equal(onlyA[0].id, first.id);
  });
});

test("deleteNote: removes an existing note and returns true; returns false for an unknown id", async () => {
  await withTempStore(async (store) => {
    const note = await store.addNote({ title: "Temp", content: "delete me" });
    assert.equal(await store.deleteNote(note.id), true);
    assert.equal(await store.getNote(note.id), null);
    assert.equal(await store.deleteNote(note.id), false, "deleting again should report false, not throw");
  });
});

test("persistence: a new NoteStore instance pointed at the same file sees prior notes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-kb-test-"));
  const file = join(dir, "notes.json");
  try {
    const storeA = new NoteStore(file);
    await storeA.addNote({ title: "Persisted", content: "this should survive a reload" });

    const storeB = new NoteStore(file);
    const notes = await storeB.listNotes();
    assert.equal(notes.length, 1);
    assert.equal(notes[0].title, "Persisted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
