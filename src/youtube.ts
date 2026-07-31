import { google } from "googleapis";
import {
  getSetting,
  setSetting,
  type AppDatabase,
} from "./db.js";
import type { VideoCandidate } from "./filter.js";
import type { SecretBox } from "./security.js";

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;
type Credentials = Parameters<OAuth2Client["setCredentials"]>[0];

export const YOUTUBE_SCOPES = [
  "openid",
  "profile",
  "https://www.googleapis.com/auth/youtube",
];

export interface OAuthSettings {
  clientId: string;
  clientSecret: string;
  publicUrl: string;
  redirectUri: string;
}

export interface YouTubeAccount {
  googleSubject: string;
  youtubeChannelId: string;
  displayName: string;
  thumbnailUrl?: string;
  connectedAt: string;
}

export interface PlaylistCatalogItem {
  id: string;
  title: string;
  privacyStatus: string;
  thumbnailUrl?: string;
}

export interface SubscriptionCatalogItem {
  channelId: string;
  title: string;
  uploadsPlaylistId: string;
  thumbnailUrl?: string;
}

interface StoredAccountRow {
  google_subject: string;
  youtube_channel_id: string;
  display_name: string;
  thumbnail_url: string | null;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expiry: string | null;
  connected_at: string;
}

export function getOAuthSettings(
  database: AppDatabase,
  secretBox: SecretBox,
): OAuthSettings | undefined {
  const clientId = getSetting(database, "google_client_id") ?? "";
  const encryptedSecret =
    getSetting(database, "google_client_secret_encrypted") ?? "";
  const publicUrl = getSetting(database, "public_url") ?? "";
  if (!clientId || !encryptedSecret || !publicUrl) {
    return undefined;
  }
  return {
    clientId,
    clientSecret: secretBox.decrypt(encryptedSecret),
    publicUrl,
    redirectUri: `${publicUrl.replace(/\/$/, "")}/auth/google/callback`,
  };
}

export function createOAuthClient(settings: OAuthSettings): OAuth2Client {
  return new google.auth.OAuth2(
    settings.clientId,
    settings.clientSecret,
    settings.redirectUri,
  );
}

export function getStoredAccount(
  database: AppDatabase,
): YouTubeAccount | undefined {
  const row = database
    .prepare(
      `SELECT google_subject, youtube_channel_id, display_name, thumbnail_url,
              connected_at
       FROM youtube_account WHERE id = 1`,
    )
    .get() as StoredAccountRow | undefined;
  if (!row) {
    return undefined;
  }
  return {
    googleSubject: row.google_subject,
    youtubeChannelId: row.youtube_channel_id,
    displayName: row.display_name,
    thumbnailUrl: row.thumbnail_url ?? undefined,
    connectedAt: row.connected_at,
  };
}

function storeCredentials(
  database: AppDatabase,
  secretBox: SecretBox,
  credentials: Credentials,
): void {
  const updates: string[] = [];
  const values: Array<string | null> = [];
  if (credentials.access_token) {
    updates.push("access_token_encrypted = ?");
    values.push(secretBox.encrypt(credentials.access_token));
  }
  if (credentials.refresh_token) {
    updates.push("refresh_token_encrypted = ?");
    values.push(secretBox.encrypt(credentials.refresh_token));
  }
  if (credentials.expiry_date !== undefined) {
    updates.push("token_expiry = ?");
    values.push(String(credentials.expiry_date));
  }
  if (updates.length === 0) {
    return;
  }
  updates.push("updated_at = ?");
  values.push(new Date().toISOString());
  database
    .prepare(
      `UPDATE youtube_account SET ${updates.join(", ")} WHERE id = 1`,
    )
    .run(...values);
}

export async function connectYouTubeAccount(
  database: AppDatabase,
  secretBox: SecretBox,
  code: string,
): Promise<YouTubeAccount> {
  const settings = getOAuthSettings(database, secretBox);
  if (!settings) {
    throw new Error("Google OAuth credentials are not configured.");
  }
  const client = createOAuthClient(settings);
  const tokenResponse = await client.getToken(code);
  const credentials = tokenResponse.tokens;
  client.setCredentials(credentials);

  const youtube = google.youtube({ version: "v3", auth: client });
  const identity = google.oauth2({ version: "v2", auth: client });
  const [channelsResponse, identityResponse] = await Promise.all([
    youtube.channels.list({ part: ["snippet"], mine: true }),
    identity.userinfo.get(),
  ]);
  const channel = channelsResponse.data.items?.[0];
  const subject = identityResponse.data.id;
  if (!channel?.id || !channel.snippet?.title || !subject) {
    throw new Error(
      "Google authorized the account, but no YouTube channel identity was returned.",
    );
  }

  const previous = database
    .prepare(
      `SELECT google_subject, refresh_token_encrypted
       FROM youtube_account WHERE id = 1`,
    )
    .get() as
    | { google_subject: string; refresh_token_encrypted: string | null }
    | undefined;
  const refreshTokenEncrypted = credentials.refresh_token
    ? secretBox.encrypt(credentials.refresh_token)
    : previous?.google_subject === subject
      ? previous.refresh_token_encrypted
      : undefined;
  if (!refreshTokenEncrypted) {
    throw new Error(
      "Google did not return an offline token. Disconnect the app in your Google account and connect again.",
    );
  }

  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO youtube_account (
         id, google_subject, youtube_channel_id, display_name, thumbnail_url,
         access_token_encrypted, refresh_token_encrypted, token_expiry,
         connected_at, updated_at
       ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         google_subject = excluded.google_subject,
         youtube_channel_id = excluded.youtube_channel_id,
         display_name = excluded.display_name,
         thumbnail_url = excluded.thumbnail_url,
         access_token_encrypted = excluded.access_token_encrypted,
         refresh_token_encrypted = excluded.refresh_token_encrypted,
         token_expiry = excluded.token_expiry,
         connected_at = excluded.connected_at,
         updated_at = excluded.updated_at`,
    )
    .run(
      subject,
      channel.id,
      channel.snippet.title,
      channel.snippet.thumbnails?.default?.url ?? null,
      credentials.access_token
        ? secretBox.encrypt(credentials.access_token)
        : null,
      refreshTokenEncrypted,
      credentials.expiry_date ? String(credentials.expiry_date) : null,
      now,
      now,
    );

  return {
    googleSubject: subject,
    youtubeChannelId: channel.id,
    displayName: channel.snippet.title,
    thumbnailUrl: channel.snippet.thumbnails?.default?.url ?? undefined,
    connectedAt: now,
  };
}

export function createAuthorizedClient(
  database: AppDatabase,
  secretBox: SecretBox,
): OAuth2Client {
  const settings = getOAuthSettings(database, secretBox);
  if (!settings) {
    throw new Error("Google OAuth credentials are not configured.");
  }
  const row = database
    .prepare(
      `SELECT access_token_encrypted, refresh_token_encrypted, token_expiry
       FROM youtube_account WHERE id = 1`,
    )
    .get() as StoredAccountRow | undefined;
  if (!row?.refresh_token_encrypted) {
    throw new Error("No YouTube account is connected.");
  }

  const client = createOAuthClient(settings);
  client.setCredentials({
    access_token: row.access_token_encrypted
      ? secretBox.decrypt(row.access_token_encrypted)
      : undefined,
    refresh_token: secretBox.decrypt(row.refresh_token_encrypted),
    expiry_date: row.token_expiry ? Number.parseInt(row.token_expiry, 10) : undefined,
  });
  client.on("tokens", (tokens) => storeCredentials(database, secretBox, tokens));
  return client;
}

export function saveOAuthSettings(
  database: AppDatabase,
  secretBox: SecretBox,
  input: {
    publicUrl: string;
    clientId: string;
    clientSecret?: string;
  },
): void {
  setSetting(database, "public_url", input.publicUrl.replace(/\/$/, ""));
  setSetting(database, "google_client_id", input.clientId);
  if (input.clientSecret) {
    setSetting(
      database,
      "google_client_secret_encrypted",
      secretBox.encrypt(input.clientSecret),
    );
  }
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

export function saveSubscriptions(
  database: AppDatabase,
  subscriptions: SubscriptionCatalogItem[],
  syncedAt = new Date().toISOString(),
): void {
  const upsert = database.prepare(
    `INSERT INTO subscriptions (
       channel_id, title, uploads_playlist_id, thumbnail_url, enabled, active,
       last_video_published_at, synced_at
     ) VALUES (?, ?, ?, ?, 1, 1, NULL, ?)
     ON CONFLICT(channel_id) DO UPDATE SET
       title = excluded.title,
       uploads_playlist_id = excluded.uploads_playlist_id,
       thumbnail_url = excluded.thumbnail_url,
       active = 1,
       synced_at = excluded.synced_at`,
  );
  database.transaction(() => {
    database.prepare("UPDATE subscriptions SET active = 0").run();
    for (const subscription of subscriptions) {
      upsert.run(
        subscription.channelId,
        subscription.title,
        subscription.uploadsPlaylistId,
        subscription.thumbnailUrl ?? null,
        syncedAt,
      );
    }
  })();
}

export async function syncSubscriptions(
  database: AppDatabase,
  secretBox: SecretBox,
): Promise<{ synced: number; skipped: number }> {
  const client = createAuthorizedClient(database, secretBox);
  const youtube = google.youtube({ version: "v3", auth: client });
  const source = new Map<
    string,
    { title: string; thumbnailUrl?: string }
  >();
  let pageToken: string | undefined;
  do {
    const response = await youtube.subscriptions.list({
      part: ["snippet"],
      mine: true,
      maxResults: 50,
      pageToken,
    });
    for (const item of response.data.items ?? []) {
      const channelId = item.snippet?.resourceId?.channelId;
      const title = item.snippet?.title;
      if (channelId && title) {
        source.set(channelId, {
          title,
          thumbnailUrl:
            item.snippet?.thumbnails?.medium?.url ??
            item.snippet?.thumbnails?.default?.url ??
            undefined,
        });
      }
    }
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  const uploads = new Map<string, string>();
  for (const batch of chunks([...source.keys()], 50)) {
    const response = await youtube.channels.list({
      part: ["contentDetails"],
      id: batch,
      maxResults: 50,
    });
    for (const channel of response.data.items ?? []) {
      const uploadsPlaylistId =
        channel.contentDetails?.relatedPlaylists?.uploads;
      if (channel.id && uploadsPlaylistId) {
        uploads.set(channel.id, uploadsPlaylistId);
      }
    }
  }

  const subscriptions: SubscriptionCatalogItem[] = [];
  for (const [channelId, details] of source) {
    const uploadsPlaylistId = uploads.get(channelId);
    if (uploadsPlaylistId) {
      subscriptions.push({
        channelId,
        title: details.title,
        uploadsPlaylistId,
        thumbnailUrl: details.thumbnailUrl,
      });
    }
  }
  saveSubscriptions(database, subscriptions);
  return { synced: subscriptions.length, skipped: source.size - subscriptions.length };
}

export function readPlaylistCatalog(
  database: AppDatabase,
): PlaylistCatalogItem[] {
  const value = getSetting(database, "playlist_catalog_json") ?? "[]";
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (item): item is PlaylistCatalogItem =>
        Boolean(
          item &&
            typeof item === "object" &&
            typeof (item as PlaylistCatalogItem).id === "string" &&
            typeof (item as PlaylistCatalogItem).title === "string" &&
            typeof (item as PlaylistCatalogItem).privacyStatus === "string",
        ),
    );
  } catch {
    return [];
  }
}

export function savePlaylistCatalog(
  database: AppDatabase,
  playlists: PlaylistCatalogItem[],
): void {
  const validIds = new Set(playlists.map((playlist) => playlist.id));
  let selected: string[] = [];
  try {
    const parsed = JSON.parse(
      getSetting(database, "selected_playlists_json") ?? "[]",
    ) as unknown;
    if (Array.isArray(parsed)) {
      selected = parsed.filter(
        (value): value is string =>
          typeof value === "string" && validIds.has(value),
      );
    }
  } catch {
    selected = [];
  }
  database.transaction(() => {
    setSetting(database, "playlist_catalog_json", JSON.stringify(playlists));
    setSetting(database, "selected_playlists_json", JSON.stringify(selected));
  })();
}

export async function syncPlaylistCatalog(
  database: AppDatabase,
  secretBox: SecretBox,
): Promise<{ synced: number }> {
  const client = createAuthorizedClient(database, secretBox);
  const youtube = google.youtube({ version: "v3", auth: client });
  const playlists: PlaylistCatalogItem[] = [];
  let pageToken: string | undefined;
  do {
    const response = await youtube.playlists.list({
      part: ["snippet", "status"],
      mine: true,
      maxResults: 50,
      pageToken,
    });
    for (const item of response.data.items ?? []) {
      if (item.id && item.snippet?.title) {
        playlists.push({
          id: item.id,
          title: item.snippet.title,
          privacyStatus: item.status?.privacyStatus ?? "unknown",
          thumbnailUrl:
            item.snippet.thumbnails?.medium?.url ??
            item.snippet.thumbnails?.default?.url ??
            undefined,
        });
      }
    }
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);
  playlists.sort((left, right) => left.title.localeCompare(right.title));
  savePlaylistCatalog(database, playlists);
  return { synced: playlists.length };
}

export interface WorkerYouTube {
  syncSubscriptions(): Promise<{ synced: number; skipped: number }>;
  syncPlaylists(): Promise<{ synced: number }>;
  listUploadVideos(input: {
    uploadsPlaylistId: string;
    channelId: string;
    channelTitle: string;
    publishedAfter: string;
  }): Promise<VideoCandidate[]>;
  addVideoToPlaylist(videoId: string, playlistId: string): Promise<void>;
}

interface VideoGateway {
  listUploadVideos(input: {
    uploadsPlaylistId: string;
    channelId: string;
    channelTitle: string;
    publishedAfter: string;
  }): Promise<VideoCandidate[]>;
  addVideoToPlaylist(videoId: string, playlistId: string): Promise<void>;
}

function createVideoGateway(
  database: AppDatabase,
  secretBox: SecretBox,
): VideoGateway {
  const client = createAuthorizedClient(database, secretBox);
  const youtube = google.youtube({ version: "v3", auth: client });
  return {
    async listUploadVideos(input): Promise<VideoCandidate[]> {
      const publishedAfter = Date.parse(input.publishedAfter);
      const videos: VideoCandidate[] = [];
      let pageToken: string | undefined;
      let reachedWatermark = false;
      let pageCount = 0;
      do {
        pageCount += 1;
        const response = await youtube.playlistItems.list({
          part: ["snippet", "contentDetails"],
          playlistId: input.uploadsPlaylistId,
          maxResults: 50,
          pageToken,
        });
        for (const item of response.data.items ?? []) {
          const publishedAt =
            item.contentDetails?.videoPublishedAt ?? item.snippet?.publishedAt;
          const videoId =
            item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
          if (!publishedAt || !videoId || !item.snippet?.title) {
            continue;
          }
          const timestamp = Date.parse(publishedAt);
          if (!Number.isFinite(timestamp)) {
            continue;
          }
          if (timestamp <= publishedAfter) {
            reachedWatermark = true;
            continue;
          }
          videos.push({
            videoId,
            channelId: input.channelId,
            channelTitle: input.channelTitle,
            title: item.snippet.title,
            description: item.snippet.description ?? "",
            publishedAt,
            thumbnailUrl:
              item.snippet.thumbnails?.medium?.url ??
              item.snippet.thumbnails?.default?.url ??
              undefined,
          });
        }
        pageToken = response.data.nextPageToken ?? undefined;
        if (pageCount >= 10 && pageToken && !reachedWatermark) {
          throw new Error(
            `More than 500 unseen uploads were found for ${input.channelTitle}; run scans more often.`,
          );
        }
      } while (pageToken && !reachedWatermark);
      return videos.sort(
        (left, right) =>
          Date.parse(left.publishedAt) - Date.parse(right.publishedAt),
      );
    },

    async addVideoToPlaylist(videoId, playlistId): Promise<void> {
      const existing = await youtube.playlistItems.list({
        part: ["id"],
        playlistId,
        videoId,
        maxResults: 1,
      });
      if ((existing.data.items?.length ?? 0) > 0) {
        return;
      }
      await youtube.playlistItems.insert({
        part: ["snippet"],
        requestBody: {
          snippet: {
            playlistId,
            resourceId: {
              kind: "youtube#video",
              videoId,
            },
          },
        },
      });
    },
  };
}

export function createGoogleWorkerYouTube(
  database: AppDatabase,
  secretBox: SecretBox,
): WorkerYouTube {
  let gateway: VideoGateway | undefined;
  const getGateway = (): VideoGateway => {
    gateway ??= createVideoGateway(database, secretBox);
    return gateway;
  };
  return {
    syncSubscriptions: () => syncSubscriptions(database, secretBox),
    syncPlaylists: () => syncPlaylistCatalog(database, secretBox),
    listUploadVideos: (input) => getGateway().listUploadVideos(input),
    addVideoToPlaylist: (videoId, playlistId) =>
      getGateway().addVideoToPlaylist(videoId, playlistId),
  };
}
