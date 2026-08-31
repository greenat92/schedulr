import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";

process.env.EMAIL_LATENCY_MS = "10";
process.env.EMAIL_FAILURE_RATE = "0";

const { createApp, initDb } = await import("../src/app.js");

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "schedulr-"));
  process.env.DB_PATH = join(dir, "test.db");
  initDb();
  app = createApp();
});

test("create slot", async () => {
  const r = await request(app)
    .post("/slots")
    .send({ host: "alice", start_at: "2026-06-01T14:00:00", duration_minutes: 30 });
  assert.equal(r.status, 201);
  assert.ok("id" in r.body);
});

test("lists availability", async () => {
  await request(app).post("/slots").send({ host: "alice", start_at: "2026-06-01T14:00:00" });
  await request(app).post("/slots").send({ host: "alice", start_at: "2026-06-01T15:00:00" });

  const r = await request(app).get("/availability/alice");
  assert.equal(r.body.length, 2);
});

test("book slot", async () => {
  const slot = await request(app).post("/slots").send({ host: "alice", start_at: "2026-06-01T14:00:00" });
  const slotId = slot.body.id;

  const r = await request(app)
    .post("/book")
    .send({ slot_id: slotId, guest_name: "Bob", guest_email: "bob@example.com" });
  assert.equal(r.status, 201);
});

test("double book returns 409", async () => {
  const slot = await request(app).post("/slots").send({ host: "alice", start_at: "2026-06-01T14:00:00" });
  const slotId = slot.body.id;

  await request(app).post("/book").send({ slot_id: slotId, guest_name: "Bob", guest_email: "b@e.com" });
  const r = await request(app).post("/book").send({ slot_id: slotId, guest_name: "Carol", guest_email: "c@e.com" });
  assert.equal(r.status, 409);
});

test("lists bookings for host", async () => {
  const slot = await request(app).post("/slots").send({ host: "alice", start_at: "2026-06-01T14:00:00" });
  const slotId = slot.body.id;
  await request(app).post("/book").send({ slot_id: slotId, guest_name: "Bob", guest_email: "b@e.com" });

  const r = await request(app).get("/bookings/alice");
  assert.equal(r.body.length, 1);
});
