import { createRequire } from "node:module";
import https from "node:https";

const packageName = "ai-cli-cleaner";
const distTagsUrl = `https://registry.npmjs.org/-/package/${packageName}/dist-tags`;
const responseLimit = 64 * 1024;
export type UpdateTransport = (url: string) => Promise<Buffer>;
export interface UpdateResult {
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  installCommand: string;
}

const { parseVersion, compareVersions } = createRequire(import.meta.url)("../lib/version.cjs") as {
  parseVersion(value: string): unknown;
  compareVersions(left: string, right: string): number;
};
export { compareVersions };

// 每個版本都以 npm 的 latest 標籤發布，因此只查詢該標籤，安裝交由 npm 處理。
export async function checkForUpdate(currentVersion: string, transport: UpdateTransport = request): Promise<UpdateResult> {
  if (!parseVersion(currentVersion)) throw new Error("Invalid release version.");
  const body = await transport(distTagsUrl);
  if (!Buffer.isBuffer(body) || body.length > responseLimit) throw new Error("npm returned an oversized response.");
  let tags: unknown;
  try { tags = JSON.parse(body.toString("utf8")); } catch { throw new Error("npm returned invalid version metadata."); }
  const latestVersion = tags !== null && typeof tags === "object" && !Array.isArray(tags) ? (tags as Record<string, unknown>).latest : undefined;
  if (typeof latestVersion !== "string" || !parseVersion(latestVersion)) throw new Error("npm returned invalid version metadata.");
  return {
    currentVersion, latestVersion,
    available: compareVersions(latestVersion, currentVersion) > 0,
    installCommand: `npm install --global --engine-strict ${packageName}@latest`
  };
}

function request(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // 只接受 registry 的直接回應；轉址或非 200 狀態一律視為失敗。
    const active = https.get(url, { headers: { Accept: "application/json", "User-Agent": packageName }, timeout: 30_000 }, (response) => {
      if (response.statusCode !== 200) {
        response.destroy();
        reject(new Error(`npm registry request failed (HTTP ${response.statusCode ?? "unknown"}).`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > responseLimit) {
          response.destroy();
          reject(new Error("npm returned an oversized response."));
        } else chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    });
    active.on("timeout", () => active.destroy(new Error("npm registry request timed out.")));
    active.on("error", reject);
  });
}
