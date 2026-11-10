import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";

process.env.EMAIL_LATENCY_MS = "10";
process.env.EMAIL_FAILURE_RATE = "0";
process.env.HOST_API_KEYS = "alice:alice-key,bob:bob-key";
process.env.LOG_LEVEL = "error";

const { createApp, initDb } = await import("../src/app.js");

let app: ReturnType<typeof createApp>;

/** ISO timestamp `hours` in the future, kept relative so fixtures never expire. */
function at(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function token(host: string): string {
  return `${host}-key`;
}

function createSlot(host: string, startAt: string, durationMinutes?: number) {
  const body: Record<string, unknown> = { host, start_at: startAt };
  if (durationMinutes !== undefined) body.duration_minutes = durationMinutes;
  return request(app).post("/slots").set("Authorization", `Bearer ${token(host)}`).send(body);
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "schedulr-"));
  process.env.DB_PATH = join(dir, "test.db");
  initDb();
  app = createApp();
});

test("create slot", async () => {
  const r = await createSlot("alice", at(1), 30);
  assert.equal(r.status, 201);
  assert.ok("id" in r.body);
});

test("lists availability", async () => {
  await createSlot("alice", at(1));
  await createSlot("alice", at(2));

  const r = await request(app).get("/availability/alice");
  assert.equal(r.body.length, 2);
});

test("book slot", async () => {
  const slot = await createSlot("alice", at(1));
  const slotId = slot.body.id;

  const r = await request(app)
    .post("/book")
    .send({ slot_id: slotId, guest_name: "Bob", guest_email: "bob@example.com" });
  assert.equal(r.status, 201);
});

test("double book returns 409", async () => {
  const slot = await createSlot("alice", at(1));
  const slotId = slot.body.id;

  await request(app).post("/book").send({ slot_id: slotId, guest_name: "Bob", guest_email: "b@e.com" });
  const r = await request(app).post("/book").send({ slot_id: slotId, guest_name: "Carol", guest_email: "c@e.com" });
  assert.equal(r.status, 409);
});

test("lists bookings for host", async () => {
  const slot = await createSlot("alice", at(1));
  const slotId = slot.body.id;
  await request(app).post("/book").send({ slot_id: slotId, guest_name: "Bob", guest_email: "b@e.com" });

  const r = await request(app).get("/bookings/alice").set("Authorization", `Bearer ${token("alice")}`);
  assert.equal(r.body.length, 1);
});
