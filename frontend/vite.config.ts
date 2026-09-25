import { fileURLToPath, URL } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const resolvePath = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The API server's PORT (shell env, else .env), as src/server/index.ts reads it. The proxy is dev-only.
const apiPort = Number(loadEnv("development", process.cwd(), "").PORT) || 3903;

export default defineConfig({
  plugins: [react()],
  resolve: {
    // @bioturing-org/ai2ui is a `file:` dependency — node_modules/@bioturing-org/ai2ui is a
    // symlink to the package's own source checkout. Node/Vite resolve a
    // symlinked module's OWN "react"/"react-dom" imports from ITS real
    // path, not from this app's node_modules, so without this alias the
    // page ends up with two separate React instances (this app's, and the
    // package's own pnpm-managed copy) — React's hook dispatcher is
    // per-instance, so any component tree that mixes hooks from both
    // throws "Invalid hook call" the moment it renders (confirmed live:
    // AI2UIProvider/MessageView crashed on the first real message, not on
    // the initial empty-state render). Forcing both to resolve to this
    // app's single copy is the standard fix for this class of bug.
    dedupe: ["react", "react-dom"],
    alias: {
      react: resolvePath("./node_modules/react"),
      "react-dom": resolvePath("./node_modules/react-dom"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
      "/sessions": "http://localhost:8123",
      "^/sess_[0-9A-Za-z]+/(mcp|docs|api/tools|favicon\\.svg|mcp/docs|mcp/api/tools|mcp/favicon\\.svg)": "http://localhost:8123",
    },
  },
});
