import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./db.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
});

describe("database migrations", () => {
  it("upgrades version 1 rules without losing their playlist behavior", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "youtube-curator-v1-"));
    const databasePath = path.join(directory, "youtube-curator.sqlite");
    const versionOne = new BetterSqlite3(databasePath);
    versionOne.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO settings (key, value)
      VALUES ('selected_playlists_json', '["playlist-one"]');

      CREATE TABLE rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        priority INTEGER NOT NULL,
        action TEXT NOT NULL,
        field TEXT NOT NULL,
        operator TEXT NOT NULL,
        value TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO rules (
        name, priority, action, field, operator, value, enabled,
        created_at, updated_at
      ) VALUES
        ('Keep highlights', 10, 'accept', 'title', 'contains', 'highlights', 1, 'now', 'now'),
        ('Reject shorts', 20, 'reject', 'title', 'contains', 'short', 1, 'now', 'now');

      CREATE TABLE videos (
        video_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        channel_title TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        published_at TEXT NOT NULL,
        thumbnail_url TEXT,
        detected_at TEXT NOT NULL,
        filter_outcome TEXT NOT NULL,
        decision TEXT NOT NULL,
        decision_reason TEXT NOT NULL,
        decided_at TEXT
      );

      PRAGMA user_version = 1;
    `);
    versionOne.close();

    const migrated = openDatabase(directory);
    cleanups.push(() => {
      migrated.close();
      rmSync(directory, { recursive: true, force: true });
    });

    expect(migrated.pragma("user_version", { simple: true })).toBe(2);
    expect(
      migrated
        .prepare(
          `SELECT name, playlist_ids_json
           FROM rules ORDER BY priority`,
        )
        .all(),
    ).toEqual([
      {
        name: "Keep highlights",
        playlist_ids_json: '["playlist-one"]',
      },
      { name: "Reject shorts", playlist_ids_json: "[]" },
    ]);
    expect(
      (
        migrated
          .prepare(
            `SELECT COUNT(*) AS count
             FROM pragma_table_info('videos')
             WHERE name = 'duration_seconds'`,
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
  });
});
