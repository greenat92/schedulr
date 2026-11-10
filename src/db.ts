import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { logger } from "./logger.js";
import { metrics } from "./metrics.js";
import { runMigrations } from "./migrations.js";

/**
 * One connection per database path, reused across requests. `DatabaseSync` is
 * synchronous, so a single in-process connection is effectively serialized
 * anyway; sharing it removes a file open/close from every request.
 */
const connections = new Map<string, DatabaseSync>();

export function dbPath(): string {
  return process.env.DB_PATH ?? "schedulr.db";
}

function resolvedDbPath(): string {
  return resolve(dbPath());
}

function configureConnection(db: DatabaseSync): void {
  db.exec("PRAGMA busy_timeout = 5000");
  // WAL lets readers proceed while a writer holds the write lock; NORMAL is the
  // conventional durability/speed trade-off for WAL.
  db.prepare("PRAGMA journal_mode = WAL").get();
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
}

export function getDb(): DatabaseSync {
  const path = resolvedDbPath();
  let db = connections.get(path);
  if (db === undefined) {
    db = new DatabaseSync(path);
    configureConnection(db);
    connections.set(path, db);
    metrics.inc("db_connections_opened_total");
  }
  return db;
}

export function closeDb(): void {
  const path = resolvedDbPath();
  const db = connections.get(path);
  if (db !== undefined) {
    db.close();
    connections.delete(path);
  }
}

function closeOtherConnections(activePath: string): void {
  for (const [path, db] of connections) {
    if (path === activePath) continue;
    db.close();
    connections.delete(path);
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

function isBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { errcode?: number }).errcode;
  return (
    code === 5 ||
    code === 6 ||
    /SQLITE_BUSY|database (table )?is locked/i.test(error.message)
  );
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface BusyRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
}

/**
 * Retries on transient SQLITE_BUSY/LOCKED. `busy_timeout` already waits inside
 * SQLite; this covers the remaining races (e.g. lock promotion in WAL). The
 * backoff is a short, bounded synchronous wait.
 */
export function withBusyRetry<T>(operation: () => T, options: BusyRetryOptions = {}): T {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 10;

  for (let attempt = 0; ; attempt++) {
    try {
      return operation();
    } catch (error) {
      if (!isBusyError(error) || attempt >= maxAttempts - 1) {
        throw error;
      }
      sleepSync(baseDelayMs * (attempt + 1));
    }
  }
}

function seedHosts(db: DatabaseSync): void {
  const raw = process.env.HOST_API_KEYS;
  const seeds: [string, string][] = [];

  if (raw && raw.trim() !== "") {
    for (const pair of raw.split(",")) {
      const separator = pair.indexOf(":");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const key = pair.slice(separator + 1).trim();
      if (name !== "" && key !== "") seeds.push([name, key]);
    }
  } else if (process.env.NODE_ENV !== "production") {
    // Development convenience only. Production must set HOST_API_KEYS.
    for (const name of ["alice", "bob", "carol", "dave", "dup"]) {
      seeds.push([name, `${name}-key`]);
    }
    logger.warn("HOST_API_KEYS not set; using development host keys (<host>-key)");
  }

  const upsert = db.prepare(
    "INSERT INTO hosts (name, api_key) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET api_key = excluded.api_key",
  );
  for (const [name, key] of seeds) {
    upsert.run(name, key);
  }
}

export function initDb(): void {
  const activePath = resolvedDbPath();
  closeOtherConnections(activePath);

  const db = getDb();
  runMigrations(db);
  seedHosts(db);
}
