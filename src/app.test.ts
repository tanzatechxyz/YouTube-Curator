import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { getSetting, openDatabase, type AppDatabase } from "./db.js";
import { loadOrCreateMasterKey, SecretBox } from "./security.js";
import { savePlaylistCatalog } from "./youtube.js";

const cleanups: Array<() => void> = [];

function testApplication(): {
  app: ReturnType<typeof createApp>;
  database: AppDatabase;
} {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), "youtube-curator-"));
  const database = openDatabase(dataDirectory);
  const secretBox = new SecretBox(loadOrCreateMasterKey(dataDirectory));
  cleanups.push(() => {
    database.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  });
  return {
    database,
    app: createApp({
      database,
      secretBox,
      config: loadConfig({
        dataDirectory,
        viewsDirectory: path.resolve("src/views"),
        publicDirectory: path.resolve("src/public"),
      }),
    }),
  };
}

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
});

describe("first-run application", () => {
  it("reports health before setup", async () => {
    const { app } = testApplication();
    const response = await request(app).get("/healthz");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "ok", configured: false });
  });

  it("redirects the dashboard to setup", async () => {
    const { app } = testApplication();
    const response = await request(app).get("/");
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/setup");
  });

  it("stores setup values and encrypts the Google secret", async () => {
    const { app, database } = testApplication();
    const response = await request(app).post("/setup").type("form").send({
      password: "correct horse",
      publicUrl: "http://localhost:3000/",
      googleClientId: "client-id",
      googleClientSecret: "plain-secret",
    });
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/?notice=Setup%20saved");
    expect(getSetting(database, "setup_complete")).toBe("true");
    expect(getSetting(database, "public_url")).toBe("http://localhost:3000");
    expect(getSetting(database, "google_client_secret_encrypted")).not.toContain(
      "plain-secret",
    );
  });

  it("starts an owner session after setup", async () => {
    const { app } = testApplication();
    const agent = request.agent(app);
    await agent.post("/setup").type("form").send({
      password: "correct horse",
      publicUrl: "http://localhost:3000",
      googleClientId: "",
      googleClientSecret: "",
    });
    const dashboard = await agent.get("/");
    expect(dashboard.status).toBe(200);
    expect(dashboard.text).toContain("Dashboard");

    const anonymous = await request(app).get("/");
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.location).toContain("/login");
  });

  it("accepts the owner password and rejects a wrong password", async () => {
    const { app } = testApplication();
    await request(app).post("/setup").type("form").send({
      password: "correct horse",
      publicUrl: "http://localhost:3000",
      googleClientId: "",
      googleClientSecret: "",
    });

    const agent = request.agent(app);
    const rejected = await agent.post("/login").type("form").send({
      password: "wrong password",
      next: "/",
    });
    expect(rejected.status).toBe(401);

    const accepted = await agent.post("/login").type("form").send({
      password: "correct horse",
      next: "/account",
    });
    expect(accepted.status).toBe(302);
    expect(accepted.headers.location).toBe("/account");
    expect((await agent.get("/account")).status).toBe(200);
  });

  it("generates a Google authorization redirect without exposing the secret", async () => {
    const { app } = testApplication();
    const agent = request.agent(app);
    await agent.post("/setup").type("form").send({
      password: "correct horse",
      publicUrl: "http://localhost:3000",
      googleClientId: "test-client.apps.googleusercontent.com",
      googleClientSecret: "super-secret",
    });

    const accountPage = await agent.get("/account");
    expect(accountPage.status).toBe(200);
    expect(accountPage.text).not.toContain("super-secret");
    expect(accountPage.text).toContain(
      "http://localhost:3000/auth/google/callback",
    );

    const authRedirect = await agent.get("/auth/google");
    expect(authRedirect.status).toBe(302);
    expect(authRedirect.headers.location).toContain("accounts.google.com");
    expect(authRedirect.headers.location).toContain("youtube");
  });

  it("requires a CSRF token for protected changes", async () => {
    const { app } = testApplication();
    const agent = request.agent(app);
    await agent.post("/setup").type("form").send({
      password: "correct horse",
      publicUrl: "http://localhost:3000",
      googleClientId: "",
      googleClientSecret: "",
    });
    const response = await agent
      .post("/account/disconnect")
      .type("form")
      .send({});
    expect(response.status).toBe(403);
  });

  it("creates, displays, and validates ordered rules", async () => {
    const { app, database } = testApplication();
    const agent = request.agent(app);
    await agent.post("/setup").type("form").send({
      password: "correct horse",
      publicUrl: "http://localhost:3000",
      googleClientId: "",
      googleClientSecret: "",
    });
    savePlaylistCatalog(database, [
      { id: "PL-highlights", title: "Highlights", privacyStatus: "private" },
    ]);
    const rulesPage = await agent.get("/rules");
    const csrf = rulesPage.text.match(/name="_csrf" value="([^"]+)"/)?.[1];
    expect(csrf).toBeTruthy();

    const invalid = await agent.post("/rules").type("form").send({
      _csrf: csrf,
      name: "Broken regex",
      action: "accept",
      field: "title",
      operator: "regex",
      value: "[",
    });
    expect(invalid.status).toBe(302);
    expect(
      (database.prepare("SELECT COUNT(*) AS count FROM rules").get() as { count: number })
        .count,
    ).toBe(0);

    await agent.post("/rules").type("form").send({
      _csrf: csrf,
      name: "Keep highlights",
      action: "accept",
      field: "title",
      operator: "contains",
      value: "highlights",
      playlistIds: "PL-highlights",
    });
    const updatedPage = await agent.get("/rules");
    expect(updatedPage.text).toContain("Keep highlights");
    expect(updatedPage.text).toContain("highlights");
    expect(updatedPage.text).toContain("Highlights");

    await agent.post("/rules").type("form").send({
      _csrf: csrf,
      name: "Long videos",
      action: "accept",
      field: "duration",
      operator: "at_least",
      value: "20",
      playlistIds: "PL-highlights",
    });
    const durationRule = database
      .prepare(
        `SELECT field, operator, value, playlist_ids_json
         FROM rules WHERE name = 'Long videos'`,
      )
      .get();
    expect(durationRule).toEqual({
      field: "duration",
      operator: "at_least",
      value: "20",
      playlist_ids_json: '["PL-highlights"]',
    });
    const durationEditPage = await agent.get("/rules/2/edit");
    expect(durationEditPage.status).toBe(200);
    expect(durationEditPage.text).toContain('value="duration" selected');
    expect(durationEditPage.text).toContain(
      'value="PL-highlights" checked',
    );
  });

  it("saves only playlist IDs present in the synced catalog", async () => {
    const { app, database } = testApplication();
    const agent = request.agent(app);
    await agent.post("/setup").type("form").send({
      password: "correct horse",
      publicUrl: "http://localhost:3000",
      googleClientId: "",
      googleClientSecret: "",
    });
    savePlaylistCatalog(database, [
      { id: "PL-one", title: "Watch next", privacyStatus: "private" },
      { id: "PL-two", title: "Research", privacyStatus: "unlisted" },
    ]);
    const playlistsPage = await agent.get("/playlists");
    const csrf = playlistsPage.text.match(/name="_csrf" value="([^"]+)"/)?.[1];

    await agent.post("/playlists/settings").type("form").send({
      _csrf: csrf,
      processingMode: "auto",
      playlistIds: ["PL-one", "PL-does-not-exist"],
    });
    expect(getSetting(database, "processing_mode")).toBe("auto");
    expect(JSON.parse(getSetting(database, "selected_playlists_json") ?? "[]")).toEqual([
      "PL-one",
    ]);
  });

  it("renders pending videos in review and processing history", async () => {
    const { app, database } = testApplication();
    const agent = request.agent(app);
    await agent.post("/setup").type("form").send({
      password: "correct horse",
      publicUrl: "http://localhost:3000",
      googleClientId: "",
      googleClientSecret: "",
    });
    database
      .prepare(
        `INSERT INTO videos (
           video_id, channel_id, channel_title, title, description,
           published_at, duration_seconds, detected_at, filter_outcome, decision,
           decision_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accept', 'pending', ?)`,
      )
      .run(
        "review-video",
        "channel-one",
        "Useful Channel",
        "A useful upload",
        "Description",
        "2026-07-31T01:00:00.000Z",
        754,
        "2026-07-31T02:00:00.000Z",
        "Rule “Useful”: title contains “useful”",
      );
    database
      .prepare(
        `INSERT INTO playlist_additions (
           video_id, playlist_id, playlist_title, status
         ) VALUES ('review-video', 'playlist-two', 'Research', 'pending')`,
      )
      .run();

    const reviewPage = await agent.get("/review");
    expect(reviewPage.status).toBe(200);
    expect(reviewPage.text).toContain("A useful upload");
    expect(reviewPage.text).toContain("Why it matched");
    expect(reviewPage.text).toContain("Research");
    expect(reviewPage.text).toContain("12:34");

    const historyPage = await agent.get("/history");
    expect(historyPage.status).toBe(200);
    expect(historyPage.text).toContain("A useful upload");
    expect(historyPage.text).toContain("pending");
  });

  it("updates worker settings and the owner password through the GUI", async () => {
    const { app, database } = testApplication();
    const agent = request.agent(app);
    await agent.post("/setup").type("form").send({
      password: "correct horse",
      publicUrl: "http://localhost:3000",
      googleClientId: "",
      googleClientSecret: "",
    });
    const settingsPage = await agent.get("/settings");
    expect(settingsPage.status).toBe(200);
    const csrf = settingsPage.text.match(/name="_csrf" value="([^"]+)"/)?.[1];

    await agent.post("/settings/worker").type("form").send({
      _csrf: csrf,
      pollIntervalMinutes: "120",
      initialLookbackHours: "48",
    });
    expect(getSetting(database, "worker_enabled")).toBe("false");
    expect(getSetting(database, "poll_interval_minutes")).toBe("120");
    expect(getSetting(database, "initial_lookback_hours")).toBe("48");

    const passwordChange = await agent.post("/settings/password").type("form").send({
      _csrf: csrf,
      currentPassword: "correct horse",
      newPassword: "new correct horse",
      confirmPassword: "new correct horse",
    });
    expect(passwordChange.status).toBe(302);

    const newAgent = request.agent(app);
    expect(
      (
        await newAgent.post("/login").type("form").send({
          password: "correct horse",
          next: "/",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await newAgent.post("/login").type("form").send({
          password: "new correct horse",
          next: "/",
        })
      ).status,
    ).toBe(302);
  });
});
