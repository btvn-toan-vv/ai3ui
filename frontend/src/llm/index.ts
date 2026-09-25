/**
 * Barrel for this app's `@bioturing-org/ai2ui` feature(s). `App.tsx` calls
 * `useSingleCell()` once, inside `<AI2UIProvider>`. Deleting this whole
 * `src/llm/` directory must leave the rest of the app compiling (nothing
 * outside it may depend on it before `App.tsx` is wired up) — verified by
 * `mv src/llm /tmp/llm-backup && npx tsc -p tsconfig.app.json --noEmit`.
 */
export { useSingleCell } from "./singlecell";
