import {
  AthenaClient,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
  type Row,
} from "@aws-sdk/client-athena"
import { Client } from "@planetscale/database"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/planetscale-serverless"
import { DateTime, Effect, Schema } from "effect"
import { Resource } from "sst"
import { stat } from "../database/schema"

const ATHENA_MAX_POLL_ATTEMPTS = 60
const ATHENA_PAGE_SIZE = 1000
const DATALAKE_INGESTION_LAG_MS = 5 * 60_000
const UPSERT_CHUNK_SIZE = 500

type AthenaData = Record<string, string>
type StatRow = typeof stat.$inferInsert
type StatAggregate = {
  grain: "day" | "week"
  period_start: Date
  period_end: Date
  dataset: string
  tier: string
  provider: string
  model: string
  sessions: number
  requests: number
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cache_read_tokens: number
  total_tokens: number
  input_cost_microcents: number
  output_cost_microcents: number
  total_cost_microcents: number
  avg_duration_ms: number | null
  p50_duration_ms: number | null
  p95_duration_ms: number | null
  avg_ttfb_ms: number | null
  p50_ttfb_ms: number | null
  p95_ttfb_ms: number | null
  avg_output_tps: number | null
  success_count: number
  error_count: number
  sample_count: number
}
type SyncResult = { ok: true; rows: number; startedAt: string; periodStart: string; periodEnd: string }
type SyncError = AthenaQueryError | AthenaQueryTimeoutError | StatDatabaseError

class AthenaQueryError extends Schema.TaggedErrorClass<AthenaQueryError>()("AthenaQueryError", {
  message: Schema.String,
  queryExecutionId: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect),
}) {}

class AthenaQueryTimeoutError extends Schema.TaggedErrorClass<AthenaQueryTimeoutError>()("AthenaQueryTimeoutError", {
  message: Schema.String,
  queryExecutionId: Schema.String,
}) {}

class StatDatabaseError extends Schema.TaggedErrorClass<StatDatabaseError>()("StatDatabaseError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export function handler(): Promise<SyncResult> {
  return Effect.runPromise(syncStats())
}

const syncStats: () => Effect.Effect<SyncResult, SyncError, never> = Effect.fn("StatsCron.sync")(function* () {
  const startedAt = yield* DateTime.nowAsDate
  const periodEnd = new Date(Math.floor((startedAt.getTime() - DATALAKE_INGESTION_LAG_MS) / 60_000) * 60_000)
  const periodStart = new Date(
    Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth(), periodEnd.getUTCDate() - 6),
  )

  yield* logAthenaRuntimeCheck()

  const aggregates = (yield* runAthenaQuery(buildStatsQuery(periodStart, periodEnd))).flatMap(toStatAggregate)
  const rows = rankRows([
    ...synthesizeAllTierRows(collapseRows(aggregates.filter((item) => item.grain === "week").map(toStatRow))),
    ...synthesizeAllTierRows(collapseRows(aggregates.filter((item) => item.grain === "day").map(toStatRow))),
  ])

  yield* saveRows(rows)

  yield* Effect.logInfo("stats sync complete").pipe(
    Effect.annotateLogs({
      startedAt: startedAt.toISOString(),
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      rows: rows.length,
      stage: Resource.App.stage,
    }),
  )

  return {
    ok: true,
    rows: rows.length,
    startedAt: startedAt.toISOString(),
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
  }
})

const runAthenaQuery: (
  query: string,
) => Effect.Effect<AthenaData[], AthenaQueryError | AthenaQueryTimeoutError, never> = Effect.fn(
  "StatsCron.runAthenaQuery",
)(function* (query: string) {
  const client = new AthenaClient({ region: Resource.StatsLake.region })
  const started = yield* Effect.tryPromise({
    try: () =>
      client.send(
        new StartQueryExecutionCommand({
          QueryString: query,
          WorkGroup: Resource.StatsLake.workgroup,
          QueryExecutionContext: {
            Catalog: Resource.StatsLake.catalog,
            Database: Resource.StatsLake.database,
          },
        }),
      ),
    catch: (cause) => new AthenaQueryError({ message: "Failed to start Athena stats query", cause }),
  })
  const queryExecutionId = started.QueryExecutionId
  if (!queryExecutionId) return yield* new AthenaQueryError({ message: "Athena did not return a query execution id" })

  yield* pollAthenaQuery(client, queryExecutionId)
  return yield* getAthenaResults(client, queryExecutionId)
})

const pollAthenaQuery: (
  client: AthenaClient,
  queryExecutionId: string,
  attempt?: number,
) => Effect.Effect<void, AthenaQueryError | AthenaQueryTimeoutError, never> = Effect.fn("StatsCron.pollAthenaQuery")(
  function* (client: AthenaClient, queryExecutionId: string, attempt = 0) {
    if (attempt > 0) yield* Effect.sleep("2 seconds")

    const result = yield* Effect.tryPromise({
      try: () => client.send(new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId })),
      catch: (cause) => new AthenaQueryError({ message: "Failed to poll Athena stats query", queryExecutionId, cause }),
    })
    const status = result.QueryExecution?.Status

    if (status?.State === "SUCCEEDED") return
    if (status?.State === "FAILED" || status?.State === "CANCELLED")
      return yield* new AthenaQueryError({
        message: `Athena stats query ${status.State.toLowerCase()}: ${status.StateChangeReason ?? "unknown reason"}`,
        queryExecutionId,
      })

    if (attempt >= ATHENA_MAX_POLL_ATTEMPTS - 1)
      return yield* new AthenaQueryTimeoutError({
        message: `Athena stats query ${queryExecutionId} did not complete`,
        queryExecutionId,
      })

    return yield* pollAthenaQuery(client, queryExecutionId, attempt + 1)
  },
)

const getAthenaResults: (
  client: AthenaClient,
  queryExecutionId: string,
  nextToken?: string,
) => Effect.Effect<AthenaData[], AthenaQueryError, never> = Effect.fn("StatsCron.getAthenaResults")(function* (
  client: AthenaClient,
  queryExecutionId: string,
  nextToken?: string,
) {
  const result = yield* Effect.tryPromise({
    try: () =>
      client.send(
        new GetQueryResultsCommand({
          QueryExecutionId: queryExecutionId,
          NextToken: nextToken,
          MaxResults: ATHENA_PAGE_SIZE,
        }),
      ),
    catch: (cause) => new AthenaQueryError({ message: "Failed to read Athena stats results", queryExecutionId, cause }),
  })
  const columns = result.ResultSet?.ResultSetMetadata?.ColumnInfo?.map((item) => item.Name ?? "") ?? []
  const rows = (result.ResultSet?.Rows ?? []).slice(nextToken ? 0 : 1).map((row) => rowData(columns, row))

  if (!result.NextToken) return rows
  return [...rows, ...(yield* getAthenaResults(client, queryExecutionId, result.NextToken))]
})

const saveRows: (rows: StatRow[]) => Effect.Effect<void, StatDatabaseError, never> = Effect.fn("StatsCron.saveRows")(
  function* (rows: StatRow[]) {
    const db = drizzle({
      client: new Client({
        host: Resource.StatsDatabase.host,
        username: Resource.StatsDatabase.username,
        password: Resource.StatsDatabase.password,
      }),
    })

    yield* Effect.forEach(
      chunks(rows, UPSERT_CHUNK_SIZE),
      (chunk) =>
        Effect.tryPromise({
          try: () =>
            db
              .insert(stat)
              .values(chunk)
              .onDuplicateKeyUpdate({
                set: {
                  period_end: inserted("period_end"),
                  provider_model: inserted("provider_model"),
                  sessions: inserted("sessions"),
                  requests: inserted("requests"),
                  input_tokens: inserted("input_tokens"),
                  output_tokens: inserted("output_tokens"),
                  reasoning_tokens: inserted("reasoning_tokens"),
                  cache_read_tokens: inserted("cache_read_tokens"),
                  total_tokens: inserted("total_tokens"),
                  input_cost_microcents: inserted("input_cost_microcents"),
                  output_cost_microcents: inserted("output_cost_microcents"),
                  total_cost_microcents: inserted("total_cost_microcents"),
                  avg_duration_ms: inserted("avg_duration_ms"),
                  p50_duration_ms: inserted("p50_duration_ms"),
                  p95_duration_ms: inserted("p95_duration_ms"),
                  avg_ttfb_ms: inserted("avg_ttfb_ms"),
                  p50_ttfb_ms: inserted("p50_ttfb_ms"),
                  p95_ttfb_ms: inserted("p95_ttfb_ms"),
                  avg_output_tps: inserted("avg_output_tps"),
                  success_count: inserted("success_count"),
                  error_count: inserted("error_count"),
                  sample_count: inserted("sample_count"),
                  rank_by_tokens: inserted("rank_by_tokens"),
                  rank_by_requests: inserted("rank_by_requests"),
                  rank_by_cost: inserted("rank_by_cost"),
                },
              }),
          catch: (cause) => new StatDatabaseError({ message: "Failed to upsert stats rows", cause }),
        }),
      { discard: true },
    )
  },
)

function buildStatsQuery(periodStart: Date, periodEnd: Date) {
  const periodStartValue = sqlString(periodStart.toISOString())
  const periodEndValue = sqlString(periodEnd.toISOString())
  const sourceTable = [Resource.StatsLake.catalog, Resource.StatsLake.database, Resource.StatsLake.table]
    .map(sqlIdentifier)
    .join(".")
  const aggregateColumns = `
    COUNT(DISTINCT session) AS sessions,
    COUNT(*) AS requests,
    COALESCE(SUM(tokens_input), 0) AS input_tokens,
    COALESCE(SUM(tokens_output), 0) AS output_tokens,
    COALESCE(SUM(tokens_reasoning), 0) AS reasoning_tokens,
    COALESCE(SUM(tokens_cache_read), 0) AS cache_read_tokens,
    COALESCE(SUM(tokens_total), 0) AS total_tokens,
    COALESCE(SUM(cost_input_microcents), 0) AS input_cost_microcents,
    COALESCE(SUM(cost_output_microcents), 0) AS output_cost_microcents,
    COALESCE(SUM(cost_total_microcents), 0) AS total_cost_microcents,
    AVG(duration_ms) AS avg_duration_ms,
    approx_percentile(CAST(duration_ms AS double), 0.5) AS p50_duration_ms,
    approx_percentile(CAST(duration_ms AS double), 0.95) AS p95_duration_ms,
    AVG(ttfb_ms) AS avg_ttfb_ms,
    approx_percentile(CAST(ttfb_ms AS double), 0.5) AS p50_ttfb_ms,
    approx_percentile(CAST(ttfb_ms AS double), 0.95) AS p95_ttfb_ms,
    AVG(output_tps) AS avg_output_tps,
    SUM(CASE WHEN status >= 200 AND status < 400 THEN 1 ELSE 0 END) AS success_count,
    SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS error_count,
    COUNT(*) AS sample_count`

  return `
WITH filtered AS (
  SELECT
    from_iso8601_timestamp(event_timestamp) AS event_time,
    COALESCE(NULLIF(tier, ''), 'unknown') AS tier,
    COALESCE(NULLIF(provider, ''), 'unknown') AS provider,
    COALESCE(NULLIF(model, ''), 'unknown') AS model,
    session,
    status,
    duration_ms,
    ttfb_ms,
    output_tps,
    tokens_input,
    tokens_output,
    tokens_reasoning,
    tokens_cache_read,
    tokens_total,
    cost_input_microcents,
    cost_output_microcents,
    cost_total_microcents
  FROM ${sourceTable}
  WHERE event_type = 'completions'
    AND model IS NOT NULL
    AND model <> ''
    AND user_agent LIKE '%opencode%'
    AND event_timestamp >= ${periodStartValue}
    AND event_timestamp < ${periodEndValue}
), daily AS (
  SELECT date_trunc('day', event_time) AS day, *
  FROM filtered
)
SELECT
  'week' AS grain,
  ${periodStartValue} AS period_start,
  ${periodEndValue} AS period_end,
  ${sqlString(Resource.StatsLake.dataset)} AS dataset,
  tier,
  provider,
  model,
  ${aggregateColumns}
FROM filtered
GROUP BY tier, provider, model
UNION ALL
SELECT
  'day' AS grain,
  to_iso8601(day) AS period_start,
  to_iso8601(least(day + INTERVAL '1' DAY, from_iso8601_timestamp(${periodEndValue}))) AS period_end,
  ${sqlString(Resource.StatsLake.dataset)} AS dataset,
  tier,
  provider,
  model,
  ${aggregateColumns}
FROM daily
GROUP BY day, tier, provider, model
ORDER BY grain, period_start, total_tokens DESC
`
}

function logAthenaRuntimeCheck() {
  return Effect.logInfo("athena stats runtime check").pipe(
    Effect.annotateLogs({
      catalog: Resource.StatsLake.catalog,
      database: Resource.StatsLake.database,
      table: Resource.StatsLake.table,
      workgroup: Resource.StatsLake.workgroup,
      region: Resource.StatsLake.region,
      stage: Resource.App.stage,
    }),
  )
}

function inserted(column: string) {
  return sql.raw(`values(\`${column}\`)`)
}

function toStatAggregate(data: AthenaData): StatAggregate[] {
  const grain = data.grain === "day" || data.grain === "week" ? data.grain : undefined
  const periodStart = new Date(data.period_start ?? "")
  const periodEnd = new Date(data.period_end ?? "")
  if (!grain || Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime())) return []

  return [
    {
      grain,
      period_start: periodStart,
      period_end: periodEnd,
      dataset: data.dataset || Resource.StatsLake.dataset,
      tier: normalizeTier(data.tier || "unknown"),
      provider: data.provider || "unknown",
      model: data.model || "unknown",
      sessions: integer(data, "sessions"),
      requests: integer(data, "requests"),
      input_tokens: integer(data, "input_tokens"),
      output_tokens: integer(data, "output_tokens"),
      reasoning_tokens: integer(data, "reasoning_tokens"),
      cache_read_tokens: integer(data, "cache_read_tokens"),
      total_tokens: integer(data, "total_tokens"),
      input_cost_microcents: integer(data, "input_cost_microcents"),
      output_cost_microcents: integer(data, "output_cost_microcents"),
      total_cost_microcents: integer(data, "total_cost_microcents"),
      avg_duration_ms: nullableNumber(data, "avg_duration_ms"),
      p50_duration_ms: nullableInteger(data, "p50_duration_ms"),
      p95_duration_ms: nullableInteger(data, "p95_duration_ms"),
      avg_ttfb_ms: nullableNumber(data, "avg_ttfb_ms"),
      p50_ttfb_ms: nullableInteger(data, "p50_ttfb_ms"),
      p95_ttfb_ms: nullableInteger(data, "p95_ttfb_ms"),
      avg_output_tps: nullableNumber(data, "avg_output_tps"),
      success_count: integer(data, "success_count"),
      error_count: integer(data, "error_count"),
      sample_count: integer(data, "sample_count"),
    },
  ]
}

function toStatRow(data: StatAggregate): StatRow {
  return {
    grain: data.grain,
    period_start: data.period_start,
    period_end: data.period_end,
    dataset: data.dataset,
    tier: data.tier,
    client: "all",
    source: "all",
    provider: data.provider,
    model: data.model,
    provider_model: "",
    sessions: data.sessions,
    requests: data.requests,
    input_tokens: data.input_tokens,
    output_tokens: data.output_tokens,
    reasoning_tokens: data.reasoning_tokens,
    cache_read_tokens: data.cache_read_tokens,
    total_tokens: data.total_tokens,
    input_cost_microcents: data.input_cost_microcents,
    output_cost_microcents: data.output_cost_microcents,
    total_cost_microcents: data.total_cost_microcents,
    avg_duration_ms: data.avg_duration_ms,
    p50_duration_ms: data.p50_duration_ms,
    p95_duration_ms: data.p95_duration_ms,
    avg_ttfb_ms: data.avg_ttfb_ms,
    p50_ttfb_ms: data.p50_ttfb_ms,
    p95_ttfb_ms: data.p95_ttfb_ms,
    avg_output_tps: data.avg_output_tps,
    success_count: data.success_count,
    error_count: data.error_count,
    sample_count: data.sample_count,
  }
}

function synthesizeAllTierRows(rows: StatRow[]) {
  return [
    ...rows,
    ...Object.values(
      rows.reduce<Record<string, StatRow>>((result, row) => {
        const key = [
          row.grain,
          row.period_start.toISOString(),
          row.dataset,
          row.client,
          row.source,
          row.provider,
          row.model,
        ].join("\u0000")
        result[key] = result[key] ? combineRows(result[key], row) : { ...row, tier: "all" }
        return result
      }, {}),
    ),
  ]
}

function collapseRows(rows: StatRow[]) {
  return Object.values(
    rows.reduce<Record<string, StatRow>>((result, row) => {
      const key = [
        row.grain,
        row.period_start.toISOString(),
        row.dataset,
        row.tier,
        row.client,
        row.source,
        row.provider,
        row.model,
      ].join("\u0000")
      result[key] = result[key] ? combineRows(result[key], row) : row
      return result
    }, {}),
  )
}

function combineRows(left: StatRow, right: StatRow): StatRow {
  return {
    ...left,
    period_end: right.period_end > left.period_end ? right.period_end : left.period_end,
    sessions: (left.sessions ?? 0) + (right.sessions ?? 0),
    requests: (left.requests ?? 0) + (right.requests ?? 0),
    input_tokens: (left.input_tokens ?? 0) + (right.input_tokens ?? 0),
    output_tokens: (left.output_tokens ?? 0) + (right.output_tokens ?? 0),
    reasoning_tokens: (left.reasoning_tokens ?? 0) + (right.reasoning_tokens ?? 0),
    cache_read_tokens: (left.cache_read_tokens ?? 0) + (right.cache_read_tokens ?? 0),
    total_tokens: (left.total_tokens ?? 0) + (right.total_tokens ?? 0),
    input_cost_microcents: (left.input_cost_microcents ?? 0) + (right.input_cost_microcents ?? 0),
    output_cost_microcents: (left.output_cost_microcents ?? 0) + (right.output_cost_microcents ?? 0),
    total_cost_microcents: (left.total_cost_microcents ?? 0) + (right.total_cost_microcents ?? 0),
    avg_duration_ms: weightedAverage(left.avg_duration_ms, left.requests, right.avg_duration_ms, right.requests),
    p50_duration_ms: null,
    p95_duration_ms: null,
    avg_ttfb_ms: weightedAverage(left.avg_ttfb_ms, left.requests, right.avg_ttfb_ms, right.requests),
    p50_ttfb_ms: null,
    p95_ttfb_ms: null,
    avg_output_tps: weightedAverage(left.avg_output_tps, left.requests, right.avg_output_tps, right.requests),
    success_count: (left.success_count ?? 0) + (right.success_count ?? 0),
    error_count: (left.error_count ?? 0) + (right.error_count ?? 0),
    sample_count: (left.sample_count ?? 0) + (right.sample_count ?? 0),
  }
}

function rankRows(rows: StatRow[]) {
  return Object.values(
    rows.reduce<Record<string, StatRow[]>>((result, row) => {
      const key = [row.grain, row.period_start.toISOString(), row.dataset, row.tier, row.client, row.source].join(
        "\u0000",
      )
      result[key] = [...(result[key] ?? []), row]
      return result
    }, {}),
  ).flatMap((group) => {
    const tokenRanks = rankBy(group, (row) => row.total_tokens ?? 0)
    const requestRanks = rankBy(group, (row) => row.requests ?? 0)
    const costRanks = rankBy(group, (row) => row.total_cost_microcents ?? 0)
    return group.map((row) => ({
      ...row,
      rank_by_tokens: tokenRanks.get(row) ?? null,
      rank_by_requests: requestRanks.get(row) ?? null,
      rank_by_cost: costRanks.get(row) ?? null,
    }))
  })
}

function rankBy(rows: StatRow[], value: (row: StatRow) => number) {
  return new Map(rows.toSorted((a, b) => value(b) - value(a)).map((row, index) => [row, index + 1]))
}

function chunks<T>(items: T[], size: number) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  )
}

function weightedAverage(
  left: number | null | undefined,
  leftWeight = 0,
  right: number | null | undefined,
  rightWeight = 0,
) {
  const totalWeight =
    (left === null || left === undefined ? 0 : leftWeight) + (right === null || right === undefined ? 0 : rightWeight)
  if (totalWeight === 0) return null
  return Number((((left ?? 0) * leftWeight + (right ?? 0) * rightWeight) / totalWeight).toFixed(2))
}

function normalizeTier(value: string) {
  if (value === "Paid") return "Zen"
  return value
}

function integer(data: AthenaData, key: string) {
  return Math.round(number(data, key))
}

function nullableNumber(data: AthenaData, key: string) {
  if (data[key] === undefined || data[key] === "") return null
  return Number(number(data, key).toFixed(2))
}

function nullableInteger(data: AthenaData, key: string) {
  if (data[key] === undefined || data[key] === "") return null
  return Math.round(number(data, key))
}

function number(data: AthenaData, key: string) {
  const value = Number(data[key])
  return Number.isFinite(value) ? value : 0
}

function rowData(columns: string[], row: Row): AthenaData {
  return Object.fromEntries(
    columns.flatMap((column, index) => {
      const value = row.Data?.[index]?.VarCharValue
      if (!column || value === undefined) return []
      return [[column, value]]
    }),
  )
}

function sqlIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`
}

function sqlString(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}
