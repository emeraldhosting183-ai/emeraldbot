import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      reporter: ["text", "json", "html"],
    },
    include: ["tests/**/*.test.ts"],
    passWithNoTests: false,
  },
});
