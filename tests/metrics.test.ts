import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";

process.env.EMAIL_LATENCY_MS = "10";
process.env.EMAIL_FAILURE_RATE = "0";
process.env.HOST_API_KEYS = "alice:alice-key";
process.env.LOG_LEVEL = "error";

const { createApp, initDb } = await import("../src/app.js");

let app: ReturnType<typeof createApp>;

function at(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "schedulr-metrics-"));
  process.env.DB_PATH = join(dir, "test.db");
  initDb();
  app = createApp();
});

test("healthz reports ok", async () => {
  const r = await request(app).get("/healthz");
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "ok");
});

test("readyz verifies the database and reports ready", async () => {
  const r = await request(app).get("/readyz");
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "ready");
});

test("metrics endpoint exposes request and booking counters", async () => {
  const slot = await request(app)
    .post("/slots")
    .set("Authorization", "Bearer alice-key")
    .send({ host: "alice", start_at: at(1) });
  await request(app)
    .post("/book")
    .send({ slot_id: slot.body.id, guest_name: "Bob", guest_email: "bob@example.com" });

  const r = await request(app).get("/metrics");
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /text\/plain/);
  assert.match(r.text, /http_requests_total\{/);
  assert.match(r.text, /bookings_total\{result="success"\} 1/);
  assert.match(r.text, /http_request_duration_seconds_bucket\{/);
});

test("metrics count validation failures", async () => {
  await request(app).post("/slots").set("Authorization", "Bearer alice-key").send({});
  const r = await request(app).get("/metrics");
  assert.match(r.text, /slots_created_total\{result="invalid"\}/);
});
