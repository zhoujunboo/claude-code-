import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.{test,spec}.?(c|m)[jt]s?(x)", "tests/**/*_test.ts"],
    testTimeout: 30_000,
  },
});
