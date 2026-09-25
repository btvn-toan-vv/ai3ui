/**
 * Loads `/api/data` once on app boot and hands the result to the tree via
 * context. Plain `useState` + context — no state-management library.
 *
 * File is `.ts`, not `.tsx`: the Provider element is built with
 * `createElement` rather than JSX so this stays parseable without the JSX
 * loader.
 */

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { DatasetResponse } from "../lib/types";
import { fetchDataset } from "../lib/api";

export interface DatasetStore {
  data: DatasetResponse | null;
  loading: boolean;
  error: string | null;
}

const initialState: DatasetStore = { data: null, loading: true, error: null };

const DatasetContext = createContext<DatasetStore | null>(null);

export function DatasetProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DatasetStore>(initialState);

  // React 18 StrictMode double-invokes effects in dev, which would
  // otherwise fire this fetch twice.
  //
  // `didFetch` blocks the second invocation from starting a second request.
  // `ignore` is reset at the START of every effect run (including the
  // synthetic StrictMode remount) and only flipped to true by that run's
  // cleanup — so the one request that *did* start still gets to commit its
  // result once the "real" mount settles, and is ignored only on a genuine
  // unmount.
  const didFetch = useRef(false);
  const ignore = useRef(false);

  useEffect(() => {
    ignore.current = false;

    if (!didFetch.current) {
      didFetch.current = true;
      fetchDataset()
        .then((data) => {
          if (!ignore.current) {
            setState((prev) => ({ ...prev, data, loading: false, error: null }));
          }
        })
        .catch((err: unknown) => {
          if (!ignore.current) {
            const message = err instanceof Error ? err.message : String(err);
            setState((prev) => ({ ...prev, data: null, loading: false, error: message }));
          }
        });
    }

    return () => {
      ignore.current = true;
    };
  }, []);

  return createElement(DatasetContext.Provider, { value: state }, children);
}

export function useDatasetStore(): DatasetStore {
  const ctx = useContext(DatasetContext);
  if (!ctx) {
    throw new Error("useDatasetStore must be used within a DatasetProvider");
  }
  return ctx;
}
