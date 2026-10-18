import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureTemp, fixtureTrash } from "./helpers/fixture-trash.js";
import { assertKnownCodexDatabases } from "../src/conversations/codex-paths.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => fixtureTrash(home, { force: true }))); });

async function fixture() {
  const home = await fixtureTemp(path.join(tmpdir(), "ai-cleaner-db-inventory-"));
  homes.push(home);
  await fs.mkdir(path.join(home, ".codex", "sqlite"), { recursive: true });
  return home;
}

describe("Codex database format boundary", () => {
  it.each(["new_series_1.sqlite", "sqlite/codex-prod.db", "sqlite/new.db-wal", "sqlite/v2/new.db"])(
    "rejects unrecognised database storage %s before changing any data", async (relative) => {
      const home = await fixture();
      const file = path.join(home, ".codex", relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, "untouched");
      await expect(assertKnownCodexDatabases(home)).rejects.toThrow(/Unsupported Codex conversation databases/);
      expect(await fs.readFile(file, "utf8")).toBe("untouched");
    }
  );

  it("allows known databases, their sidecars, and ordinary configuration files", async () => {
    const home = await fixture();
    for (const file of ["state_5.sqlite", "state_5.sqlite-wal", "config.toml", "sqlite/codex-dev.db", "sqlite/codex-dev.db-shm"]) {
      await fs.writeFile(path.join(home, ".codex", file), "fixture");
    }
    await expect(assertKnownCodexDatabases(home)).resolves.toBeUndefined();
  });

  it("refuses a symlinked app database directory without following it", async () => {
    const home = await fixture();
    const directory = path.join(home, ".codex", "sqlite");
    await fs.rename(directory, path.join(home, "outside"));
    await fs.symlink(path.join(home, "outside"), directory);
      await expect(assertKnownCodexDatabases(home)).rejects.toThrow(/symbolic link/);
  });
});
