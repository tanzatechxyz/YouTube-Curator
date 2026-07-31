import { randomBytes } from "node:crypto";
import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type Response,
} from "express";
import { APP_VERSION, type AppConfig } from "./config.js";
import {
  getDashboardCounts,
  getSetting,
  isConfigured,
  setSetting,
  type AppDatabase,
} from "./db.js";
import {
  hashPassword,
  type SecretBox,
  verifyPassword,
} from "./security.js";
import { SessionManager, type OwnerSession } from "./session.js";
import {
  type VideoWorker,
  type WorkerScheduler,
} from "./worker.js";
import {
  connectYouTubeAccount,
  createOAuthClient,
  getOAuthSettings,
  getStoredAccount,
  readPlaylistCatalog,
  saveOAuthSettings,
  syncPlaylistCatalog,
  syncSubscriptions,
  YOUTUBE_SCOPES,
} from "./youtube.js";

export interface AppDependencies {
  config: AppConfig;
  database: AppDatabase;
  secretBox: SecretBox;
  worker?: VideoWorker;
  scheduler?: WorkerScheduler;
}

function cleanPublicUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function rawText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function textArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(text).filter(Boolean);
  }
  const single = text(value);
  return single ? [single] : [];
}

function safeNext(value: unknown): string {
  const candidate = text(value);
  return candidate.startsWith("/") && !candidate.startsWith("//")
    ? candidate
    : "/";
}

function redirectWith(
  response: Response,
  path: string,
  kind: "notice" | "error",
  message: string,
): void {
  response.redirect(`${path}?${kind}=${encodeURIComponent(message)}`);
}

function setupSessionManager(
  database: AppDatabase,
  secretBox: SecretBox,
  config: AppConfig,
): SessionManager {
  let encryptedKey = getSetting(database, "session_signing_key_encrypted");
  if (!encryptedKey) {
    encryptedKey = secretBox.encrypt(randomBytes(32).toString("base64url"));
    setSetting(database, "session_signing_key_encrypted", encryptedKey);
  }
  const key = Buffer.from(secretBox.decrypt(encryptedKey), "base64url");
  return new SessionManager(key, () => {
    const publicUrl = getSetting(database, "public_url") ?? "";
    return config.secureCookies || publicUrl.startsWith("https://");
  });
}

export function createApp(dependencies: AppDependencies): Express {
  const { config, database, secretBox, worker, scheduler } = dependencies;
  const sessions = setupSessionManager(database, secretBox, config);
  const app = express();
  app.disable("x-powered-by");
  app.set("view engine", "ejs");
  app.set("views", config.viewsDirectory);
  app.use(express.urlencoded({ extended: false, limit: "64kb" }));
  app.use(express.json({ limit: "64kb" }));
  app.use((_request, response, next) => {
    response.set({
      "Content-Security-Policy":
        "default-src 'self'; img-src 'self' https: data:; style-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
      "Referrer-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    });
    next();
  });
  app.use("/assets", express.static(config.publicDirectory, { maxAge: "1h" }));

  app.use((request, response, next) => {
    const ownerSession = sessions.read(request);
    response.locals.path = request.path;
    response.locals.configured = isConfigured(database);
    response.locals.authenticated = Boolean(ownerSession);
    response.locals.csrfToken = ownerSession?.csrf ?? "";
    response.locals.notice = text(request.query.notice);
    response.locals.error = text(request.query.error);
    response.set("Cache-Control", "no-store");
    (request as Request & { ownerSession?: OwnerSession }).ownerSession =
      ownerSession;
    next();
  });

  app.get("/healthz", (_request, response) => {
    response.json({
      status: "ok",
      configured: isConfigured(database),
      version: APP_VERSION,
    });
  });

  app.get("/setup", (_request, response) => {
    if (isConfigured(database)) {
      response.redirect("/");
      return;
    }
    response.render("setup", {
      title: "Set up YouTube Curator",
      publicUrl: "http://localhost:3000",
      redirectUri: "http://localhost:3000/auth/google/callback",
    });
  });

  app.post("/setup", (request, response) => {
    if (isConfigured(database)) {
      response.redirect("/");
      return;
    }
    const password = rawText(request.body.password);
    const publicUrl = cleanPublicUrl(text(request.body.publicUrl));
    const googleClientId = text(request.body.googleClientId);
    const googleClientSecret = text(request.body.googleClientSecret);

    const renderError = (message: string): void => {
      const suppliedUrl = text(request.body.publicUrl);
      response.status(400).render("setup", {
        title: "Set up YouTube Curator",
        publicUrl: suppliedUrl,
        redirectUri: suppliedUrl
          ? `${suppliedUrl.replace(/\/$/, "")}/auth/google/callback`
          : "",
        formError: message,
      });
    };
    if (password.length < 8) {
      renderError("Use an owner password with at least 8 characters.");
      return;
    }
    if (!publicUrl) {
      renderError("Enter a valid http or https application URL.");
      return;
    }
    if ((googleClientId && !googleClientSecret) || (!googleClientId && googleClientSecret)) {
      renderError("Enter both Google OAuth values, or leave both blank for now.");
      return;
    }

    database.transaction(() => {
      setSetting(database, "owner_password_hash", hashPassword(password));
      setSetting(database, "public_url", publicUrl);
      setSetting(database, "google_client_id", googleClientId);
      setSetting(
        database,
        "google_client_secret_encrypted",
        googleClientSecret ? secretBox.encrypt(googleClientSecret) : "",
      );
      setSetting(database, "setup_complete", "true");
    })();
    sessions.start(response);
    response.redirect("/?notice=Setup%20saved");
  });

  app.use((request, response, next) => {
    if (!isConfigured(database)) {
      response.redirect("/setup");
      return;
    }
    next();
  });

  app.get("/login", (request, response) => {
    if (sessions.read(request)) {
      response.redirect("/");
      return;
    }
    response.render("login", {
      title: "Owner sign in",
      next: safeNext(request.query.next),
    });
  });

  app.post("/login", (request, response) => {
    const passwordHash = getSetting(database, "owner_password_hash") ?? "";
    const nextPath = safeNext(request.body.next);
    if (!verifyPassword(rawText(request.body.password), passwordHash)) {
      response.status(401).render("login", {
        title: "Owner sign in",
        next: nextPath,
        formError: "That password is not correct.",
      });
      return;
    }
    sessions.start(response);
    response.redirect(nextPath);
  });

  app.use((request, response, next) => {
    const ownerSession = (
      request as Request & { ownerSession?: OwnerSession }
    ).ownerSession;
    if (!ownerSession) {
      response.redirect(`/login?next=${encodeURIComponent(safeNext(request.originalUrl))}`);
      return;
    }
    next();
  });

  app.use((request, response, next) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      next();
      return;
    }
    const ownerSession = (
      request as Request & { ownerSession?: OwnerSession }
    ).ownerSession;
    const supplied = text(request.body?._csrf) || text(request.get("x-csrf-token"));
    if (!ownerSession || !supplied || supplied !== ownerSession.csrf) {
      response.status(403).render("error", {
        title: "Request expired",
        statusCode: 403,
        message: "Refresh the page and try that action again.",
      });
      return;
    }
    next();
  });

  app.post("/logout", (_request, response) => {
    sessions.end(response);
    response.redirect("/login?notice=Signed%20out");
  });

  app.get("/", (_request, response) => {
    const lastRun = database
      .prepare(
        `SELECT status, started_at, finished_at, error_message
         FROM job_runs ORDER BY id DESC LIMIT 1`,
      )
      .get();
    response.render("dashboard", {
      title: "Dashboard",
      counts: getDashboardCounts(database),
      accountConnected: Boolean(getStoredAccount(database)),
      processingMode: getSetting(database, "processing_mode") ?? "review",
      workerEnabled: getSetting(database, "worker_enabled") === "true",
      workerRunning: worker?.isRunning() ?? false,
      nextRunAt: scheduler?.status().nextRunAt,
      lastRun,
    });
  });

  app.get("/api/status", (_request, response) => {
    response.json({
      configured: true,
      accountConnected: Boolean(getStoredAccount(database)),
      workerEnabled: getSetting(database, "worker_enabled") === "true",
      processingMode: getSetting(database, "processing_mode"),
      scheduler: scheduler?.status() ?? { running: false },
      counts: getDashboardCounts(database),
    });
  });

  app.post("/worker/run", async (_request, response) => {
    if (!worker) {
      redirectWith(response, "/", "error", "The background worker is unavailable.");
      return;
    }
    if (!getStoredAccount(database)) {
      redirectWith(response, "/", "error", "Connect a YouTube account first.");
      return;
    }
    const result = await worker.runOnce();
    if (result.status === "busy") {
      redirectWith(response, "/", "notice", "A video scan is already running.");
      return;
    }
    if (result.status === "failed") {
      redirectWith(
        response,
        "/",
        "error",
        result.error ?? "The scan completed with errors.",
      );
      return;
    }
    redirectWith(
      response,
      "/",
      "notice",
      `Scan complete: ${result.stats.discovered} discovered, ${result.stats.added} added`,
    );
  });

  app.get("/account", (_request, response) => {
    const publicUrl = getSetting(database, "public_url") ?? "";
    const clientId = getSetting(database, "google_client_id") ?? "";
    response.render("account", {
      title: "YouTube account",
      account: getStoredAccount(database),
      oauthConfigured: Boolean(getOAuthSettings(database, secretBox)),
      publicUrl,
      clientId,
      secretSaved: Boolean(
        getSetting(database, "google_client_secret_encrypted"),
      ),
      redirectUri: `${publicUrl.replace(/\/$/, "")}/auth/google/callback`,
    });
  });

  app.post("/account/oauth-settings", (request, response) => {
    const publicUrl = cleanPublicUrl(text(request.body.publicUrl));
    const clientId = text(request.body.googleClientId);
    const clientSecret = text(request.body.googleClientSecret);
    const existingSecret = getSetting(
      database,
      "google_client_secret_encrypted",
    );
    if (!publicUrl || !clientId || (!clientSecret && !existingSecret)) {
      redirectWith(
        response,
        "/account",
        "error",
        "Enter a valid URL, client ID, and client secret.",
      );
      return;
    }
    saveOAuthSettings(database, secretBox, {
      publicUrl,
      clientId,
      clientSecret: clientSecret || undefined,
    });
    redirectWith(response, "/account", "notice", "OAuth settings saved");
  });

  app.get("/auth/google", (_request, response) => {
    const settings = getOAuthSettings(database, secretBox);
    if (!settings) {
      redirectWith(
        response,
        "/account",
        "error",
        "Save Google OAuth credentials before connecting.",
      );
      return;
    }
    const client = createOAuthClient(settings);
    const state = sessions.createOAuthState(response);
    response.redirect(
      client.generateAuthUrl({
        access_type: "offline",
        include_granted_scopes: true,
        prompt: "consent",
        scope: YOUTUBE_SCOPES,
        state,
      }),
    );
  });

  app.get("/auth/google/callback", async (request, response, next) => {
    try {
      const state = text(request.query.state);
      if (!state || !sessions.consumeOAuthState(request, response, state)) {
        redirectWith(
          response,
          "/account",
          "error",
          "The Google connection request expired. Try connecting again.",
        );
        return;
      }
      if (request.query.error) {
        redirectWith(
          response,
          "/account",
          "error",
          `Google did not authorize the connection: ${text(request.query.error)}`,
        );
        return;
      }
      const code = text(request.query.code);
      if (!code) {
        redirectWith(
          response,
          "/account",
          "error",
          "Google returned no authorization code.",
        );
        return;
      }
      const account = await connectYouTubeAccount(
        database,
        secretBox,
        code,
      );
      redirectWith(
        response,
        "/account",
        "notice",
        `Connected ${account.displayName}`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown Google OAuth error";
      redirectWith(response, "/account", "error", message);
    }
  });

  app.post("/account/disconnect", (_request, response) => {
    database.prepare("DELETE FROM youtube_account WHERE id = 1").run();
    redirectWith(response, "/account", "notice", "YouTube account disconnected");
  });

  app.get("/subscriptions", (request, response) => {
    const query = text(request.query.q).toLowerCase();
    const rows = database
      .prepare(
        `SELECT channel_id, title, thumbnail_url, enabled, synced_at
         FROM subscriptions WHERE active = 1
         ORDER BY title COLLATE NOCASE`,
      )
      .all() as Array<{
      channel_id: string;
      title: string;
      thumbnail_url: string | null;
      enabled: number;
      synced_at: string;
    }>;
    const subscriptions = query
      ? rows.filter((row) => row.title.toLowerCase().includes(query))
      : rows;
    response.render("subscriptions", {
      title: "Subscriptions",
      subscriptions,
      query: text(request.query.q),
      accountConnected: Boolean(getStoredAccount(database)),
      total: rows.length,
      enabled: rows.filter((row) => row.enabled === 1).length,
    });
  });

  app.post("/subscriptions/sync", async (_request, response) => {
    try {
      const result = await syncSubscriptions(database, secretBox);
      const suffix = result.skipped
        ? `; ${result.skipped} channel${result.skipped === 1 ? "" : "s"} had no uploads feed`
        : "";
      redirectWith(
        response,
        "/subscriptions",
        "notice",
        `Synced ${result.synced} subscription${result.synced === 1 ? "" : "s"}${suffix}`,
      );
    } catch (error) {
      redirectWith(
        response,
        "/subscriptions",
        "error",
        error instanceof Error ? error.message : "Subscription sync failed",
      );
    }
  });

  app.post("/subscriptions/:channelId/toggle", (request, response) => {
    const channelId = text(request.params.channelId);
    database
      .prepare(
        `UPDATE subscriptions
         SET enabled = CASE enabled WHEN 1 THEN 0 ELSE 1 END
         WHERE channel_id = ? AND active = 1`,
      )
      .run(channelId);
    redirectWith(response, "/subscriptions", "notice", "Subscription updated");
  });

  app.get("/rules", (_request, response) => {
    const rules = database
      .prepare(
        `SELECT id, name, priority, action, field, operator, value, enabled
         FROM rules ORDER BY priority, id`,
      )
      .all();
    response.render("rules", {
      title: "Rules",
      rules,
      defaultOutcome: getSetting(database, "default_outcome") ?? "reject",
    });
  });

  const validateRule = (
    body: Record<string, unknown>,
  ):
    | {
        name: string;
        action: "accept" | "reject";
        field: "title" | "description" | "channel";
        operator: "contains" | "not_contains" | "equals" | "regex";
        value: string;
      }
    | string => {
    const name = text(body.name);
    const action = text(body.action);
    const field = text(body.field);
    const operator = text(body.operator);
    const value = text(body.value);
    if (!name || name.length > 80) {
      return "Give the rule a name of 80 characters or fewer.";
    }
    if (!["accept", "reject"].includes(action)) {
      return "Choose a valid rule action.";
    }
    if (!["title", "description", "channel"].includes(field)) {
      return "Choose a valid rule field.";
    }
    if (!["contains", "not_contains", "equals", "regex"].includes(operator)) {
      return "Choose a valid rule operator.";
    }
    if (!value || value.length > 500) {
      return "Enter a comparison value of 500 characters or fewer.";
    }
    if (operator === "regex") {
      try {
        new RegExp(value, "i");
      } catch {
        return "Enter a valid regular expression.";
      }
    }
    return {
      name,
      action: action as "accept" | "reject",
      field: field as "title" | "description" | "channel",
      operator: operator as "contains" | "not_contains" | "equals" | "regex",
      value,
    };
  };

  app.post("/rules", (request, response) => {
    const input = validateRule(request.body as Record<string, unknown>);
    if (typeof input === "string") {
      redirectWith(response, "/rules", "error", input);
      return;
    }
    const row = database
      .prepare("SELECT COALESCE(MAX(priority), 0) AS priority FROM rules")
      .get() as { priority: number };
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO rules (
           name, priority, action, field, operator, value, enabled,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        input.name,
        row.priority + 10,
        input.action,
        input.field,
        input.operator,
        input.value,
        now,
        now,
      );
    redirectWith(response, "/rules", "notice", "Rule created");
  });

  app.get("/rules/:id/edit", (request, response) => {
    const rule = database
      .prepare(
        `SELECT id, name, action, field, operator, value, enabled
         FROM rules WHERE id = ?`,
      )
      .get(Number.parseInt(text(request.params.id), 10));
    if (!rule) {
      response.status(404).render("error", {
        title: "Rule not found",
        statusCode: 404,
        message: "That rule no longer exists.",
      });
      return;
    }
    response.render("rule-edit", { title: "Edit rule", rule });
  });

  app.post("/rules/:id", (request, response) => {
    const id = Number.parseInt(text(request.params.id), 10);
    const input = validateRule(request.body as Record<string, unknown>);
    if (!Number.isInteger(id) || typeof input === "string") {
      redirectWith(
        response,
        "/rules",
        "error",
        typeof input === "string" ? input : "Invalid rule.",
      );
      return;
    }
    database
      .prepare(
        `UPDATE rules SET
           name = ?, action = ?, field = ?, operator = ?, value = ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.name,
        input.action,
        input.field,
        input.operator,
        input.value,
        new Date().toISOString(),
        id,
      );
    redirectWith(response, "/rules", "notice", "Rule saved");
  });

  app.post("/rules/:id/toggle", (request, response) => {
    database
      .prepare(
        `UPDATE rules
         SET enabled = CASE enabled WHEN 1 THEN 0 ELSE 1 END,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        new Date().toISOString(),
        Number.parseInt(text(request.params.id), 10),
      );
    redirectWith(response, "/rules", "notice", "Rule updated");
  });

  app.post("/rules/:id/delete", (request, response) => {
    database
      .prepare("DELETE FROM rules WHERE id = ?")
      .run(Number.parseInt(text(request.params.id), 10));
    redirectWith(response, "/rules", "notice", "Rule deleted");
  });

  app.post("/rules/:id/move", (request, response) => {
    const id = Number.parseInt(text(request.params.id), 10);
    const direction = text(request.body.direction);
    const current = database
      .prepare("SELECT id, priority FROM rules WHERE id = ?")
      .get(id) as { id: number; priority: number } | undefined;
    if (!current || !["up", "down"].includes(direction)) {
      redirectWith(response, "/rules", "error", "Invalid rule order change.");
      return;
    }
    const comparator = direction === "up" ? "<" : ">";
    const order = direction === "up" ? "DESC" : "ASC";
    const neighbour = database
      .prepare(
        `SELECT id, priority FROM rules
         WHERE priority ${comparator} ?
         ORDER BY priority ${order} LIMIT 1`,
      )
      .get(current.priority) as { id: number; priority: number } | undefined;
    if (neighbour) {
      database.transaction(() => {
        const temporaryPriority = -1_000_000_000 - current.id;
        database
          .prepare("UPDATE rules SET priority = ? WHERE id = ?")
          .run(temporaryPriority, current.id);
        database
          .prepare("UPDATE rules SET priority = ? WHERE id = ?")
          .run(current.priority, neighbour.id);
        database
          .prepare("UPDATE rules SET priority = ? WHERE id = ?")
          .run(neighbour.priority, current.id);
      })();
    }
    redirectWith(response, "/rules", "notice", "Rule order updated");
  });

  app.post("/rules/default", (request, response) => {
    const outcome = text(request.body.defaultOutcome);
    if (!["accept", "reject"].includes(outcome)) {
      redirectWith(response, "/rules", "error", "Choose a valid default outcome.");
      return;
    }
    setSetting(database, "default_outcome", outcome);
    redirectWith(response, "/rules", "notice", "Default outcome saved");
  });

  app.get("/playlists", (_request, response) => {
    const catalog = readPlaylistCatalog(database);
    let selectedIds: string[] = [];
    try {
      const parsed = JSON.parse(
        getSetting(database, "selected_playlists_json") ?? "[]",
      ) as unknown;
      selectedIds = Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === "string")
        : [];
    } catch {
      selectedIds = [];
    }
    response.render("playlists", {
      title: "Playlists",
      playlists: catalog,
      selectedIds: new Set(selectedIds),
      processingMode: getSetting(database, "processing_mode") ?? "review",
      accountConnected: Boolean(getStoredAccount(database)),
    });
  });

  app.post("/playlists/sync", async (_request, response) => {
    try {
      const result = await syncPlaylistCatalog(database, secretBox);
      redirectWith(
        response,
        "/playlists",
        "notice",
        `Synced ${result.synced} playlist${result.synced === 1 ? "" : "s"}`,
      );
    } catch (error) {
      redirectWith(
        response,
        "/playlists",
        "error",
        error instanceof Error ? error.message : "Playlist sync failed",
      );
    }
  });

  app.post("/playlists/settings", (request, response) => {
    const processingMode = text(request.body.processingMode);
    if (!["auto", "review"].includes(processingMode)) {
      redirectWith(response, "/playlists", "error", "Choose a valid processing mode.");
      return;
    }
    const validIds = new Set(
      readPlaylistCatalog(database).map((playlist) => playlist.id),
    );
    const selectedIds = textArray(request.body.playlistIds).filter((id) =>
      validIds.has(id),
    );
    database.transaction(() => {
      setSetting(database, "processing_mode", processingMode);
      setSetting(
        database,
        "selected_playlists_json",
        JSON.stringify(selectedIds),
      );
    })();
    redirectWith(response, "/playlists", "notice", "Playlist settings saved");
  });

  app.get("/review", (_request, response) => {
    const videos = database
      .prepare(
        `SELECT video_id, channel_title, title, description, published_at,
                thumbnail_url, detected_at, decision_reason
         FROM videos
         WHERE decision = 'pending'
         ORDER BY published_at DESC, detected_at DESC
         LIMIT 100`,
      )
      .all();
    response.render("review", {
      title: "Review queue",
      videos,
      selectedPlaylists: (() => {
        let selectedIds: string[] = [];
        try {
          const parsed = JSON.parse(
            getSetting(database, "selected_playlists_json") ?? "[]",
          ) as unknown;
          selectedIds = Array.isArray(parsed)
            ? parsed.filter(
                (value): value is string => typeof value === "string",
              )
            : [];
        } catch {
          selectedIds = [];
        }
        const selected = new Set(selectedIds);
        return readPlaylistCatalog(database).filter((playlist) =>
          selected.has(playlist.id),
        );
      })(),
    });
  });

  app.post("/review/:videoId/approve", async (request, response) => {
    if (!worker) {
      redirectWith(response, "/review", "error", "The background worker is unavailable.");
      return;
    }
    try {
      const result = await worker.approve(text(request.params.videoId));
      const message = result.failed
        ? `Approved; ${result.added} playlist additions succeeded and ${result.failed} failed`
        : result.added
          ? `Approved and added to ${result.added} playlist${result.added === 1 ? "" : "s"}`
          : "Approved; no destination playlists were selected";
      redirectWith(
        response,
        "/review",
        result.failed ? "error" : "notice",
        message,
      );
    } catch (error) {
      redirectWith(
        response,
        "/review",
        "error",
        error instanceof Error ? error.message : "Approval failed",
      );
    }
  });

  app.post("/review/:videoId/reject", (request, response) => {
    if (!worker) {
      redirectWith(response, "/review", "error", "The background worker is unavailable.");
      return;
    }
    try {
      worker.reject(text(request.params.videoId));
      redirectWith(response, "/review", "notice", "Video rejected");
    } catch (error) {
      redirectWith(
        response,
        "/review",
        "error",
        error instanceof Error ? error.message : "Rejection failed",
      );
    }
  });

  app.get("/history", (request, response) => {
    const status = [
      "all",
      "pending",
      "accepted",
      "rejected",
      "added",
      "failed",
    ].includes(text(request.query.status))
      ? text(request.query.status)
      : "all";
    const query = text(request.query.q);
    const conditions: string[] = [];
    const parameters: string[] = [];
    if (status === "pending" || status === "accepted" || status === "rejected") {
      conditions.push("videos.decision = ?");
      parameters.push(status);
    } else if (status === "added" || status === "failed") {
      conditions.push(
        `EXISTS (
           SELECT 1 FROM playlist_additions
           WHERE playlist_additions.video_id = videos.video_id
             AND playlist_additions.status = ?
         )`,
      );
      parameters.push(status);
    }
    if (query) {
      const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
      conditions.push(
        `(videos.title LIKE ? ESCAPE '\\'
          OR videos.channel_title LIKE ? ESCAPE '\\')`,
      );
      parameters.push(pattern, pattern);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const videos = database
      .prepare(
        `SELECT video_id, channel_title, title, published_at, thumbnail_url,
                detected_at, filter_outcome, decision, decision_reason
         FROM videos
         ${where}
         ORDER BY detected_at DESC
         LIMIT 200`,
      )
      .all(...parameters) as Array<Record<string, unknown> & { video_id: string }>;
    const additionsQuery = database.prepare(
      `SELECT playlist_title, status, error_message, added_at
       FROM playlist_additions
       WHERE video_id = ? ORDER BY id`,
    );
    response.render("history", {
      title: "History",
      status,
      query,
      videos: videos.map((video) => ({
        ...video,
        additions: additionsQuery.all(video.video_id),
      })),
    });
  });

  app.post("/history/:videoId/retry", async (request, response) => {
    if (!worker) {
      redirectWith(response, "/history", "error", "The background worker is unavailable.");
      return;
    }
    try {
      const result = await worker.retry(text(request.params.videoId));
      const kind = result.failed ? "error" : "notice";
      const message = result.failed
        ? `${result.failed} playlist addition${result.failed === 1 ? "" : "s"} still failed`
        : result.added
          ? `Added to ${result.added} playlist${result.added === 1 ? "" : "s"}`
          : "No new destination playlists needed an addition";
      redirectWith(response, "/history", kind, message);
    } catch (error) {
      redirectWith(
        response,
        "/history",
        "error",
        error instanceof Error ? error.message : "Retry failed",
      );
    }
  });

  app.get("/settings", (_request, response) => {
    const runs = database
      .prepare(
        `SELECT id, status, started_at, finished_at, stats_json, error_message
         FROM job_runs ORDER BY id DESC LIMIT 15`,
      )
      .all() as Array<{
      id: number;
      status: string;
      started_at: string;
      finished_at: string | null;
      stats_json: string;
      error_message: string | null;
    }>;
    response.render("settings", {
      title: "Settings",
      version: APP_VERSION,
      workerEnabled: getSetting(database, "worker_enabled") === "true",
      pollIntervalMinutes:
        getSetting(database, "poll_interval_minutes") ?? "60",
      initialLookbackHours:
        getSetting(database, "initial_lookback_hours") ?? "24",
      schedulerStatus: scheduler?.status() ?? { running: false },
      runs: runs.map((run) => {
        try {
          return { ...run, stats: JSON.parse(run.stats_json) };
        } catch {
          return { ...run, stats: {} };
        }
      }),
    });
  });

  app.post("/settings/worker", (request, response) => {
    const interval = Number.parseInt(text(request.body.pollIntervalMinutes), 10);
    const lookback = Number.parseInt(text(request.body.initialLookbackHours), 10);
    if (!Number.isInteger(interval) || interval < 5 || interval > 1_440) {
      redirectWith(
        response,
        "/settings",
        "error",
        "Polling interval must be between 5 and 1,440 minutes.",
      );
      return;
    }
    if (!Number.isInteger(lookback) || lookback < 1 || lookback > 168) {
      redirectWith(
        response,
        "/settings",
        "error",
        "Initial lookback must be between 1 and 168 hours.",
      );
      return;
    }
    database.transaction(() => {
      setSetting(
        database,
        "worker_enabled",
        text(request.body.workerEnabled) === "true" ? "true" : "false",
      );
      setSetting(database, "poll_interval_minutes", String(interval));
      setSetting(database, "initial_lookback_hours", String(lookback));
    })();
    scheduler?.refresh();
    redirectWith(response, "/settings", "notice", "Worker settings saved");
  });

  app.post("/settings/password", (request, response) => {
    const currentPassword = rawText(request.body.currentPassword);
    const newPassword = rawText(request.body.newPassword);
    const confirmPassword = rawText(request.body.confirmPassword);
    const storedHash = getSetting(database, "owner_password_hash") ?? "";
    if (!verifyPassword(currentPassword, storedHash)) {
      redirectWith(response, "/settings", "error", "Current password is incorrect.");
      return;
    }
    if (newPassword.length < 8) {
      redirectWith(
        response,
        "/settings",
        "error",
        "New password must contain at least 8 characters.",
      );
      return;
    }
    if (newPassword !== confirmPassword) {
      redirectWith(response, "/settings", "error", "New passwords do not match.");
      return;
    }
    setSetting(database, "owner_password_hash", hashPassword(newPassword));
    sessions.start(response);
    redirectWith(response, "/settings", "notice", "Owner password changed");
  });

  app.use((request, response) => {
    response.status(404).render("error", {
      title: "Not found",
      statusCode: 404,
      message: `No page exists at ${request.path}.`,
    });
  });

  const errorHandler: ErrorRequestHandler = (
    error: Error,
    _request: Request,
    response: Response,
    _next,
  ) => {
    console.error(error);
    response.status(500).render("error", {
      title: "Application error",
      statusCode: 500,
      message: "The application hit an unexpected error. Check the container log.",
    });
  };
  app.use(errorHandler);

  return app;
}
