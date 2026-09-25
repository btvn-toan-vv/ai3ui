# ai3ui

## Run the UMAP frontend

`frontend/` is a single-cell UMAP app (PBMC 3k) whose tools and context are
exposed over MCP through `mcp-adapter/`. Nothing in the page runs a model: an
external MCP client drives it.

It depends on `@bioturing-org/ai2ui` (the `mcp` entry) as a `file:` link to a
local ai2ui checkout on `feat/khangtng/mcp-harness`, already built (`dist/`).
Adjust the path in `frontend/package.json` if yours lives elsewhere.

1. Start the adapter on :8123:

   ```sh
   cd mcp-adapter && uv sync
   uv run uvicorn --factory mcp_adapter.server:create_app --host 127.0.0.1 --port 8123
   ```

2. In another terminal, start the app:

   ```sh
   cd frontend
   npm install --ignore-scripts   # else npm rebuilds the linked ai2ui package
   npm run prep   # once: downloads pbmc3k.h5ad (~25 MB) and writes data/
   npm run dev
   ```

   `npm run dev` starts Vite on http://localhost:5173 (or the next free
   port) and the data API (`/api/data`, `/api/genes`, `/api/query_genes`,
   `/api/run_deg`) on 127.0.0.1:3903 (`PORT` env or `frontend/.env` changes
   it). Vite proxies `/api` to the data API, and `/sessions` plus
   `/sess_…/mcp` to the adapter.

The page shows the UMAP scatter coloured by cluster, a data rail (genes,
marker genes), and an MCP panel: connection status, session id, exposed
tool and context counts, the endpoint, and incoming tool calls.

To drive it, point an MCP client (Streamable HTTP) at the session's MCP URL,
`http://localhost:8123/sess_…/mcp` (the same path through Vite works too).
With this adapter the session id is the only credential, so the panel shows
it (and the endpoint) cut to 8 characters; **Copy client config** copies the
full URL as a `claude mcp add --transport http ai2ui <url>` line. In dev the
session survives a reload (sessionStorage), so the client config keeps
working.

Docker: `compose.yaml` runs only the adapter (and optional redis). The
frontend service is commented out because the image cannot build without
the private `@bioturing` registry and the local ai2ui checkout.
