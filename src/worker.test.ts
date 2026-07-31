import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openDatabase,
  setSetting,
  type AppDatabase,
} from "./db.js";
import {
  evaluateRules,
  type FilterRule,
  type VideoCandidate,
} from "./filter.js";
import { VideoWorker } from "./worker.js";
import {
  savePlaylistCatalog,
  saveSubscriptions,
  type WorkerYouTube,
} from "./youtube.js";

const cleanups: Array<() => void> = [];

function testDatabase(): AppDatabase {
  const directory = mkdtempSync(path.join(tmpdir(), "youtube-curator-worker-"));
  const database = openDatabase(directory);
  cleanups.push(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return database;
}

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
});

function candidate(
  videoId: string,
  title: string,
  publishedAt = "2026-07-31T01:00:00.000Z",
): VideoCandidate {
  return {
    videoId,
    channelId: "channel-one",
    channelTitle: "Useful Channel",
    title,
    description: "A useful description",
    publishedAt,
  };
}

function configureSources(database: AppDatabase): void {
  saveSubscriptions(database, [
    {
      channelId: "channel-one",
      title: "Useful Channel",
      uploadsPlaylistId: "uploads-one",
    },
  ]);
  savePlaylistCatalog(database, [
    { id: "playlist-one", title: "Watch later-ish", privacyStatus: "private" },
  ]);
  setSetting(
    database,
    "selected_playlists_json",
    JSON.stringify(["playlist-one"]),
  );
}

function insertRule(
  database: AppDatabase,
  input: {
    name: string;
    priority: number;
    action: "accept" | "reject";
    field?: "title" | "description" | "channel";
    operator?: "contains" | "not_contains" | "equals" | "regex";
    value: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO rules (
         name, priority, action, field, operator, value, enabled,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      input.name,
      input.priority,
      input.action,
      input.field ?? "title",
      input.operator ?? "contains",
      input.value,
      "2026-07-31T00:00:00.000Z",
      "2026-07-31T00:00:00.000Z",
    );
}

function fakeYouTube(input: {
  videos: VideoCandidate[];
  add?: (videoId: string, playlistId: string) => Promise<void>;
}): WorkerYouTube {
  return {
    syncSubscriptions: async () => ({ synced: 1, skipped: 0 }),
    syncPlaylists: async () => ({ synced: 1 }),
    listUploadVideos: async () => input.videos,
    addVideoToPlaylist:
      input.add ??
      (async () => {
        return;
      }),
  };
}

describe("rule evaluation", () => {
  it("uses the first matching rule and compares text without case sensitivity", () => {
    const rules: FilterRule[] = [
      {
        id: 1,
        name: "Reject shorts",
        action: "reject",
        field: "title",
        operator: "contains",
        value: "SHORT",
      },
      {
        id: 2,
        name: "Keep highlights",
        action: "accept",
        field: "title",
        operator: "contains",
        value: "highlights",
      },
    ];
    const result = evaluateRules(
      rules,
      "reject",
      candidate("video-one", "Short highlights"),
    );
    expect(result.outcome).toBe("reject");
    expect(result.ruleId).toBe(1);
  });

  it("uses the configured fallback when no rule matches", () => {
    expect(
      evaluateRules([], "accept", candidate("video-one", "Anything")).outcome,
    ).toBe("accept");
  });
});

describe("video worker", () => {
  it("processes automatic matches once and adds accepted videos idempotently", async () => {
    const database = testDatabase();
    configureSources(database);
    setSetting(database, "processing_mode", "auto");
    insertRule(database, {
      name: "Keep highlights",
      priority: 10,
      action: "accept",
      value: "highlights",
    });
    const added: string[] = [];
    const youtube = fakeYouTube({
      videos: [
        candidate("video-accepted", "Weekly highlights"),
        candidate("video-rejected", "Unrelated upload", "2026-07-31T02:00:00.000Z"),
      ],
      add: async (videoId, playlistId) => {
        added.push(`${videoId}:${playlistId}`);
      },
    });
    const worker = new VideoWorker(
      database,
      () => youtube,
      () => new Date("2026-07-31T03:00:00.000Z"),
    );

    const first = await worker.runOnce();
    expect(first.status).toBe("succeeded");
    expect(first.stats).toMatchObject({
      discovered: 2,
      accepted: 1,
      rejected: 1,
      added: 1,
    });
    expect(added).toEqual(["video-accepted:playlist-one"]);

    const second = await worker.runOnce();
    expect(second.stats.discovered).toBe(0);
    expect(second.stats.duplicates).toBe(2);
    expect(added).toHaveLength(1);
    const rows = database
      .prepare("SELECT video_id, decision FROM videos ORDER BY video_id")
      .all();
    expect(rows).toEqual([
      { video_id: "video-accepted", decision: "accepted" },
      { video_id: "video-rejected", decision: "rejected" },
    ]);
  });

  it("queues matches for review and adds only after approval", async () => {
    const database = testDatabase();
    configureSources(database);
    setSetting(database, "processing_mode", "review");
    insertRule(database, {
      name: "Keep all useful videos",
      priority: 10,
      action: "accept",
      field: "channel",
      operator: "equals",
      value: "useful channel",
    });
    const added: string[] = [];
    const youtube = fakeYouTube({
      videos: [candidate("review-me", "A new upload")],
      add: async (videoId) => {
        added.push(videoId);
      },
    });
    const worker = new VideoWorker(
      database,
      () => youtube,
      () => new Date("2026-07-31T03:00:00.000Z"),
    );
    const run = await worker.runOnce();
    expect(run.stats.queuedForReview).toBe(1);
    expect(added).toEqual([]);

    const approval = await worker.approve("review-me");
    expect(approval).toMatchObject({ added: 1, failed: 0 });
    expect(added).toEqual(["review-me"]);
    expect(
      (
        database
          .prepare("SELECT decision FROM videos WHERE video_id = ?")
          .get("review-me") as { decision: string }
      ).decision,
    ).toBe("accepted");
  });

  it("records failed additions and retries them safely", async () => {
    const database = testDatabase();
    configureSources(database);
    setSetting(database, "processing_mode", "auto");
    setSetting(database, "default_outcome", "accept");
    let attempts = 0;
    const youtube = fakeYouTube({
      videos: [candidate("retry-me", "Retry this")],
      add: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("temporary YouTube error");
        }
      },
    });
    const worker = new VideoWorker(
      database,
      () => youtube,
      () => new Date("2026-07-31T03:00:00.000Z"),
    );
    const run = await worker.runOnce();
    expect(run.status).toBe("failed");
    expect(run.stats.addFailed).toBe(1);
    expect(
      (
        database
          .prepare("SELECT status FROM playlist_additions")
          .get() as { status: string }
      ).status,
    ).toBe("failed");

    const retry = await worker.retry("retry-me");
    expect(retry).toMatchObject({ added: 1, failed: 0 });
    expect(attempts).toBe(2);
  });
});
