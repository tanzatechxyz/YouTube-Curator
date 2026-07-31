import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const KEY_LENGTH = 32;

export class SecretBox {
  public constructor(private readonly key: Buffer) {
    if (key.length !== KEY_LENGTH) {
      throw new Error("The application key is invalid.");
    }
  }

  public encrypt(value: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return ["v1", nonce, tag, ciphertext]
      .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
      .join(".");
  }

  public decrypt(value: string): string {
    const [version, nonceText, tagText, ciphertextText] = value.split(".");
    if (
      version !== "v1" ||
      !nonceText ||
      !tagText ||
      ciphertextText === undefined
    ) {
      throw new Error("The encrypted value is invalid.");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(nonceText, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}

export function loadOrCreateMasterKey(
  dataDirectory: string,
  allowCreate = true,
): Buffer {
  const keyPath = path.join(dataDirectory, ".master-key");
  try {
    const key = readFileSync(keyPath);
    if (key.length !== KEY_LENGTH) {
      throw new Error("The application key file has the wrong length.");
    }
    return key;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  if (!allowCreate) {
    throw new Error(
      "The application encryption key is missing. Restore .master-key with the database backup.",
    );
  }
  const key = randomBytes(KEY_LENGTH);
  try {
    writeFileSync(keyPath, key, { flag: "wx", mode: 0o600 });
    chmodSync(keyPath, 0o600);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return readFileSync(keyPath);
    }
    throw error;
  }
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const digest = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [algorithm, saltText, digestText] = storedHash.split("$");
  if (algorithm !== "scrypt" || !saltText || !digestText) {
    return false;
  }
  const expected = Buffer.from(digestText, "base64url");
  const actual = scryptSync(password, Buffer.from(saltText, "base64url"), 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
