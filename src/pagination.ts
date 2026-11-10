import type { Request } from "express";
import type { Validated } from "./validation.js";

export interface Cursor {
  startAt: string;
  id: number;
}

export interface PageRequest {
  limit: number;
  offset: number;
  cursor?: Cursor;
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

/**
 * Parses `limit`/`offset` and an optional keyset `cursor`. A cursor, when
 * present, takes over from offset paging: it points at the last row of the
 * previous page and avoids the deep-offset scan.
 */
export function parsePageRequest(query: Request["query"]): Validated<PageRequest> {
  const rawLimit = Number.parseInt(String(query.limit ?? ""), 10);
  const rawOffset = Number.parseInt(String(query.offset ?? ""), 10);

  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;
  const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;

  const rawCursor = query.cursor;
  if (rawCursor === undefined) {
    return { ok: true, value: { limit, offset } };
  }
  if (typeof rawCursor !== "string" || rawCursor === "") {
    return { ok: false, error: "cursor must be a non-empty string" };
  }

  const cursor = decodeCursor(rawCursor);
  if (cursor === undefined) {
    return { ok: false, error: "invalid cursor" };
  }
  return { ok: true, value: { limit, offset, cursor } };
}

export function encodeCursor(startAt: string, id: number): string {
  return Buffer.from(JSON.stringify({ t: startAt, i: id }), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): Cursor | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      t?: unknown;
      i?: unknown;
    };
    if (typeof parsed.t !== "string" || typeof parsed.i !== "number" || !Number.isInteger(parsed.i)) {
      return undefined;
    }
    return { startAt: parsed.t, id: parsed.i };
  } catch {
    return undefined;
  }
}
