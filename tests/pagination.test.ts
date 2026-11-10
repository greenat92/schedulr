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

function availability(query: string) {
  return request(app).get(`/availability/alice${query}`);
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "schedulr-pagination-"));
  process.env.DB_PATH = join(dir, "test.db");
  initDb();
  app = createApp();
});

test("availability pages using an opaque cursor", async () => {
  await createSlot(at(1));
  await createSlot(at(2));
  await createSlot(at(3));

  const first = await availability("?limit=2");
  assert.equal(first.body.length, 2);
  const cursor = first.headers["x-next-cursor"];
  assert.equal(typeof cursor, "string");

  const second = await availability(`?limit=2&cursor=${cursor}`);
  assert.equal(second.body.length, 1);
  assert.equal(second.headers["x-next-cursor"], undefined);
  assert.notEqual(second.body[0].id, first.body[0].id);
});

test("offset pagination still works", async () => {
  await createSlot(at(1));
  await createSlot(at(2));
  await createSlot(at(3));

  const response = await availability("?limit=1&offset=1");
  assert.equal(response.body.length, 1);
});

test("an invalid cursor is rejected", async () => {
  const response = await availability("?cursor=not-a-real-cursor");
  assert.equal(response.status, 400);
  assert.match(response.body.error, /cursor/);
});

test("bookings page using an opaque cursor", async () => {
  for (let i = 1; i <= 2; i++) {
    const slot = await createSlot(at(i));
    await request(app)
      .post("/book")
      .send({ slot_id: slot.body.id, guest_name: `Guest ${i}`, guest_email: `g${i}@example.com` });
  }

  const first = await request(app)
    .get("/bookings/alice?limit=1")
    .set("Authorization", "Bearer alice-key");
  assert.equal(first.body.length, 1);
  const cursor = first.headers["x-next-cursor"];
  assert.equal(typeof cursor, "string");

  const second = await request(app)
    .get(`/bookings/alice?limit=1&cursor=${cursor}`)
    .set("Authorization", "Bearer alice-key");
  assert.equal(second.body.length, 1);
  assert.equal(second.headers["x-next-cursor"], undefined);
});
