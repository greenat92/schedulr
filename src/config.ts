export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LengthLimits {
  host: number;
  startAt: number;
  guestName: number;
  guestEmail: number;
  idempotencyKey: number;
  apiKey: number;
}

export interface AppConfig {
  port: number;
  logLevel: LogLevel;
  bodyLimit: string;
  requestTimeoutMs: number;
  rateLimit: { windowMs: number; max: number };
  availabilityCacheTtlMs: number;
  compressionThresholdBytes: number;
  limits: LengthLimits;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

function readInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

function readLogLevel(env: NodeJS.ProcessEnv): LogLevel {
  const raw = (env.LOG_LEVEL ?? "info").toLowerCase();
  if (!LOG_LEVELS.includes(raw as LogLevel)) {
    throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")} (got "${raw}")`);
  }
  return raw as LogLevel;
}

/**
 * Parses and validates configuration once at startup. Pure with respect to the
 * supplied env, so it is easy to test and fail fast on misconfiguration.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: readInt(env, "PORT", 8080, 1, 65_535),
    logLevel: readLogLevel(env),
    bodyLimit: env.BODY_LIMIT?.trim() || "16kb",
    requestTimeoutMs: readInt(env, "REQUEST_TIMEOUT_MS", 10_000, 100, 300_000),
    rateLimit: {
      windowMs: readInt(env, "RATE_LIMIT_WINDOW_MS", 60_000, 1_000, 3_600_000),
      max: readInt(env, "RATE_LIMIT_MAX", 1_000, 1, 1_000_000),
    },
    availabilityCacheTtlMs: readInt(env, "AVAILABILITY_CACHE_TTL_MS", 2_000, 0, 600_000),
    compressionThresholdBytes: readInt(env, "COMPRESSION_THRESHOLD_BYTES", 1_024, 0, 10_000_000),
    limits: {
      host: readInt(env, "MAX_HOST_LENGTH", 100, 1, 1_000),
      startAt: readInt(env, "MAX_START_AT_LENGTH", 64, 1, 1_000),
      guestName: readInt(env, "MAX_GUEST_NAME_LENGTH", 200, 1, 1_000),
      guestEmail: readInt(env, "MAX_GUEST_EMAIL_LENGTH", 254, 1, 1_000),
      idempotencyKey: readInt(env, "MAX_IDEMPOTENCY_KEY_LENGTH", 128, 1, 1_000),
      apiKey: readInt(env, "MAX_API_KEY_LENGTH", 256, 1, 1_000),
    },
  };
}
