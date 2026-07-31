import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import nock from "nock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openDatabase,
  type AppDatabase,
} from "./db.js";
import { loadOrCreateMasterKey, SecretBox } from "./security.js";
import {
  connectYouTubeAccount,
  createCuratorWatchLaterPlaylist,
  createGoogleWorkerYouTube,
  readPlaylistCatalog,
  saveOAuthSettings,
  syncPlaylistCatalog,
  syncSubscriptions,
} from "./youtube.js";

let database: AppDatabase;
let secretBox: SecretBox;
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "youtube-curator-google-"));
  database = openDatabase(directory);
  secretBox = new SecretBox(loadOrCreateMasterKey(directory));
  saveOAuthSettings(database, secretBox, {
    publicUrl: "http://localhost:3000",
    clientId: "client-id.apps.googleusercontent.com",
    clientSecret: "client-secret",
  });
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("mocked Google and YouTube integration", () => {
  it("connects, syncs resources, reads uploads, and inserts a playlist item", async () => {
    nock("https://oauth2.googleapis.com")
      .post("/token")
      .reply(200, {
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
        scope:
          "openid profile https://www.googleapis.com/auth/youtube",
      });
    nock("https://youtube.googleapis.com")
      .get("/youtube/v3/channels")
      .query(true)
      .reply(200, {
        items: [
          {
            id: "owner-channel",
            snippet: {
              title: "Owner Channel",
              thumbnails: {
                default: { url: "https://images.example/owner.jpg" },
              },
            },
          },
        ],
      });
    nock("https://www.googleapis.com")
      .get("/oauth2/v2/userinfo")
      .query(true)
      .reply(200, { id: "google-subject", name: "Owner" });

    const account = await connectYouTubeAccount(
      database,
      secretBox,
      "authorization-code",
    );
    expect(account).toMatchObject({
      googleSubject: "google-subject",
      youtubeChannelId: "owner-channel",
      displayName: "Owner Channel",
    });

    nock("https://youtube.googleapis.com")
      .get("/youtube/v3/subscriptions")
      .query(true)
      .reply(200, {
        items: [
          {
            snippet: {
              title: "Subscribed Channel",
              resourceId: { channelId: "subscribed-channel" },
              thumbnails: {
                default: { url: "https://images.example/subscription.jpg" },
              },
            },
          },
        ],
      });
    nock("https://youtube.googleapis.com")
      .get("/youtube/v3/channels")
      .query(true)
      .reply(200, {
        items: [
          {
            id: "subscribed-channel",
            contentDetails: {
              relatedPlaylists: { uploads: "uploads-playlist" },
            },
          },
        ],
      });
    expect(await syncSubscriptions(database, secretBox)).toEqual({
      synced: 1,
      skipped: 0,
    });

    nock("https://youtube.googleapis.com")
      .get("/youtube/v3/playlists")
      .query(true)
      .reply(200, {
        items: [
          {
            id: "destination-playlist",
            snippet: { title: "Curated", thumbnails: {} },
            status: { privacyStatus: "private" },
          },
        ],
      });
    expect(await syncPlaylistCatalog(database, secretBox)).toEqual({ synced: 1 });
    expect(readPlaylistCatalog(database)[0]).toMatchObject({
      id: "destination-playlist",
      title: "Curated",
    });

    nock("https://youtube.googleapis.com")
      .get("/youtube/v3/playlists")
      .query(true)
      .reply(200, {
        items: [
          {
            id: "destination-playlist",
            snippet: { title: "Curated", thumbnails: {} },
            status: { privacyStatus: "private" },
          },
        ],
      });
    nock("https://youtube.googleapis.com")
      .post(
        "/youtube/v3/playlists",
        (body) =>
          body?.snippet?.title === "Watch Later (Curator)" &&
          body?.status?.privacyStatus === "private",
      )
      .query(true)
      .reply(200, {
        id: "curator-watch-later",
        snippet: { title: "Watch Later (Curator)", thumbnails: {} },
        status: { privacyStatus: "private" },
      });
    expect(
      await createCuratorWatchLaterPlaylist(database, secretBox),
    ).toMatchObject({
      created: true,
      playlist: { id: "curator-watch-later", privacyStatus: "private" },
    });
    expect(readPlaylistCatalog(database).map((playlist) => playlist.id)).toEqual([
      "destination-playlist",
      "curator-watch-later",
    ]);

    nock("https://youtube.googleapis.com")
      .get("/youtube/v3/playlistItems")
      .query(true)
      .reply(200, {
        items: [
          {
            snippet: {
              title: "New upload",
              description: "A description",
              publishedAt: "2026-07-31T02:00:00.000Z",
              thumbnails: {},
            },
            contentDetails: {
              videoId: "new-video",
              videoPublishedAt: "2026-07-31T02:00:00.000Z",
            },
          },
        ],
      });
    nock("https://youtube.googleapis.com")
      .get("/youtube/v3/videos")
      .query(
        (query) => {
          const parts = new Set(String(query.part).split(","));
          return (
            parts.has("snippet") &&
            parts.has("contentDetails") &&
            parts.has("statistics") &&
            parts.has("status") &&
            parts.has("topicDetails") &&
            parts.has("recordingDetails") &&
            parts.has("liveStreamingDetails") &&
            query.id === "new-video"
          );
        },
      )
      .reply(200, {
        items: [
          {
            id: "new-video",
            snippet: {
              channelId: "subscribed-channel",
              channelTitle: "Subscribed Channel",
              title: "New upload (authoritative)",
              description: "A detailed description",
              publishedAt: "2026-07-31T02:00:00.000Z",
              tags: ["engineering", "tutorial"],
              categoryId: "27",
              defaultAudioLanguage: "en-AU",
              liveBroadcastContent: "none",
              thumbnails: {
                high: { url: "https://images.example/video.jpg" },
              },
            },
            contentDetails: {
              duration: "PT12M34S",
              definition: "hd",
              caption: "true",
              licensedContent: true,
              regionRestriction: { blocked: ["US"] },
              contentRating: { acbRating: "acbM" },
            },
            statistics: {
              viewCount: "12345",
              likeCount: "900",
              commentCount: "42",
            },
            status: {
              privacyStatus: "public",
              embeddable: true,
              madeForKids: false,
              containsSyntheticMedia: false,
            },
            topicDetails: {
              topicCategories: ["https://en.wikipedia.org/wiki/Technology"],
            },
            recordingDetails: {
              locationDescription: "Melbourne",
              location: { latitude: -37.8136, longitude: 144.9631 },
            },
          },
        ],
      });
    nock("https://youtube.googleapis.com")
      .get("/youtube/v3/playlistItems")
      .query(
        (query) =>
          query.playlistId === "destination-playlist" &&
          query.videoId === "new-video",
      )
      .reply(200, { items: [] });
    nock("https://youtube.googleapis.com")
      .post(
        "/youtube/v3/playlistItems",
        (body) =>
          body?.snippet?.playlistId === "destination-playlist" &&
          body?.snippet?.resourceId?.videoId === "new-video",
      )
      .query(true)
      .reply(200, { id: "playlist-item" });

    const youtube = createGoogleWorkerYouTube(database, secretBox);
    const videos = await youtube.listUploadVideos({
      uploadsPlaylistId: "uploads-playlist",
      channelId: "subscribed-channel",
      channelTitle: "Subscribed Channel",
      publishedAfter: "2026-07-31T00:00:00.000Z",
    });
    expect(videos).toHaveLength(1);
    expect(videos[0]).toMatchObject({
      videoId: "new-video",
      channelTitle: "Subscribed Channel",
      title: "New upload (authoritative)",
      durationSeconds: 754,
      metadata: {
        tags: ["engineering", "tutorial"],
        category_id: "27",
        default_audio_language: "en-AU",
        definition: "hd",
        captions: true,
        blocked_regions: ["US"],
        content_rating: ["acbRating=acbM"],
        view_count: 12345,
        like_count: 900,
        comment_count: 42,
        privacy_status: "public",
        embeddable: true,
        made_for_kids: false,
        contains_synthetic_media: false,
        topic_categories: ["https://en.wikipedia.org/wiki/Technology"],
        recording_location: "Melbourne",
        location_latitude: -37.8136,
        location_longitude: 144.9631,
      },
    });
    await youtube.addVideoToPlaylist("new-video", "destination-playlist");
    nock("https://youtube.googleapis.com")
      .get("/youtube/v3/playlistItems")
      .query(
        (query) =>
          query.playlistId === "destination-playlist" &&
          query.videoId === "new-video",
      )
      .reply(200, { items: [{ id: "playlist-item" }] });
    await youtube.addVideoToPlaylist("new-video", "destination-playlist");

    expect(nock.isDone()).toBe(true);
    expect(getStoredToken(database)).not.toContain("access-token");
  });
});

function getStoredToken(target: AppDatabase): string {
  const row = target
    .prepare(
      "SELECT access_token_encrypted FROM youtube_account WHERE id = 1",
    )
    .get() as { access_token_encrypted: string };
  return row.access_token_encrypted;
}
