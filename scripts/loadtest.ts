/**
 * Repeatable mixed-load harness.
 *
 * Spawns TWO server processes sharing one SQLite file, drives a deterministic
 * mix of reads/writes against both, then checks data-integrity invariants and
 * reports latency + the metrics each process exposes.
 *
 * Run: npm run loadtest
 * Tunables (env): LOADTEST_CONCURRENCY, LOADTEST_OPS, LOADTEST_SLOTS, LOADTEST_SEED
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";

import { initDb } from "../src/app.js";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DB_PATH = join(mkdtempSync(join(tmpdir(), "schedulr-load-")), "load.db");
process.env.DB_PATH = DB_PATH;
// Shared host credentials used by the harness and inherited by both servers.
process.env.HOST_API_KEYS =
  "alice:alice-key,bob:bob-key,carol:carol-key,dave:dave-key,dup:dup-key";
initDb();

function intEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const CONFIG = {
  concurrency: intEnv("LOADTEST_CONCURRENCY", 32),
  operations: intEnv("LOADTEST_OPS", 2000),
  slots: intEnv("LOADTEST_SLOTS", 240),
  seed: intEnv("LOADTEST_SEED", 12345),
  emailLatencyMs: intEnv("EMAIL_LATENCY_MS", 5),
  emailFailureRate: process.env.EMAIL_FAILURE_RATE ?? "0.02",
};

const HOSTS = ["alice", "bob", "carol", "dave"];
const CONTENDED_ATTEMPTS = 12;

interface HttpResult {
  status: number;
  ms: number;
  body: unknown;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const index = Math.min(sortedAsc.length - 1, Math.ceil(p * sortedAsc.length) - 1);
  return sortedAsc[index];
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function http(
  port: number,
  method: string,
  path: string,
  payload?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<HttpResult> {
  const started = performance.now();
  try {
    const headers: Record<string, string> = { ...extraHeaders };
    if (payload !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // keep raw text
    }
    return { status: response.status, ms: performance.now() - started, body };
  } catch (error) {
    return {
      status: 0,
      ms: performance.now() - started,
      body: undefined,
      error: (error as Error).message,
    };
  }
}

const children: ChildProcess[] = [];

function startServer(port: number): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH,
      EMAIL_LATENCY_MS: String(CONFIG.emailLatencyMs),
      EMAIL_FAILURE_RATE: CONFIG.emailFailureRate,
      LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
      // The harness intentionally exceeds normal per-IP limits.
      RATE_LIMIT_MAX: process.env.RATE_LIMIT_MAX ?? "1000000",
      NODE_ENV: "production",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (text.includes("ExperimentalWarning")) return;
    process.stderr.write(`[server:${port}] ${text}`);
  });

  children.push(child);
  return child;
}

async function waitForReady(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  throw new Error(`server on ${port} did not become ready in ${timeoutMs}ms`);
}

interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

function parseMetrics(text: string): Sample[] {
  const samples: Sample[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{.*\})?\s+(\S+)$/.exec(trimmed);
    if (!match) continue;

    const name = match[1]!;
    const labelText = match[2] ?? "";
    const rawValue = match[3]!;
    const value = rawValue === "+Inf" ? Infinity : Number.parseFloat(rawValue);
    if (!Number.isFinite(value)) continue;

    const labels: Record<string, string> = {};
    const labelPattern = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
    let labelMatch: RegExpExecArray | null;
    while ((labelMatch = labelPattern.exec(labelText)) !== null) {
      labels[labelMatch[1]!] = labelMatch[2]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }

    samples.push({ name, labels, value });
  }
  return samples;
}

async function scrape(port: number): Promise<Sample[]> {
  const response = await fetch(`http://127.0.0.1:${port}/metrics`);
  return parseMetrics(await response.text());
}

function deltaSum(
  before: Sample[],
  after: Sample[],
  name: string,
  labelName?: string,
  labelValue?: string,
): number {
  const matches = (sample: Sample) =>
    sample.name === name && (labelName === undefined || sample.labels[labelName] === labelValue);
  const sum = (samples: Sample[]) =>
    samples.filter(matches).reduce((total, sample) => total + sample.value, 0);
  return sum(after) - sum(before);
}

function labelValues(samples: Sample[], name: string, labelName: string): string[] {
  return [
    ...new Set(
      samples.filter((sample) => sample.name === name).map((sample) => sample.labels[labelName] ?? ""),
    ),
  ].filter((value) => value !== "");
}

function lastGauge(samples: Sample[], name: string): number {
  const found = samples.filter((sample) => sample.name === name);
  return found.length > 0 ? found[found.length - 1]!.value : 0;
}

function readOutboxCounts(): Record<string, number> {
  const db = new DatabaseSync(DB_PATH);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const rows = db
      .prepare("SELECT status, COUNT(*) AS n FROM email_outbox GROUP BY status")
      .all() as { status: string; n: number }[];
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.status] = row.n;
    return counts;
  } finally {
    db.close();
  }
}

/** Waits (bounded) for the worker to drain pending email so counts are final. */
async function drainOutbox(timeoutMs: number): Promise<Record<string, number>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const counts = readOutboxCounts();
      if ((counts.pending ?? 0) + (counts.sending ?? 0) === 0 || Date.now() > deadline) {
        return counts;
      }
    } catch {
      if (Date.now() > deadline) throw new Error("timed out reading email outbox");
    }
    await sleep(200);
  }
}

/** Estimate a percentile from cumulative histogram buckets, summed across processes. */
function histogramPercentile(
  before: Sample[][],
  after: Sample[][],
  metric: string,
  p: number,
): number {
  const byLe = new Map<string, number>();
  const keyOf = (sample: Sample) => `${sample.name}|${JSON.stringify(sample.labels)}`;

  for (let i = 0; i < after.length; i++) {
    const beforeMap = new Map(before[i]!.map((sample) => [keyOf(sample), sample.value]));
    for (const sample of after[i]!) {
      if (sample.name !== `${metric}_bucket`) continue;
      const le = sample.labels.le ?? "";
      const previous = beforeMap.get(keyOf(sample)) ?? 0;
      byLe.set(le, (byLe.get(le) ?? 0) + (sample.value - previous));
    }
  }

  const total = byLe.get("+Inf") ?? 0;
  if (total <= 0) return 0;
  const target = p * total;
  const finite = [...byLe.entries()]
    .filter(([le]) => le !== "+Inf")
    .map(([le, count]) => [Number(le), count] as const)
    .sort((a, b) => a[0] - b[0]);

  for (const [le, count] of finite) {
    if (count >= target) return le;
  }
  return Number.POSITIVE_INFINITY;
}

type Op =
  | { kind: "availability"; host: string }
  | { kind: "bookings"; host: string }
  | { kind: "book"; slotId: number; name: string; email: string }
  | { kind: "createSlot"; host: string; startAt: string };

async function runOp(op: Op, port: number): Promise<HttpResult> {
  switch (op.kind) {
    case "availability":
      return http(port, "GET", `/availability/${op.host}`);
    case "bookings":
      return http(port, "GET", `/bookings/${op.host}`, undefined, {
        authorization: `Bearer ${op.host}-key`,
      });
    case "book":
      return http(port, "POST", "/book", {
        slot_id: op.slotId,
        guest_name: op.name,
        guest_email: op.email,
      });
    case "createSlot":
      return http(
        port,
        "POST",
        "/slots",
        {
          host: op.host,
          start_at: op.startAt,
          duration_minutes: 30,
        },
        { authorization: `Bearer ${op.host}-key` },
      );
  }
}

function expectedStatuses(kind: Op["kind"]): number[] {
  switch (kind) {
    case "book":
    case "createSlot":
      return [201, 409];
    default:
      return [200];
  }
}

async function main(): Promise<void> {
  const ports = [await getFreePort(), await getFreePort()];
  console.log(`DB: ${DB_PATH}`);
  console.log(`Starting 2 servers on ports ${ports.join(", ")} ...`);

  startServer(ports[0]!);
  startServer(ports[1]!);
  await Promise.all(ports.map((port) => waitForReady(port)));
  console.log("Both servers ready.\n");

  const baseTime = Date.now() + 60 * 60 * 1000;

  // --- Seed slots across both processes -----------------------------------
  const slotIds: number[] = [];
  for (let i = 0; i < CONFIG.slots; i++) {
    const host = HOSTS[i % HOSTS.length]!;
    const startAt = new Date(baseTime + i * 60_000).toISOString();
    const result = await http(
      ports[i % ports.length]!,
      "POST",
      "/slots",
      {
        host,
        start_at: startAt,
        duration_minutes: 30,
      },
      { authorization: `Bearer ${host}-key` },
    );
    if (result.status === 201) {
      slotIds.push((result.body as { id: number }).id);
    } else {
      throw new Error(`failed to seed slot ${i}: ${result.status} ${JSON.stringify(result.body)}`);
    }
  }
  console.log(`Seeded ${slotIds.length} slots.`);

  // --- Cross-process contention on a single slot --------------------------
  const contendedSlot = await http(
    ports[0]!,
    "POST",
    "/slots",
    {
      host: "alice",
      start_at: new Date(baseTime + (CONFIG.slots + 1) * 60_000).toISOString(),
    },
    { authorization: "Bearer alice-key" },
  );
  const contendedId = (contendedSlot.body as { id: number }).id;
  const contendedAttempts = await Promise.all(
    Array.from({ length: CONTENDED_ATTEMPTS }, (_, i) =>
      http(ports[i % ports.length]!, "POST", "/book", {
        slot_id: contendedId,
        guest_name: `Contended ${i}`,
        guest_email: `contended${i}@example.com`,
      }),
    ),
  );
  const contendedSuccesses = contendedAttempts.filter((result) => result.status === 201).length;
  const contendedConflicts = contendedAttempts.filter((result) => result.status === 409).length;
  const contendedOk =
    contendedSuccesses === 1 &&
    contendedConflicts === CONTENDED_ATTEMPTS - 1 &&
    contendedAttempts.every((result) => expectedStatuses("book").includes(result.status));

  // --- Cross-process duplicate slot creation ------------------------------
  const duplicateStartAt = new Date(baseTime + (CONFIG.slots + 2) * 60_000).toISOString();
  const duplicateAttempts = await Promise.all(
    ports.map((port) =>
      http(
        port,
        "POST",
        "/slots",
        { host: "dup", start_at: duplicateStartAt },
        { authorization: "Bearer dup-key" },
      ),
    ),
  );
  const duplicateStatuses = duplicateAttempts.map((result) => result.status).sort((a, b) => a - b);
  const duplicateOk = duplicateStatuses[0] === 201 && duplicateStatuses[1] === 409;

  // --- Build deterministic mixed workload ---------------------------------
  const rng = mulberry32(CONFIG.seed);
  const ops: Op[] = [];
  let createdSlots = 0;
  for (let i = 0; i < CONFIG.operations; i++) {
    const roll = rng();
    if (roll < 0.6) {
      ops.push({ kind: "availability", host: HOSTS[Math.floor(rng() * HOSTS.length)]! });
    } else if (roll < 0.75) {
      ops.push({ kind: "bookings", host: HOSTS[Math.floor(rng() * HOSTS.length)]! });
    } else if (roll < 0.95) {
      ops.push({
        kind: "book",
        slotId: slotIds[Math.floor(rng() * slotIds.length)]!,
        name: `Guest ${i}`,
        email: `guest${i}@example.com`,
      });
    } else {
      createdSlots += 1;
      ops.push({
        kind: "createSlot",
        host: HOSTS[Math.floor(rng() * HOSTS.length)]!,
        startAt: new Date(baseTime + 24 * 60 * 60 * 1000 + createdSlots * 60_000).toISOString(),
      });
    }
  }

  const before = await Promise.all(ports.map((port) => scrape(port)));

  // --- Run workload -------------------------------------------------------
  const latencies: number[] = [];
  const kindStats = new Map<string, { count: number; latencies: number[] }>();
  const statuses = new Map<string, number>();
  const unexpected: string[] = [];
  let networkErrors = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= ops.length) return;
      const op = ops[index]!;
      const port = ports[index % ports.length]!;
      const result = await runOp(op, port);

      latencies.push(result.ms);
      const stat = kindStats.get(op.kind) ?? { count: 0, latencies: [] };
      stat.count += 1;
      stat.latencies.push(result.ms);
      kindStats.set(op.kind, stat);

      const statusKey = `${op.kind}:${result.status}`;
      statuses.set(statusKey, (statuses.get(statusKey) ?? 0) + 1);

      if (result.status === 0) {
        networkErrors += 1;
        unexpected.push(`${op.kind} -> network error: ${result.error}`);
      } else if (!expectedStatuses(op.kind).includes(result.status)) {
        unexpected.push(`${op.kind} -> ${result.status} ${JSON.stringify(result.body)}`);
      }
    }
  }

  // Sample event-loop lag from both processes while the load runs.
  const maxLag = new Map<number, number>(ports.map((port) => [port, 0]));
  let monitoring = true;
  const monitor = (async () => {
    while (monitoring) {
      for (const port of ports) {
        try {
          const lag = lastGauge(await scrape(port), "event_loop_lag_seconds");
          maxLag.set(port, Math.max(maxLag.get(port) ?? 0, lag));
        } catch {
          // ignore scrape hiccups during load
        }
      }
      await sleep(200);
    }
  })();

  const loadStarted = performance.now();
  await Promise.all(Array.from({ length: CONFIG.concurrency }, () => worker()));
  const loadSeconds = (performance.now() - loadStarted) / 1000;
  monitoring = false;
  await monitor;

  // Let the background outbox worker finish (bounded) so email counts are final.
  const outbox = await drainOutbox(25_000);
  const after = await Promise.all(ports.map((port) => scrape(port)));

  // --- Data-integrity checks ---------------------------------------------
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA busy_timeout = 5000");
  const duplicateBookings = db
    .prepare("SELECT slot_id, COUNT(*) AS c FROM bookings GROUP BY slot_id HAVING c > 1")
    .all() as { slot_id: number; c: number }[];
  const stranded = db
    .prepare(
      "SELECT COUNT(*) AS n FROM slots WHERE booked = 1 AND id NOT IN (SELECT DISTINCT slot_id FROM bookings)",
    )
    .get() as { n: number };
  const unflagged = db
    .prepare(
      "SELECT COUNT(*) AS n FROM slots WHERE booked = 0 AND id IN (SELECT DISTINCT slot_id FROM bookings)",
    )
    .get() as { n: number };
  const totalBookings = db.prepare("SELECT COUNT(*) AS n FROM bookings").get() as { n: number };
  db.close();

  // --- Report -------------------------------------------------------------
  latencies.sort((a, b) => a - b);
  const totalRequests = latencies.length;
  const totalMs = latencies.reduce((total, value) => total + value, 0);
  const fiveHundreds = [...statuses.entries()]
    .filter(([key]) => key.endsWith(":500"))
    .reduce((total, [, count]) => total + count, 0);

  console.log("\n=== Load summary ===");
  console.log(`Requests:     ${totalRequests} in ${loadSeconds.toFixed(2)}s`);
  console.log(`Throughput:   ${(totalRequests / loadSeconds).toFixed(0)} req/s (concurrency ${CONFIG.concurrency})`);
  console.log(`Mean latency: ${(totalMs / totalRequests).toFixed(2)} ms`);
  console.log(`p50 / p95 / p99: ${percentile(latencies, 0.5).toFixed(2)} / ${percentile(latencies, 0.95).toFixed(2)} / ${percentile(latencies, 0.99).toFixed(2)} ms (client-observed)`);
  const serverP50 = histogramPercentile(before, after, "http_request_duration_seconds", 0.5) * 1000;
  const serverP95 = histogramPercentile(before, after, "http_request_duration_seconds", 0.95) * 1000;
  const serverP99 = histogramPercentile(before, after, "http_request_duration_seconds", 0.99) * 1000;
  console.log(`Server p50/p95/p99: ${serverP50.toFixed(2)} / ${serverP95.toFixed(2)} / ${serverP99.toFixed(2)} ms (from histograms)`);
  console.log(`5xx:          ${fiveHundreds}`);
  console.log(`Network errs: ${networkErrors}`);

  console.log("\n--- Latency by operation ---");
  for (const [kind, stat] of [...kindStats.entries()].sort()) {
    stat.latencies.sort((a, b) => a - b);
    console.log(
      `${kind.padEnd(12)} n=${String(stat.count).padStart(4)}  p50=${percentile(stat.latencies, 0.5).toFixed(1)}ms  p95=${percentile(stat.latencies, 0.95).toFixed(1)}ms  p99=${percentile(stat.latencies, 0.99).toFixed(1)}ms`,
    );
  }

  console.log("\n--- Status breakdown ---");
  for (const [key, count] of [...statuses.entries()].sort()) {
    console.log(`${key.padEnd(20)} ${count}`);
  }

  console.log("\n=== Metrics (delta over load) ===");
  const metricNames = [
    "http_requests_total",
    "bookings_total",
    "slots_created_total",
    "email_deliveries_total",
    "availability_cache_total",
  ];
  const labelNames: Record<string, string> = {
    http_requests_total: "status",
    bookings_total: "result",
    slots_created_total: "result",
    email_deliveries_total: "result",
    availability_cache_total: "result",
  };
  ports.forEach((port, i) => {
    console.log(`\nserver :${port}`);
    for (const name of metricNames) {
      const labelName = labelNames[name]!;
      const values = labelValues(after[i]!, name, labelName);
      if (values.length === 0) continue;
      const parts = values
        .map((value) => `${value}=${deltaSum(before[i]!, after[i]!, name, labelName, value)}`)
        .join("  ");
      console.log(`  ${name.padEnd(26)} ${parts}`);
    }
    console.log(`  db_connections_opened_total ${deltaSum(before[i]!, after[i]!, "db_connections_opened_total")}`);
    console.log(`  max event_loop_lag_seconds ${(maxLag.get(port) ?? 0).toFixed(4)}`);
  });

  console.log("\n=== Invariants ===");
  const outboxSent = outbox.sent ?? 0;
  const outboxFailed = outbox.failed ?? 0;
  const outboxPending = (outbox.pending ?? 0) + (outbox.sending ?? 0);
  console.log(
    `Email outbox: sent=${outboxSent} failed=${outboxFailed} pending=${outboxPending}`,
  );
  const invariants: [string, boolean, string][] = [
    [
      "cross-process contended slot: exactly one booking",
      contendedOk,
      `success=${contendedSuccesses} conflict=${contendedConflicts}`,
    ],
    [
      "cross-process duplicate slot rejected",
      duplicateOk,
      `statuses=${duplicateStatuses.join(",")}`,
    ],
    [
      "no slot booked more than once",
      duplicateBookings.length === 0,
      `duplicates=${JSON.stringify(duplicateBookings)}`,
    ],
    ["no stranded booked slots", stranded.n === 0, `stranded=${stranded.n}`],
    ["booked flag matches bookings", unflagged.n === 0, `unflagged=${unflagged.n}`],
    ["no 5xx responses", fiveHundreds === 0, `count=${fiveHundreds}`],
    ["no network errors", networkErrors === 0, `count=${networkErrors}`],
    ["no unexpected statuses", unexpected.length === 0, `count=${unexpected.length}`],
    [
      "all emails reached a terminal state",
      outboxPending === 0,
      `pending=${outboxPending}`,
    ],
  ];

  let failed = false;
  for (const [label, ok, detail] of invariants) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label} (${detail})`);
    if (!ok) failed = true;
  }
  if (unexpected.length > 0) {
    console.log("\nUnexpected responses (first 10):");
    for (const line of unexpected.slice(0, 10)) console.log(`  ${line}`);
  }

  console.log(`\nTotal bookings recorded: ${totalBookings.n}`);
  console.log(failed ? "\nLOAD TEST FAILED" : "\nLOAD TEST PASSED");
  if (failed) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error("Load test crashed:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const child of children) {
      child.kill("SIGTERM");
    }
    setTimeout(() => {
      for (const child of children) {
        if (!child.killed) child.kill("SIGKILL");
      }
    }, 1000).unref();
  });
