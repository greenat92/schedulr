import type { Request } from "express";
import type { DatabaseSync } from "node:sqlite";

export type AuthResult = { ok: true; host: string } | { ok: false; status: number; error: string };

/** Resolves the caller's host identity from a bearer token / API key. */
export function authenticateHost(
  db: DatabaseSync,
  req: Request,
  maxKeyLength: number,
): AuthResult {
  const header = req.get("authorization");
  let token: string | undefined;

  if (header !== undefined && header.startsWith("Bearer ")) {
    token = header.slice("Bearer ".length).trim();
  } else {
    const apiKey = req.get("x-api-key");
    if (typeof apiKey === "string") token = apiKey.trim();
  }

  if (token === undefined || token === "") {
    return { ok: false, status: 401, error: "authentication required" };
  }
  if (token.length > maxKeyLength) {
    return { ok: false, status: 401, error: "invalid api key" };
  }

  const row = db.prepare("SELECT name FROM hosts WHERE api_key = ?").get(token) as
    | { name: string }
    | undefined;
  if (!row) {
    return { ok: false, status: 401, error: "invalid api key" };
  }

  return { ok: true, host: row.name };
}
