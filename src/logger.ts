import type { LogLevel } from "./config.js";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// Keys whose values must never be written to logs (PII / credentials).
const SENSITIVE_KEY = /(pass(word)?|secret|token|authorization|api[-_]?key|e[-_]?mail)/i;

/** Recursively replaces sensitive values so callers can log objects safely. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(entry);
    }
    return result;
  }
  return value;
}

export type LogFields = Record<string, unknown>;

class Logger {
  private level: LogLevel;

  constructor(level: LogLevel = "info") {
    this.level = level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  debug(message: string, fields?: LogFields): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write("error", message, fields);
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) return;

    const entry = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...(redact(fields ?? {}) as Record<string, unknown>),
    };
    const line = `${JSON.stringify(entry)}\n`;
    if (level === "warn" || level === "error") {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  }
}

export const logger = new Logger();

export function configureLogger(level: LogLevel): void {
  logger.setLevel(level);
}
