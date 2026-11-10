import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";

process.env.LOG_LEVEL = "error";
process.env.HOST_API_KEYS = "alice:alice-key";
process.env.AVAILABILITY_CACHE_TTL_MS = "60000";

const { createApp, initDb } = await import("../src/app.js");

let app: ReturnType<typeof createApp>;

function at(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function createSlot(startAt: string) {
  return request(app)
    .post("/slots")
    .set("Authorization", "Bearer alice-key")
    .send({ host: "alice", start_at: startAt });
}

function availability(query = "") {
  return request(app).get(`/availability/alice${query}`);
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "schedulr-cache-"));
  process.env.DB_PATH = join(dir, "test.db");
  initDb();
  app = createApp();
});

test("repeated availability reads are served from cache", async () => {
  await createSlot(at(1));

  const first = await availability();
  const second = await availability();
  assert.deepEqual(second.body, first.body);

  const metrics = await request(app).get("/metrics");
  assert.match(metrics.text, /availability_cache_total\{result="hit"\}/);
});

test("creating a slot invalidates the host's availability cache", async () => {
  await createSlot(at(1));
  assert.equal((await availability()).body.length, 1); // caches 1

  await createSlot(at(2));
  assert.equal((await availability()).body.length, 2);
});

test("booking a slot invalidates the host's availability cache", async () => {
  const first = await createSlot(at(1));
  await createSlot(at(2));
  assert.equal((await availability()).body.length, 2); // caches 2

  await request(app)
    .post("/book")
    .send({ slot_id: first.body.id, guest_name: "Bob", guest_email: "bob@example.com" });

  assert.equal((await availability()).body.length, 1);
});

test("different pagination parameters use distinct cache entries", async () => {
  await createSlot(at(1));
  await createSlot(at(2));
  await createSlot(at(3));

  assert.equal((await availability("?limit=1")).body.length, 1);
  assert.equal((await availability("?limit=2")).body.length, 2);
  assert.equal((await availability("?limit=1")).body.length, 1);
});
