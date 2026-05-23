import { Athena } from "@opencode-ai/stats-core/athena"
import { runtime } from "@opencode-ai/stats-core/runtime"
import { syncStats } from "@opencode-ai/stats-core/stat-sync"
import { Effect } from "effect"

export function handler() {
  return runtime.runPromise(syncStats().pipe(Effect.provide(Athena.layer)))
}
