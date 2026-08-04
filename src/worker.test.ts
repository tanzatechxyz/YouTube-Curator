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
    durationSeconds: 12 * 60,
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
    { id: "playlist-two", title: "Channel picks", privacyStatus: "private" },
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
    action: "accept" | "reject" | "review";
    field?: "title" | "description" | "channel" | "duration" | "content_type";
    operator?:
      | "contains"
      | "not_contains"
      | "equals"
      | "regex"
      | "less_than"
      | "at_most"
      | "at_least"
      | "greater_than";
    value: string;
    playlistIds?: string[];
  },
): void {
  database
    .prepare(
      `INSERT INTO rules (
         name, priority, action, field, operator, value, playlist_ids_json,
         enabled, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      input.name,
      input.priority,
      input.action,
      input.field ?? "title",
      input.operator ?? "contains",
      input.value,
      JSON.stringify(
        input.action !== "reject"
          ? (input.playlistIds ?? ["playlist-one"])
          : [],
      ),
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
        playlistIds: [],
      },
      {
        id: 2,
        name: "Keep highlights",
        action: "accept",
        field: "title",
        operator: "contains",
        value: "highlights",
        playlistIds: ["playlist-one"],
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

  it("routes a duration match to the playlists configured on that rule", () => {
    const video = candidate("video-one", "A long upload");
    video.durationSeconds = 25 * 60;
    const result = evaluateRules(
      [
        {
          id: 3,
          name: "Long videos",
          action: "accept",
          field: "duration",
          operator: "at_least",
          value: "20",
          playlistIds: ["playlist-four"],
        },
      ],
      "reject",
      video,
    );
    expect(result).toMatchObject({
      outcome: "accept",
      ruleId: 3,
      playlistIds: ["playlist-four"],
    });
  });

  it("marks a matching review rule for review with its destinations", () => {
    const video = candidate("video-review", "A short upload");
    video.durationSeconds = 2 * 60;
    const result = evaluateRules(
      [
        {
          id: 5,
          name: "Review videos under three minutes",
          action: "review",
          field: "duration",
          operator: "less_than",
          value: "3",
          playlistIds: ["playlist-two"],
        },
      ],
      "reject",
      video,
    );
    expect(result).toMatchObject({
      outcome: "accept",
      requiresReview: true,
      ruleId: 5,
      playlistIds: ["playlist-two"],
    });
  });

  it("differentiates short candidates from standard videos by duration", () => {
    const rule = {
      id: 4,
      name: "Route short candidates",
      action: "accept" as const,
      field: "content_type" as const,
      operator: "equals" as const,
      value: "short_candidate",
      playlistIds: ["playlist-shorts"],
    };
    const threeMinutes = candidate("video-short", "Three-minute upload");
    threeMinutes.durationSeconds = 3 * 60;
    const overThreeMinutes = candidate("video-standard", "Longer upload");
    overThreeMinutes.durationSeconds = 3 * 60 + 1;
    const unknownDuration = candidate("video-unknown", "Unknown duration");
    unknownDuration.durationSeconds = undefined;

    expect(evaluateRules([rule], "reject", threeMinutes)).toMatchObject({
      outcome: "accept",
      playlistIds: ["playlist-shorts"],
    });
    expect(evaluateRules([rule], "reject", overThreeMinutes).outcome).toBe(
      "reject",
    );
    expect(
      evaluateRules(
        [
          {
            ...rule,
            name: "Route standard videos",
            value: "standard_video",
          },
        ],
        "reject",
        overThreeMinutes,
      ).outcome,
    ).toBe("accept");
    expect(
      evaluateRules(
        [
          {
            ...rule,
            name: "Missing duration",
            operator: "is_empty",
            value: "",
          },
        ],
        "reject",
        unknownDuration,
      ).outcome,
    ).toBe("accept");
  });

  it("compares numeric, list, boolean, date, and unavailable metadata", () => {
    const video = candidate("video-metadata", "Metadata-rich upload");
    video.metadata = {
      view_count: 25_000,
      tags: ["Engineering", "Tutorial"],
      captions: true,
      recording_date: "2026-07-30T22:00:00.000Z",
    };
    const base = {
      id: 10,
      name: "Metadata rule",
      action: "accept" as const,
      playlistIds: ["playlist-one"],
    };

    expect(
      evaluateRules(
        [
          {
            ...base,
            field: "view_count",
            operator: "at_least",
            value: "10000",
          },
        ],
        "reject",
        video,
      ).outcome,
    ).toBe("accept");
    expect(
      evaluateRules(
        [
          {
            ...base,
            field: "tags",
            operator: "equals",
            value: "tutorial",
          },
        ],
        "reject",
        video,
      ).outcome,
    ).toBe("accept");
    expect(
      evaluateRules(
        [
          {
            ...base,
            field: "captions",
            operator: "equals",
            value: "true",
          },
        ],
        "reject",
        video,
      ).outcome,
    ).toBe("accept");
    expect(
      evaluateRules(
        [
          {
            ...base,
            field: "recording_date",
            operator: "on_or_before",
            value: "2026-07-30",
          },
        ],
        "reject",
        video,
      ).outcome,
    ).toBe("accept");
    expect(
      evaluateRules(
        [
          {
            ...base,
            field: "paid_product_placement",
            operator: "is_empty",
            value: "",
          },
        ],
        "reject",
        video,
      ).outcome,
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
      playlistIds: ["playlist-two"],
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
    expect(added).toEqual(["video-accepted:playlist-two"]);

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

  it("queues a review rule even when global processing is automatic", async () => {
    const database = testDatabase();
    configureSources(database);
    setSetting(database, "processing_mode", "auto");
    insertRule(database, {
      name: "Review videos under three minutes",
      priority: 10,
      action: "review",
      field: "duration",
      operator: "less_than",
      value: "3",
      playlistIds: ["playlist-two"],
    });
    const shortVideo = candidate("short-review", "A short upload");
    shortVideo.durationSeconds = 2 * 60;
    const added: string[] = [];
    const youtube = fakeYouTube({
      videos: [shortVideo],
      add: async (videoId, playlistId) => {
        added.push(`${videoId}:${playlistId}`);
      },
    });
    const worker = new VideoWorker(
      database,
      () => youtube,
      () => new Date("2026-07-31T03:00:00.000Z"),
    );

    const run = await worker.runOnce();
    expect(run.stats).toMatchObject({ queuedForReview: 1, added: 0 });
    expect(added).toEqual([]);
    expect(
      database
        .prepare("SELECT decision FROM videos WHERE video_id = ?")
        .get("short-review"),
    ).toEqual({ decision: "pending" });

    await worker.approve("short-review");
    expect(added).toEqual(["short-review:playlist-two"]);
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
