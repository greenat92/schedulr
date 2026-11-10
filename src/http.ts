import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import { logger } from "./logger.js";

const REQUEST_ID_HEADER = "x-request-id";
const MAX_INBOUND_REQUEST_ID = 128;

/** Assigns every request a correlation id and echoes it back to the caller. */
export function requestContext(): RequestHandler {
  return (req, res, next) => {
    const inbound = req.get(REQUEST_ID_HEADER)?.trim();
    const requestId = inbound !== undefined && inbound !== "" && inbound.length <= MAX_INBOUND_REQUEST_ID
      ? inbound
      : randomUUID();

    res.locals.requestId = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);
    next();
  };
}

/** Fails long-running requests with a clean 503 instead of hanging a socket. */
export function requestTimeout(timeoutMs: number): RequestHandler {
  return (req, res, next) => {
    const timer = setTimeout(() => {
      if (res.headersSent) return;
      logger.warn("request timed out", {
        requestId: res.locals.requestId,
        method: req.method,
        route: req.route?.path ?? req.path,
      });
      res.status(503).json({ error: "request timed out" });
    }, timeoutMs);
    timer.unref?.();

    const clear = () => clearTimeout(timer);
    res.on("finish", clear);
    res.on("close", clear);
    next();
  };
}

export function sendError(res: Response, status: number, message: string): Response {
  return res.status(status).json({ error: message });
}

export function notFoundHandler(): RequestHandler {
  return (_req, res) => sendError(res, 404, "not found");
}

/** Terminal error handler: clean JSON, no stack traces, request id on the log. */
export function errorHandler(): ErrorRequestHandler {
  return (error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      return next(error);
    }

    const typed = error as { status?: number; statusCode?: number; type?: string };
    const status = typed.status ?? typed.statusCode;

    if (typed.type === "entity.too.large") {
      return sendError(res, 413, "request body too large");
    }
    if (status === 400 || error instanceof SyntaxError) {
      return sendError(res, 400, "invalid request body");
    }

    logger.error("unhandled request error", {
      requestId: res.locals.requestId,
      method: req.method,
      route: req.route?.path ?? req.path,
      error: error instanceof Error ? error.message : String(error),
    });
    return sendError(res, 500, "internal server error");
  };
}
