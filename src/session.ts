import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Request, Response } from "express";

const SESSION_COOKIE = "ytc_session";
const OAUTH_STATE_COOKIE = "ytc_oauth_state";
const SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 7;

interface SessionPayload {
  issuedAt: number;
  expiresAt: number;
  csrf: string;
}

export interface OwnerSession {
  csrf: string;
  expiresAt: number;
}

interface CookieOptions {
  httpOnly?: boolean;
  maxAgeSeconds?: number;
  sameSite?: "Lax" | "Strict";
  secure?: boolean;
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      result[name] = decodeURIComponent(value);
    } catch {
      result[name] = value;
    }
  }
  return result;
}

function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions,
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `SameSite=${options.sameSite ?? "Lax"}`,
  ];
  if (options.httpOnly !== false) {
    parts.push("HttpOnly");
  }
  if (options.secure) {
    parts.push("Secure");
  }
  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  }
  return parts.join("; ");
}

function sign(value: string, key: Buffer): string {
  return createHmac("sha256", key).update(value).digest("base64url");
}

function safelyEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export class SessionManager {
  public constructor(
    private readonly signingKey: Buffer,
    private readonly secureCookies: () => boolean,
  ) {}

  public read(request: Request): OwnerSession | undefined {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (!token) {
      return undefined;
    }
    const [payloadText, signature] = token.split(".");
    if (!payloadText || !signature) {
      return undefined;
    }
    if (!safelyEqual(sign(payloadText, this.signingKey), signature)) {
      return undefined;
    }
    try {
      const payload = JSON.parse(
        Buffer.from(payloadText, "base64url").toString("utf8"),
      ) as Partial<SessionPayload>;
      if (
        typeof payload.expiresAt !== "number" ||
        typeof payload.csrf !== "string" ||
        payload.expiresAt <= Date.now()
      ) {
        return undefined;
      }
      return { csrf: payload.csrf, expiresAt: payload.expiresAt };
    } catch {
      return undefined;
    }
  }

  public start(response: Response): OwnerSession {
    const now = Date.now();
    const payload: SessionPayload = {
      issuedAt: now,
      expiresAt: now + SESSION_LIFETIME_SECONDS * 1000,
      csrf: randomBytes(24).toString("base64url"),
    };
    const payloadText = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const token = `${payloadText}.${sign(payloadText, this.signingKey)}`;
    response.append(
      "Set-Cookie",
      serializeCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        maxAgeSeconds: SESSION_LIFETIME_SECONDS,
        sameSite: "Lax",
        secure: this.secureCookies(),
      }),
    );
    return { csrf: payload.csrf, expiresAt: payload.expiresAt };
  }

  public end(response: Response): void {
    response.append(
      "Set-Cookie",
      serializeCookie(SESSION_COOKIE, "", {
        httpOnly: true,
        maxAgeSeconds: 0,
        sameSite: "Lax",
        secure: this.secureCookies(),
      }),
    );
  }

  public createOAuthState(response: Response): string {
    const state = randomBytes(32).toString("base64url");
    response.append(
      "Set-Cookie",
      serializeCookie(OAUTH_STATE_COOKIE, state, {
        httpOnly: true,
        maxAgeSeconds: 10 * 60,
        sameSite: "Lax",
        secure: this.secureCookies(),
      }),
    );
    return state;
  }

  public consumeOAuthState(
    request: Request,
    response: Response,
    suppliedState: string,
  ): boolean {
    const expected = parseCookies(request.headers.cookie)[OAUTH_STATE_COOKIE];
    response.append(
      "Set-Cookie",
      serializeCookie(OAUTH_STATE_COOKIE, "", {
        httpOnly: true,
        maxAgeSeconds: 0,
        sameSite: "Lax",
        secure: this.secureCookies(),
      }),
    );
    return Boolean(expected && safelyEqual(expected, suppliedState));
  }
}
