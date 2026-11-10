import { gzipSync } from "node:zlib";
import type { RequestHandler } from "express";

/**
 * Minimal gzip compression for textual responses. Only engages when the client
 * advertises gzip, the body clears the threshold, and it isn't already encoded.
 * Kept dependency-free by wrapping `res.send`.
 */
export function gzipResponses(thresholdBytes: number): RequestHandler {
  return (req, res, next) => {
    const accept = req.headers["accept-encoding"];
    if (typeof accept !== "string" || !/\bgzip\b/i.test(accept)) {
      return next();
    }
    if (res.getHeader("content-encoding") !== undefined) {
      return next();
    }

    const originalSend = res.send.bind(res);
    res.send = ((body?: unknown) => {
      if (body === undefined) return originalSend(body);

      const buffer = Buffer.isBuffer(body)
        ? body
        : typeof body === "string"
          ? Buffer.from(body)
          : undefined;

      if (buffer === undefined || buffer.length < thresholdBytes) {
        return originalSend(body);
      }

      res.setHeader("Content-Encoding", "gzip");
      res.setHeader("Vary", "Accept-Encoding");
      return originalSend(gzipSync(buffer));
    }) as typeof res.send;

    return next();
  };
}
