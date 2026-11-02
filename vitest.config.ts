import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./tests/helpers/global-setup.ts"],
    setupFiles: ["./tests/helpers/setup.ts"],
    // 合成 SQLite 與檔案系統案例在 Intel Mac 約需 2–4 秒，預設 5 秒在負載下會偶發逾時。
    testTimeout: 15_000,
    teardownTimeout: 65_000,
    maxWorkers: 2
  }
});
