import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";

/**
 * Online, consistent backup while the service keeps running (SQLite's backup
 * API produces a snapshot). Returns the number of pages copied.
 */
export async function backupDatabase(sourcePath: string, destinationPath: string): Promise<number> {
  const db = new DatabaseSync(sourcePath);
  db.exec("PRAGMA busy_timeout = 5000");
  try {
    return await sqliteBackup(db, destinationPath);
  } finally {
    db.close();
  }
}
