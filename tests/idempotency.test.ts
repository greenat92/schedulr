import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";

process.env.LOG_LEVEL = "error";
process.env.HOST_API_KEYS = "alice:alice-key";
process.env.MAX_IDEMPOTENCY_KEY_LENGTH = "16";

const { createApp, initDb } = await import("../src/app.js");

let app: ReturnType<typeof createApp>;

function at(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function createSlot() {
  return request(app)
    .post("/slots")
    .set("Authorization", "Bearer alice-key")
    .send({ host: "alice", start_at: at(1) });
}

function book(slotId: number, idempotencyKey?: string, guestName = "Bob") {
  const req = request(app)
    .post("/book")
    .send({ slot_id: slotId, guest_name: guestName, guest_email: "bob@example.com" });
  if (idempotencyKey !== undefined) req.set("Idempotency-Key", idempotencyKey);
  return req;
}

function bookings() {
  return request(app).get("/bookings/alice").set("Authorization", "Bearer alice-key");
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "schedulr-idem-"));
  process.env.DB_PATH = join(dir, "test.db");
  initDb();
  app = createApp();
});

test("replaying a request with the same key returns the original booking", async () => {
  const slot = await createSlot();

  const first = await book(slot.body.id, "key-1");
  const second = await book(slot.body.id, "key-1");

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.body.booking_id, first.body.booking_id);
  assert.equal((await bookings()).body.length, 1);
});

test("concurrent requests with the same key produce one booking", async () => {
  const slot = await createSlot();

  const results = await Promise.all([
    book(slot.body.id, "key-race"),
    book(slot.body.id, "key-race"),
    book(slot.body.id, "key-race"),
  ]);

  assert.ok(results.every((r) => r.status === 201));
  const ids = new Set(results.map((r) => r.body.booking_id));
  assert.equal(ids.size, 1);
  assert.equal((await bookings()).body.length, 1);
});

test("reusing a key with a different payload is rejected", async () => {
  const slot = await createSlot();

  const first = await book(slot.body.id, "key-2", "Bob");
  const second = await book(slot.body.id, "key-2", "Carol");

  assert.equal(first.status, 201);
  assert.equal(second.status, 422);
  assert.equal((await bookings()).body.length, 1);
});

test("rejects an over-long idempotency key", async () => {
  const slot = await createSlot();
  const r = await book(slot.body.id, "x".repeat(17));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Idempotency-Key/);
});

test("without a key, a second booking still conflicts", async () => {
  const slot = await createSlot();
  const first = await book(slot.body.id);
  const second = await book(slot.body.id, undefined, "Carol");
  assert.equal(first.status, 201);
  assert.equal(second.status, 409);
});
