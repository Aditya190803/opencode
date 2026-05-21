import { Resource } from "sst"

export async function handler() {
  const startedAt = new Date().toISOString()

  console.log("stats sync stub", {
    startedAt,
    stage: Resource.App.stage,
    hasDatabaseUrl: Boolean(Resource.StatsDatabase.url),
    hasHoneycombApiKey: Boolean(Resource.HONEYCOMB_API_KEY.value),
  })

  return {
    ok: true,
    startedAt,
  }
}
