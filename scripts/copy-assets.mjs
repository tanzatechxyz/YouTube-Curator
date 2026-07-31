import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/views/partials", { recursive: true });
await mkdir("dist/public", { recursive: true });
await cp("src/views", "dist/views", { recursive: true, force: true });
await cp("src/public", "dist/public", { recursive: true, force: true });
