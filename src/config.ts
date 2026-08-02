import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));

export const APP_VERSION = "1.3.1";

export interface AppConfig {
  dataDirectory: string;
  port: number;
  viewsDirectory: string;
  publicDirectory: string;
  secureCookies: boolean;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const isProductionBuild = sourceDirectory.endsWith(`${path.sep}dist`);
  const assetRoot = isProductionBuild
    ? sourceDirectory
    : path.resolve(sourceDirectory);

  return {
    dataDirectory: process.env.DATA_DIR ?? path.resolve("data"),
    port: Number.parseInt(process.env.PORT ?? "3000", 10),
    viewsDirectory: path.join(assetRoot, "views"),
    publicDirectory: path.join(assetRoot, "public"),
    secureCookies: process.env.COOKIE_SECURE === "true",
    ...overrides,
  };
}
