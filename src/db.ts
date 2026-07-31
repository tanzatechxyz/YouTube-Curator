import { mkdirSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";

export type AppDatabase = BetterSqlite3.Database;

export function openDatabase(dataDirectory: string): AppDatabase {
  mkdirSync(dataDirectory, { recursive: true });
  const database = new BetterSqlite3(
    path.join(dataDirectory, "youtube-curator.sqlite"),
  );
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  migrate(database);
  installDefaults(database);
  return database;
}

function migrate(database: AppDatabase): void {
  const currentVersion = database.pragma("user_version", {
    simple: true,
  }) as number;
  if (currentVersion > 1) {
    throw new Error(
      `Database schema ${currentVersion} is newer than this application supports.`,
    );
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS youtube_account (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      google_subject TEXT NOT NULL,
      youtube_channel_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      thumbnail_url TEXT,
      access_token_encrypted TEXT,
      refresh_token_encrypted TEXT,
      token_expiry TEXT,
      connected_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      channel_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      uploads_playlist_id TEXT NOT NULL,
      thumbnail_url TEXT,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      last_video_published_at TEXT,
      synced_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      priority INTEGER NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('accept', 'reject')),
      field TEXT NOT NULL CHECK (field IN ('title', 'description', 'channel')),
      operator TEXT NOT NULL CHECK (
        operator IN ('contains', 'not_contains', 'equals', 'regex')
      ),
      value TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS rules_priority_unique ON rules(priority);

    CREATE TABLE IF NOT EXISTS videos (
      video_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      channel_title TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      published_at TEXT NOT NULL,
      thumbnail_url TEXT,
      detected_at TEXT NOT NULL,
      filter_outcome TEXT NOT NULL CHECK (filter_outcome IN ('accept', 'reject')),
      decision TEXT NOT NULL CHECK (decision IN ('pending', 'accepted', 'rejected')),
      decision_reason TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE INDEX IF NOT EXISTS videos_detected_at_idx ON videos(detected_at DESC);
    CREATE INDEX IF NOT EXISTS videos_decision_idx ON videos(decision, detected_at);

    CREATE TABLE IF NOT EXISTS playlist_additions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT NOT NULL REFERENCES videos(video_id) ON DELETE CASCADE,
      playlist_id TEXT NOT NULL,
      playlist_title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'added', 'failed')),
      attempted_at TEXT,
      added_at TEXT,
      error_message TEXT,
      UNIQUE(video_id, playlist_id)
    );
    CREATE INDEX IF NOT EXISTS playlist_additions_status_idx
      ON playlist_additions(status, attempted_at);

    CREATE TABLE IF NOT EXISTS job_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_type TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
      started_at TEXT NOT NULL,
      finished_at TEXT,
      stats_json TEXT NOT NULL DEFAULT '{}',
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS job_runs_started_at_idx ON job_runs(started_at DESC);
  `);
  database.pragma("user_version = 1");
}

function installDefaults(database: AppDatabase): void {
  const defaults: Record<string, string> = {
    processing_mode: "review",
    default_outcome: "reject",
    worker_enabled: "true",
    poll_interval_minutes: "60",
    initial_lookback_hours: "24",
    selected_playlists_json: "[]",
    playlist_catalog_json: "[]",
  };
  const insert = database.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
  );
  const transaction = database.transaction(() => {
    for (const [key, value] of Object.entries(defaults)) {
      insert.run(key, value);
    }
  });
  transaction();
}

export function getSetting(
  database: AppDatabase,
  key: string,
): string | undefined {
  const row = database
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(
  database: AppDatabase,
  key: string,
  value: string,
): void {
  database
    .prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .run(key, value);
}

export function isConfigured(database: AppDatabase): boolean {
  return getSetting(database, "setup_complete") === "true";
}

export interface DashboardCounts {
  subscriptions: number;
  enabledSubscriptions: number;
  pendingReview: number;
  accepted: number;
  rejected: number;
  added: number;
}

export function getDashboardCounts(database: AppDatabase): DashboardCounts {
  const subscriptions = database
    .prepare(
      `SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN enabled = 1 AND active = 1 THEN 1 ELSE 0 END), 0)
          AS enabled
       FROM subscriptions WHERE active = 1`,
    )
    .get() as { total: number; enabled: number };
  const videos = database
    .prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN decision = 'pending' THEN 1 ELSE 0 END), 0)
          AS pending,
        COALESCE(SUM(CASE WHEN decision = 'accepted' THEN 1 ELSE 0 END), 0)
          AS accepted,
        COALESCE(SUM(CASE WHEN decision = 'rejected' THEN 1 ELSE 0 END), 0)
          AS rejected
       FROM videos`,
    )
    .get() as { pending: number; accepted: number; rejected: number };
  const additions = database
    .prepare(
      "SELECT COUNT(*) AS total FROM playlist_additions WHERE status = 'added'",
    )
    .get() as { total: number };
  return {
    subscriptions: subscriptions.total,
    enabledSubscriptions: subscriptions.enabled,
    pendingReview: videos.pending,
    accepted: videos.accepted,
    rejected: videos.rejected,
    added: additions.total,
  };
}
