import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";

process.env.LOG_LEVEL = "error";
process.env.HOST_API_KEYS = "alice:alice-key";

const { createApp, initDb } = await import("../src/app.js");

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "schedulr-ui-"));
  process.env.DB_PATH = join(dir, "test.db");
  initDb();
  app = createApp();
});

test("serves the single-page UI at the root", async () => {
  const response = await request(app).get("/");
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /text\/html/);
  assert.match(response.text, /schedulr/);
});

test("serves the client script", async () => {
  const response = await request(app).get("/app.js");
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /javascript/);
});

test("serves the scenario lab", async () => {
  const response = await request(app).get("/lab.html");
  assert.equal(response.status, 200);
  assert.match(response.text, /scenario lab/i);
});

test("config exposes operational settings without secrets", async () => {
  const response = await request(app).get("/config");
  assert.equal(response.status, 200);
  assert.equal(response.body.schemaVersion, 1);
  assert.ok(response.body.rateLimit.max >= 1);
  assert.equal(JSON.stringify(response.body).includes("alice-key"), false);
});
