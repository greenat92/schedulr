import { createApp, initDb } from "./app.js";
import { loadConfig } from "./config.js";
import { closeDb } from "./db.js";
import { logger } from "./logger.js";
import { startEventLoopLagMonitor } from "./metrics.js";
import { startEmailWorker } from "./outbox.js";

const config = loadConfig();

initDb();
const stopLagMonitor = startEventLoopLagMonitor();
const stopEmailWorker = startEmailWorker();

const server = createApp(config).listen(config.port, "127.0.0.1", () => {
  logger.info("schedulr listening", { port: config.port });
});

// Keep idempotent connections alive longer than a typical load balancer idle
// timeout, while keeping headersTimeout above keepAliveTimeout (Node requires it).
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutting down", { signal });

  stopEmailWorker();
  stopLagMonitor();
  // Stop accepting new work, let in-flight requests finish, and drop idle
  // keep-alive sockets so we don't wait on them.
  server.close((error) => {
    closeDb();
    if (error) {
      logger.error("server close failed", { error: error.message });
      process.exit(1);
    }
    process.exit(0);
  });
  server.closeIdleConnections?.();

  const force = setTimeout(() => {
    logger.error("forced shutdown after timeout");
    closeDb();
    process.exit(1);
  }, 10_000);
  force.unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("uncaughtException", (error) => {
  logger.error("uncaught exception", { error: error.message, stack: error.stack });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("unhandled rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
  });
  process.exit(1);
});
