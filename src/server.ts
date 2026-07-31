import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { isConfigured, openDatabase } from "./db.js";
import { loadOrCreateMasterKey, SecretBox } from "./security.js";
import { VideoWorker, WorkerScheduler } from "./worker.js";
import { createGoogleWorkerYouTube } from "./youtube.js";

const config = loadConfig();
const database = openDatabase(config.dataDirectory);
const secretBox = new SecretBox(
  loadOrCreateMasterKey(config.dataDirectory, !isConfigured(database)),
);
const worker = new VideoWorker(database, () =>
  createGoogleWorkerYouTube(database, secretBox),
);
const scheduler = new WorkerScheduler(database, worker);
const app = createApp({ config, database, secretBox, worker, scheduler });

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`YouTube Curator is listening on port ${config.port}.`);
  scheduler.start();
});

let stopping = false;

function stop(signal: string): void {
  if (stopping) {
    return;
  }
  stopping = true;
  console.log(`Received ${signal}; shutting down.`);
  scheduler.stop();
  server.close(() => {
    const forcedExit = setTimeout(() => process.exit(0), 9_000);
    void worker.waitForIdle().then(() => {
      clearTimeout(forcedExit);
      database.close();
      process.exit(0);
    });
  });
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
