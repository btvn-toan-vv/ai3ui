import { defineConfig } from "vite";

// ai3ui is consumed via "file:../ai3ui" (a symlink), and ai3ui's own
// node_modules contains react (devDependency). Without dedupe, imports of
// react from inside the linked package resolve to ITS copy — two Reacts in
// one bundle, and every hook in ai3ui throws "Invalid hook call" at render.
export default defineConfig({
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  server: {
    // Same-origin in dev too: proxy the adapter endpoints so the page never
    // makes a cross-origin call. Mirrors frontend/nginx.conf in prod.
    proxy: {
      "/sessions": "http://localhost:8123",
      "^/sess_[0-9A-Za-z]+/mcp": "http://localhost:8123",
    },
  },
});
