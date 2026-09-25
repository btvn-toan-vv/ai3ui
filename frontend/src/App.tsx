import type { ReactNode } from "react";
import { McpAI2UIProvider, MCPInfo } from "@bioturing-org/ai2ui/mcp";
// The package ships one scoped stylesheet. Without this import the chat
// renders unstyled — every rule lives under `.ai2ui-root` and every custom
// property under `--ai2ui-*`, so it cannot collide with the app's own CSS.
// Imported before the app's stylesheets so app rules win any tie.
import "@bioturing-org/ai2ui/styles.css";
import { DatasetProvider } from "./state/useDatasetStore";
import { ViewProvider, useViewStore } from "./state/useViewStore";
import { ScatterView } from "./components/ScatterView";
import { Toolbar } from "./components/Toolbar";
import { DataRail } from "./components/DataRail";
// The chat is replaced by MCPInfo: an external MCP client drives the tools now.
// import { ChatPanel } from "./components/ChatPanel";
// import { AgentActivityBar } from "./components/AgentActivityBar";
import { useSingleCell } from "./llm";
import "./styles/panels.css";
// import "./styles/chat.css";
import "./styles/rail.css";
import "./styles/activity.css";
import "./styles/chart.css";

function ErrorBanner() {
  const { error, setError } = useViewStore();
  if (!error) return null;
  return (
    <div className="app-error-banner" role="alert">
      <span>{error}</span>
      <button
        type="button"
        className="app-error-dismiss"
        onClick={() => setError(null)}
      >
        Dismiss
      </button>
    </div>
  );
}

/**
 * `AI2UIProvider` no longer takes `tools`/`context` props — `useTool` and
 * `useContext` are the only way to register, and both need
 * `useEngineContext()`, which throws outside `AI2UIProvider`. So
 * `useSingleCell()` has to run in a component rendered INSIDE the provider,
 * not in `Ai2uiRoot` itself (which renders the provider).
 *
 * It also has to run inside `DatasetProvider`/`ViewProvider` — the tools and
 * the ground-truth context it registers close over live view/dataset state,
 * and that state only exists as React Context below those two providers.
 */
function SingleCellTools() {
  useSingleCell();
  return null;
}

function Ai2uiRoot({ children }: { children: ReactNode }) {
  return (
    <McpAI2UIProvider
      mcp={{ channel: "", persist: import.meta.env.DEV ? "sessionStorage" : "none" }}
      user={null}
      theme="light"
      app={{ name: "single-cell assistant", map: "One page: a UMAP scatter, a data rail, and a panel showing the MCP connection." }}
    >
      <SingleCellTools />
      {children}
    </McpAI2UIProvider>
  );
}

export default function App() {
  return (
    <DatasetProvider>
      <ViewProvider>
        <Ai2uiRoot>
          <div className="app-shell">
            <header className="app-header">
              <h1>single-cell assistant</h1>
              <Toolbar />
            </header>
            <main className="app-main">
              <div className="app-main-content">
                <ErrorBanner />
                {/* Three columns, all visible at once: plot · data · chat.
                    The data panels were briefly tabbed, which defeated the
                    point of the app — the agent would fill the marker table
                    while that tab was hidden, so its work was invisible.
                    Everything the agent can change is now on screen while it
                    works. Freeing the legend into an overlay paid for the
                    third column. */}
                <div className="app-body">
                  <div className="app-work-area">
                    <div className="app-scatter-area">
                      <ScatterView />
                    </div>
                    {/* Under the plot, not in the chat — it reports on the
                        app, not the conversation. */}
                    {/* <AgentActivityBar /> */}
                  </div>
                  <div className="app-data-rail">
                    <DataRail />
                  </div>
                  {/* MCPInfo floats over the page now (below), so this column is gone. */}
                  {/* <div className="app-chat-rail"> */}
                    {/* <ChatPanel /> */}
                    {/* <MCPInfo showConnect maxCalls={12} /> */}
                  {/* </div> */}
                </div>
              </div>
            </main>
          </div>
          <MCPInfo variant="floating" showConnect maxCalls={12} />
        </Ai2uiRoot>
      </ViewProvider>
    </DatasetProvider>
  );
}
