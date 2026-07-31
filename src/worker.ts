import {
  getSetting,
  type AppDatabase,
} from "./db.js";
import { evaluateVideo, type VideoCandidate } from "./filter.js";
import {
  readPlaylistCatalog,
  type PlaylistCatalogItem,
  type WorkerYouTube,
} from "./youtube.js";

export interface WorkerRunStats {
  scannedSubscriptions: number;
  discovered: number;
  duplicates: number;
  accepted: number;
  rejected: number;
  queuedForReview: number;
  added: number;
  addFailed: number;
}

export interface WorkerRunResult {
  status: "succeeded" | "failed" | "busy";
  stats: WorkerRunStats;
  error?: string;
}

interface SubscriptionRow {
  channel_id: string;
  title: string;
  uploads_playlist_id: string;
  last_video_published_at: string | null;
}

interface AdditionAttemptResult {
  added: number;
  failed: number;
  errors: string[];
}

function emptyStats(): WorkerRunStats {
  return {
    scannedSubscriptions: 0,
    discovered: 0,
    duplicates: 0,
    accepted: 0,
    rejected: 0,
    queuedForReview: 0,
    added: 0,
    addFailed: 0,
  };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 800);
}

function selectedPlaylists(database: AppDatabase): PlaylistCatalogItem[] {
  let selectedIds: string[] = [];
  try {
    const parsed = JSON.parse(
      getSetting(database, "selected_playlists_json") ?? "[]",
    ) as unknown;
    if (Array.isArray(parsed)) {
      selectedIds = parsed.filter(
        (value): value is string => typeof value === "string",
      );
    }
  } catch {
    selectedIds = [];
  }
  const selected = new Set(selectedIds);
  return readPlaylistCatalog(database).filter((playlist) =>
    selected.has(playlist.id),
  );
}

export class VideoWorker {
  private running = false;
  private idleWaiters: Array<() => void> = [];
  private additionQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly database: AppDatabase,
    private readonly youtubeFactory: () => WorkerYouTube,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public isRunning(): boolean {
    return this.running;
  }

  public waitForIdle(): Promise<void> {
    if (!this.running) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  public async runOnce(): Promise<WorkerRunResult> {
    if (this.running) {
      return { status: "busy", stats: emptyStats() };
    }
    this.running = true;
    const stats = emptyStats();
    const errors: string[] = [];
    const startedAt = this.now().toISOString();
    const job = this.database
      .prepare(
        `INSERT INTO job_runs (job_type, status, started_at, stats_json)
         VALUES ('video_scan', 'running', ?, '{}')`,
      )
      .run(startedAt);
    const jobId = Number(job.lastInsertRowid);

    try {
      const youtube = this.youtubeFactory();
      try {
        await youtube.syncSubscriptions();
      } catch (error) {
        errors.push(`Subscription sync: ${errorMessage(error)}`);
      }
      try {
        await youtube.syncPlaylists();
      } catch (error) {
        errors.push(`Playlist sync: ${errorMessage(error)}`);
      }

      const subscriptions = this.database
        .prepare(
          `SELECT channel_id, title, uploads_playlist_id,
                  last_video_published_at
           FROM subscriptions
           WHERE active = 1 AND enabled = 1
           ORDER BY title COLLATE NOCASE`,
        )
        .all() as SubscriptionRow[];
      const lookbackHours = Math.min(
        168,
        Math.max(
          1,
          Number.parseInt(
            getSetting(this.database, "initial_lookback_hours") ?? "24",
            10,
          ) || 24,
        ),
      );

      for (const subscription of subscriptions) {
        const referenceTime = subscription.last_video_published_at
          ? Date.parse(subscription.last_video_published_at) - 5 * 60 * 1000
          : this.now().getTime() - lookbackHours * 60 * 60 * 1000;
        try {
          const videos = await youtube.listUploadVideos({
            uploadsPlaylistId: subscription.uploads_playlist_id,
            channelId: subscription.channel_id,
            channelTitle: subscription.title,
            publishedAfter: new Date(referenceTime).toISOString(),
          });
          stats.scannedSubscriptions += 1;
          let newestPublishedAt = subscription.last_video_published_at;
          for (const video of videos) {
            if (
              !newestPublishedAt ||
              Date.parse(video.publishedAt) > Date.parse(newestPublishedAt)
            ) {
              newestPublishedAt = video.publishedAt;
            }
            const result = this.storeCandidate(video);
            if (result === "duplicate") {
              stats.duplicates += 1;
              continue;
            }
            stats.discovered += 1;
            if (result === "accepted") {
              stats.accepted += 1;
            } else if (result === "rejected") {
              stats.rejected += 1;
            } else {
              stats.queuedForReview += 1;
            }
          }
          if (
            newestPublishedAt &&
            newestPublishedAt !== subscription.last_video_published_at
          ) {
            this.database
              .prepare(
                `UPDATE subscriptions SET last_video_published_at = ?
                 WHERE channel_id = ?`,
              )
              .run(newestPublishedAt, subscription.channel_id);
          }
        } catch (error) {
          errors.push(
            `${subscription.title}: ${errorMessage(error)}`,
          );
        }
      }

      const additions = await this.attemptOutstandingAdditions(youtube);
      stats.added += additions.added;
      stats.addFailed += additions.failed;
      errors.push(...additions.errors);

      const status = errors.length ? "failed" : "succeeded";
      const combinedError = errors.length
        ? errors.slice(0, 5).join(" | ")
        : null;
      this.database
        .prepare(
          `UPDATE job_runs SET
             status = ?, finished_at = ?, stats_json = ?, error_message = ?
           WHERE id = ?`,
        )
        .run(
          status,
          this.now().toISOString(),
          JSON.stringify(stats),
          combinedError,
          jobId,
        );
      return {
        status,
        stats,
        error: combinedError ?? undefined,
      };
    } catch (error) {
      const message = errorMessage(error);
      this.database
        .prepare(
          `UPDATE job_runs SET
             status = 'failed', finished_at = ?, stats_json = ?,
             error_message = ?
           WHERE id = ?`,
        )
        .run(
          this.now().toISOString(),
          JSON.stringify(stats),
          message,
          jobId,
        );
      return { status: "failed", stats, error: message };
    } finally {
      this.running = false;
      for (const resolve of this.idleWaiters.splice(0)) {
        resolve();
      }
    }
  }

  private storeCandidate(
    video: VideoCandidate,
  ): "duplicate" | "accepted" | "rejected" | "pending" {
    const filter = evaluateVideo(this.database, video);
    const reviewMode =
      (getSetting(this.database, "processing_mode") ?? "review") === "review";
    const decision =
      filter.outcome === "reject"
        ? "rejected"
        : reviewMode
          ? "pending"
          : "accepted";
    const detectedAt = this.now().toISOString();
    const result = this.database.transaction(() => {
      const insert = this.database
        .prepare(
          `INSERT OR IGNORE INTO videos (
             video_id, channel_id, channel_title, title, description,
             published_at, thumbnail_url, detected_at, filter_outcome,
             decision, decision_reason, decided_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          video.videoId,
          video.channelId,
          video.channelTitle,
          video.title,
          video.description,
          video.publishedAt,
          video.thumbnailUrl ?? null,
          detectedAt,
          filter.outcome,
          decision,
          filter.reason,
          decision === "pending" ? null : detectedAt,
        );
      if (insert.changes === 0) {
        return false;
      }
      if (decision === "accepted") {
        this.ensureAdditionRows(video.videoId);
      }
      return true;
    })();
    return result ? decision : "duplicate";
  }

  private ensureAdditionRows(videoId: string): void {
    const insert = this.database.prepare(
      `INSERT OR IGNORE INTO playlist_additions (
         video_id, playlist_id, playlist_title, status
       ) VALUES (?, ?, ?, 'pending')`,
    );
    for (const playlist of selectedPlaylists(this.database)) {
      insert.run(videoId, playlist.id, playlist.title);
    }
  }

  private async attemptOutstandingAdditions(
    youtube: WorkerYouTube,
    onlyVideoId?: string,
  ): Promise<AdditionAttemptResult> {
    const attempt = this.additionQueue.then(() =>
      this.performOutstandingAdditions(youtube, onlyVideoId),
    );
    this.additionQueue = attempt.then(
      () => undefined,
      () => undefined,
    );
    return attempt;
  }

  private async performOutstandingAdditions(
    youtube: WorkerYouTube,
    onlyVideoId?: string,
  ): Promise<AdditionAttemptResult> {
    const where = onlyVideoId
      ? "AND playlist_additions.video_id = ?"
      : "";
    const rows = this.database
      .prepare(
        `SELECT playlist_additions.id, playlist_additions.video_id,
                playlist_additions.playlist_id, playlist_additions.playlist_title
         FROM playlist_additions
         JOIN videos ON videos.video_id = playlist_additions.video_id
         WHERE playlist_additions.status IN ('pending', 'failed')
           AND videos.decision = 'accepted'
           ${where}
         ORDER BY playlist_additions.id
         LIMIT 100`,
      )
      .all(...(onlyVideoId ? [onlyVideoId] : [])) as Array<{
      id: number;
      video_id: string;
      playlist_id: string;
      playlist_title: string;
    }>;
    const result: AdditionAttemptResult = {
      added: 0,
      failed: 0,
      errors: [],
    };
    for (const row of rows) {
      const attemptedAt = this.now().toISOString();
      this.database
        .prepare(
          `UPDATE playlist_additions SET
             status = 'pending', attempted_at = ?, error_message = NULL
           WHERE id = ?`,
        )
        .run(attemptedAt, row.id);
      try {
        await youtube.addVideoToPlaylist(row.video_id, row.playlist_id);
        this.database
          .prepare(
            `UPDATE playlist_additions SET
               status = 'added', added_at = ?, error_message = NULL
             WHERE id = ?`,
          )
          .run(this.now().toISOString(), row.id);
        result.added += 1;
      } catch (error) {
        const message = errorMessage(error);
        this.database
          .prepare(
            `UPDATE playlist_additions SET
               status = 'failed', error_message = ?
             WHERE id = ?`,
          )
          .run(message, row.id);
        result.failed += 1;
        result.errors.push(
          `${row.playlist_title}: ${message}`,
        );
      }
    }
    return result;
  }

  public async approve(videoId: string): Promise<AdditionAttemptResult> {
    const updated = this.database.transaction(() => {
      const result = this.database
        .prepare(
          `UPDATE videos SET
             decision = 'accepted',
             decision_reason = decision_reason || ' · Approved manually',
             decided_at = ?
           WHERE video_id = ? AND decision = 'pending'`,
        )
        .run(this.now().toISOString(), videoId);
      if (result.changes) {
        this.ensureAdditionRows(videoId);
      }
      return result.changes;
    })();
    if (!updated) {
      throw new Error("That video is no longer waiting for review.");
    }
    return this.attemptOutstandingAdditions(this.youtubeFactory(), videoId);
  }

  public reject(videoId: string): void {
    const result = this.database
      .prepare(
        `UPDATE videos SET
           decision = 'rejected',
           decision_reason = decision_reason || ' · Rejected manually',
           decided_at = ?
         WHERE video_id = ? AND decision = 'pending'`,
      )
      .run(this.now().toISOString(), videoId);
    if (!result.changes) {
      throw new Error("That video is no longer waiting for review.");
    }
  }

  public async retry(videoId: string): Promise<AdditionAttemptResult> {
    const video = this.database
      .prepare("SELECT decision FROM videos WHERE video_id = ?")
      .get(videoId) as { decision: string } | undefined;
    if (!video || video.decision !== "accepted") {
      throw new Error("Only accepted videos can be added to playlists.");
    }
    this.ensureAdditionRows(videoId);
    return this.attemptOutstandingAdditions(this.youtubeFactory(), videoId);
  }
}

export interface SchedulerStatus {
  running: boolean;
  nextRunAt?: string;
}

export class WorkerScheduler {
  private timer: NodeJS.Timeout | undefined;
  private nextRunAt: Date | undefined;

  public constructor(
    private readonly database: AppDatabase,
    private readonly worker: VideoWorker,
  ) {}

  public start(): void {
    this.schedule(15_000);
  }

  public stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.nextRunAt = undefined;
  }

  public refresh(): void {
    this.stop();
    this.schedule(1_000);
  }

  public status(): SchedulerStatus {
    return {
      running: this.worker.isRunning(),
      nextRunAt: this.nextRunAt?.toISOString(),
    };
  }

  private schedule(delayMilliseconds: number): void {
    this.nextRunAt = new Date(Date.now() + delayMilliseconds);
    this.timer = setTimeout(() => {
      void this.execute();
    }, delayMilliseconds);
    this.timer.unref();
  }

  private async execute(): Promise<void> {
    this.timer = undefined;
    this.nextRunAt = undefined;
    const enabled = getSetting(this.database, "worker_enabled") === "true";
    const accountConnected = Boolean(
      this.database.prepare("SELECT 1 FROM youtube_account WHERE id = 1").get(),
    );
    if (enabled && accountConnected) {
      const result = await this.worker.runOnce();
      if (result.status === "failed") {
        console.error(`Video scan finished with errors: ${result.error}`);
      }
    }
    const intervalMinutes = Math.min(
      1_440,
      Math.max(
        5,
        Number.parseInt(
          getSetting(this.database, "poll_interval_minutes") ?? "60",
          10,
        ) || 60,
      ),
    );
    this.schedule(intervalMinutes * 60 * 1000);
  }
}
