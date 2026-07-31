# YouTube Curator

A small, single-owner web application that watches your YouTube subscriptions,
filters newly published videos, and adds matches to playlists you select.

The application is intentionally one process, one SQLite database, and one
in-process background worker. After the first container start, all application
configuration is performed in the browser.

## What it includes

- Google OAuth connection for one YouTube account
- Subscription and owned-playlist sync
- Ordered, first-match accept/reject rules
- Automatic or manual-review processing
- Idempotent video processing and playlist additions
- Review queue and searchable processing history
- Run-now control, worker schedule, recent runs, and visible errors
- Single-owner password, CSRF protection, encrypted OAuth secrets, and
  non-root container execution

## Deploy with Docker Compose

Requirements: Docker Engine with the Compose plugin.

```bash
docker compose pull
docker compose up -d
```

Open `http://localhost:3000`. The first-run screen asks for:

1. An owner password.
2. The URL you use to open the application.
3. Optional Google OAuth credentials. You can leave these blank and add them
   later from **YouTube account**.

The named Docker volume `youtube-curator-data` holds the SQLite database,
encrypted tokens, and the generated encryption key. Rebuilding the image does
not remove it.

The production Compose file uses
`ghcr.io/tanzatechxyz/youtube-curator:latest`, which GitHub Actions builds from
the `main` branch. Git tags beginning with `v` also publish a matching image
tag. If the GitHub Container Registry package is private, either sign in with
`docker login ghcr.io` before pulling or change the package visibility to
public in GitHub.

To stop the application:

```bash
docker compose down
```

Do not add `-v` unless you deliberately want to delete all application data.

### Deploy without Compose

```bash
docker build -t youtube-curator .
docker volume create youtube-curator-data
docker run -d \
  --name youtube-curator \
  --restart unless-stopped \
  -p 3000:3000 \
  -v youtube-curator-data:/data \
  youtube-curator
```

No environment file is required.

## Configure Google and YouTube

1. In [Google Cloud Console](https://console.cloud.google.com/), create or
   select a project.
2. Enable **YouTube Data API v3**.
3. Configure the OAuth consent screen. If the app remains in testing, add your
   own Google account as a test user.
4. Create an OAuth client with application type **Web application**.
5. In YouTube Curator, open **YouTube account**. Copy the displayed
   **Authorized redirect URI** into the Google OAuth client's redirect URI
   list. The scheme, host, port, path, and trailing slash must match exactly.
6. Paste the client ID and client secret into the same screen and save.
7. Select **Connect Google account** and approve access.

The app asks for `openid`, basic profile identity, and
`https://www.googleapis.com/auth/youtube`. YouTube's `youtube` scope is required
to insert items into playlists. Offline access is requested so the background
worker can refresh tokens when you are not using the browser.

For anything other than local-only use, put the container behind HTTPS and set
the browser-facing HTTPS URL in the GUI. The secure-cookie setting is inferred
from that URL.

Official references:

- [Google OAuth for web-server applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [YouTube subscriptions.list](https://developers.google.com/youtube/v3/docs/subscriptions/list)
- [YouTube playlistItems.insert](https://developers.google.com/youtube/v3/docs/playlistItems/insert)
- [YouTube API quota costs](https://developers.google.com/youtube/v3/determine_quota_cost)

## First useful configuration

1. Connect YouTube.
2. Open **Subscriptions** and sync. Pause any channels you do not want scanned.
3. Open **Rules**. Rules are evaluated top to bottom; the first match wins.
   The default is reject, so add at least one accept rule.
4. Open **Playlists**, sync, choose destinations, and select automatic or
   manual-review mode.
5. Use **Run scan now** from the dashboard.

The first scan of a channel uses the configurable lookback window (24 hours by
default). Later scans overlap the previous watermark by five minutes. The
unique video ID and `(video, playlist)` database constraints make that overlap
safe.

## Quota notes

The default one-hour interval is deliberately conservative. Each enabled
channel normally costs one `playlistItems.list` request per scan, and each
successful playlist insertion costs substantially more quota than a read.
Accounts with many subscriptions or several destination playlists may need a
longer interval. Current quota usage is visible in Google Cloud Console.

The worker stops paging a single channel after 500 unseen uploads and records a
clear error instead of consuming unbounded quota.

## Local development with Docker

```bash
docker compose -f compose.yaml -f compose.dev.yaml up --build
```

The development container watches TypeScript and template changes and uses a
separate `youtube-curator-dev-data` volume.

Without Docker, Node.js 24 or newer can run the project directly:

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm test
npm run typecheck
npm run build
```

The test suite includes mocked Google OAuth and YouTube API integration; it does
not need real credentials.

## Backup and upgrades

Back up the entire `youtube-curator-data` volume. The database and
`.master-key` must stay together; encrypted OAuth values cannot be recovered
without that key.

For an ordinary upgrade:

```bash
docker compose pull
docker compose up -d
```

## Build and publish automation

The workflow in `.github/workflows/container.yml` runs the tests and type
checks, builds the production Docker target, and publishes the image to GitHub
Container Registry. It runs on pushes to `main`, version tags such as `v1.0.0`,
and manual dispatches. Pull requests perform the same verification and image
build without publishing.

To build the production image locally instead:

```bash
docker build --target production -t youtube-curator .
```

## Deliberate limits

- One owner and one connected YouTube account
- SQLite only
- One in-process scheduler/worker; overlapping scans are refused
- Simple first-match rules rather than nested rule groups
- At most 200 history rows per screen and 100 review items
- Rule changes apply to videos discovered afterward; old videos are not
  reprocessed automatically
- No plugin system, queue service, Redis, external database, or user roles

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the schema and data flow.
