# Architecture

## Runtime

YouTube Curator is one Node.js 24 process:

- Express renders EJS pages and serves form/API routes.
- SQLite in WAL mode stores every durable value.
- One `setTimeout`-based scheduler invokes one serialized `VideoWorker`.
- The official `googleapis` client handles OAuth and YouTube Data API calls.

The Docker container runs as an unprivileged user and writes only to `/data`.
There is no message broker, cache, separate frontend build, external database,
or second worker service.

## Minimum schema

| Table | Key fields and purpose |
| --- | --- |
| `settings` | Key/value application configuration, encrypted client secret, generated session secret, mode, fallback playlist/catalog JSON |
| `youtube_account` | Singleton connected channel identity and encrypted access/refresh tokens |
| `subscriptions` | Channel ID, uploads-playlist ID, enabled/current flags, last published-video watermark |
| `rules` | Ordered action, field, operator, value, per-rule playlist IDs, and enabled state |
| `videos` | Unique YouTube video ID, core display fields, duration, normalized metadata JSON snapshot, filter outcome, final decision, reason, timestamps |
| `playlist_additions` | Unique `(video_id, playlist_id)`, pending/added/failed status and error |
| `job_runs` | Worker start/finish, success/failure, counters, and error summary |

SQLite foreign keys are enabled. `videos.video_id` prevents a discovered video
from being evaluated twice. The unique `(video_id, playlist_id)` constraint
prevents the application from adding the same video to the same playlist twice,
including after crashes or retries.

## Processing flow

1. Refresh subscriptions and the owned-playlist catalog.
2. Read enabled subscription upload playlists.
3. Fetch uploads newer than the saved watermark, with a five-minute overlap.
4. Batch-fetch public/filterable metadata for newly discovered video IDs and
   normalize scalar/list values into one snapshot.
5. Insert each unseen video once.
6. Evaluate enabled rules in priority order; the first match wins and supplies
   that video’s playlist targets.
7. Reject immediately, queue for manual review, or accept automatically.
8. Create one pending addition row for each playlist on the matched rule so a
   later manual review keeps the original routing decision.
9. Check the target playlist for the video, call `playlistItems.insert` only
   when absent, and mark each row added or failed.
10. Retry failed/pending rows on later runs or from the History screen.
11. Save run counters and errors for the dashboard and Settings screen.

The worker keeps scanning other channels after a channel-specific error. A run
with any partial failure is shown as failed with the successful counters
preserved.

## GUI routes

| Screen | Route |
| --- | --- |
| First-run setup | `/setup` |
| Owner sign-in | `/login` |
| Dashboard and run-now status | `/` |
| Google OAuth and connected channel | `/account` |
| Subscription sync and enablement | `/subscriptions` |
| Type-aware, ordered metadata filter rules | `/rules` |
| Playlist targets, Watch Later substitute, and processing mode | `/playlists` |
| Manual review queue | `/review` |
| Searchable processing/addition history | `/history` |
| Worker schedule, password, runs, and errors | `/settings` |

## Security boundary

- One owner password is hashed with scrypt.
- The session is a signed, HTTP-only, same-site cookie.
- State-changing forms require the session CSRF value.
- OAuth state is tied to a short-lived HTTP-only cookie.
- The Google client secret and OAuth tokens use AES-256-GCM.
- A random 256-bit key is generated inside `/data` on first start with mode
  `0600`.
- Basic browser security headers are set on every response.
- Dynamic pages escape user and YouTube-provided text through EJS.

This is suitable for a personal deployment, but the browser-facing service
should still use HTTPS when reachable beyond the local machine.

## Implementation stages

1. App shell, schema, setup, status, Docker and Compose
2. Owner session, CSRF, encrypted Google OAuth
3. Subscription/playlist sync and ordered rule management
4. Polling, filtering, duplicate prevention, review, additions, history
5. Runtime settings, status/error polish, mocked integration tests, and docs
