import { inject, vi } from "vitest";
import { fixtureTemp, fixtureTrash } from "./fixture-trash.js";

process.env.AI_CLEANER_FIXTURE_TRASH = inject("fixtureTrash");

// 只替換暫存副本清理邊界；正式垃圾桶模組仍由原測試直接驗證。
vi.mock("../../src/fs/temporary.js", () => ({
  createTemporaryDirectory: fixtureTemp,
  discardTemporary: async (paths: string[]) => {
    for (const source of paths) await fixtureTrash(source, { force: true, recursive: true });
  }
}));
