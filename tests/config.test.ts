import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, loadConfig } from "../src/config.js";

test("loadConfig applies defaults", () => {
  const config = loadConfig({});
  assert.equal(config.port, 8080);
  assert.equal(config.logLevel, "info");
  assert.equal(config.rateLimit.max, 1000);
  assert.equal(config.limits.guestEmail, 254);
});

test("loadConfig accepts overrides", () => {
  const config = loadConfig({
    PORT: "9090",
    LOG_LEVEL: "warn",
    RATE_LIMIT_MAX: "50",
    MAX_GUEST_NAME_LENGTH: "10",
  });
  assert.equal(config.port, 9090);
  assert.equal(config.logLevel, "warn");
  assert.equal(config.rateLimit.max, 50);
  assert.equal(config.limits.guestName, 10);
});

test("loadConfig rejects invalid numbers", () => {
  assert.throws(() => loadConfig({ PORT: "not-a-number" }), ConfigError);
  assert.throws(() => loadConfig({ PORT: "70000" }), ConfigError);
  assert.throws(() => loadConfig({ RATE_LIMIT_MAX: "-1" }), ConfigError);
});

test("loadConfig rejects invalid log level", () => {
  assert.throws(() => loadConfig({ LOG_LEVEL: "verbose" }), ConfigError);
});
