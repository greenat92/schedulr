import { resolve } from "node:path";
import { backupDatabase } from "../src/backup.js";

const source = resolve(process.env.DB_PATH ?? "schedulr.db");
const destination = resolve(
  process.argv[2] ?? `${source}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);

backupDatabase(source, destination)
  .then((pages) => {
    console.log(
      JSON.stringify({ msg: "backup complete", source, destination, pages }, null, 2),
    );
  })
  .catch((error) => {
    console.error(`Backup failed: ${(error as Error).message}`);
    process.exitCode = 1;
  });
