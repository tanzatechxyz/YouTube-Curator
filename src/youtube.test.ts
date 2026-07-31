import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getSetting,
  openDatabase,
  setSetting,
  type AppDatabase,
} from "./db.js";
import {
  readPlaylistCatalog,
  savePlaylistCatalog,
  saveSubscriptions,
} from "./youtube.js";

const cleanups: Array<() => void> = [];

function testDatabase(): AppDatabase {
  const directory = mkdtempSync(path.join(tmpdir(), "youtube-curator-data-"));
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

describe("YouTube catalog persistence", () => {
  it("preserves channel enablement and marks missing subscriptions inactive", () => {
    const database = testDatabase();
    saveSubscriptions(database, [
      {
        channelId: "channel-a",
        title: "Channel A",
        uploadsPlaylistId: "uploads-a",
      },
      {
        channelId: "channel-b",
        title: "Channel B",
        uploadsPlaylistId: "uploads-b",
      },
    ]);
    database
      .prepare("UPDATE subscriptions SET enabled = 0 WHERE channel_id = ?")
      .run("channel-a");

    saveSubscriptions(database, [
      {
        channelId: "channel-a",
        title: "Channel A renamed",
        uploadsPlaylistId: "uploads-a",
      },
      {
        channelId: "channel-c",
        title: "Channel C",
        uploadsPlaylistId: "uploads-c",
      },
    ]);

    const rows = database
      .prepare(
        "SELECT channel_id, title, enabled, active FROM subscriptions ORDER BY channel_id",
      )
      .all();
    expect(rows).toEqual([
      {
        channel_id: "channel-a",
        title: "Channel A renamed",
        enabled: 0,
        active: 1,
      },
      { channel_id: "channel-b", title: "Channel B", enabled: 1, active: 0 },
      { channel_id: "channel-c", title: "Channel C", enabled: 1, active: 1 },
    ]);
  });

  it("drops selected playlist IDs that disappear from a later sync", () => {
    const database = testDatabase();
    savePlaylistCatalog(database, [
      { id: "one", title: "One", privacyStatus: "private" },
      { id: "two", title: "Two", privacyStatus: "private" },
    ]);
    setSetting(database, "selected_playlists_json", JSON.stringify(["one", "two"]));
    savePlaylistCatalog(database, [
      { id: "two", title: "Two renamed", privacyStatus: "unlisted" },
      { id: "three", title: "Three", privacyStatus: "public" },
    ]);

    expect(readPlaylistCatalog(database)).toHaveLength(2);
    expect(JSON.parse(getSetting(database, "selected_playlists_json") ?? "[]")).toEqual([
      "two",
    ]);
  });
});
