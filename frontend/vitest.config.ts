import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

const resolvePath = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Same fix as vite.config.ts, needed here for the same reason: @bioturing-org/ai2ui
    // is a `file:` dependency, so its own "react"/"react-dom" imports resolve
    // from ITS real path (its own pnpm-managed copy), not this app's
    // node_modules — two React instances, "Invalid hook call" the moment a
    // tree that mixes hooks from both actually renders. `vite.config.ts` never
    // needed to matter for tests before `@testing-library/react` started
    // rendering hooks; now it does.
    dedupe: ["react", "react-dom"],
    alias: {
      react: resolvePath("./node_modules/react"),
      "react-dom": resolvePath("./node_modules/react-dom"),
    },
  },
  test: {
    // Correction D3: vitest applies `include` BEFORE a CLI path filter, so
    // `vitest run src/llm/singlecell/index.test.ts` reports "0 tests
    // found" unless src/**/*.test.ts is already in `include`.
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    // The golden test loads the full 2,238,732-nnz matrix and runs a
    // 13,714-gene DEG pass; the default 5s timeout is not enough.
    testTimeout: 120_000,
    server: { deps: { inline: [/@bioturing\/components/, /antd/] } },
  },
});
