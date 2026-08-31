import { createApp, initDb } from "./app.js";

initDb();

const port = parseInt(process.env.PORT ?? "8080", 10);

createApp().listen(port, "127.0.0.1", () => {
  console.log(`schedulr listening on http://127.0.0.1:${port}`);
});
