import { createHash } from "node:crypto"
import { Client } from "@planetscale/database"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/planetscale-serverless"
import { DateTime, Effect, Option, Schema } from "effect"
import { Resource } from "sst"
import { stat } from "../database/schema"

const HONEYCOMB_API_URL = "https://api.honeycomb.io"
const HONEYCOMB_DATASET = "zen"
const DAY_SECONDS = 86_400
const MAX_POLL_ATTEMPTS = 15
const UPSERT_CHUNK_SIZE = 500

type HoneycombScalar = string | number | boolean | null
type HoneycombData = Record<string, HoneycombScalar>
type HoneycombQueryResult = { results: HoneycombData[]; series: { time: Date; data: HoneycombData }[] }
type StatRow = typeof stat.$inferInsert
type SyncResult = { ok: true; rows: number; startedAt: string; periodStart: string; periodEnd: string }
type SyncError = HoneycombApiError | HoneycombQueryTimeoutError | StatDatabaseError

class HoneycombApiError extends Schema.TaggedErrorClass<HoneycombApiError>()("HoneycombApiError", {
  message: Schema.String,
  status: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect),
}) {}

class HoneycombQueryTimeoutError extends Schema.TaggedErrorClass<HoneycombQueryTimeoutError>()(
  "HoneycombQueryTimeoutError",
  {
    message: Schema.String,
    resultId: Schema.String,
  },
) {}

class StatDatabaseError extends Schema.TaggedErrorClass<StatDatabaseError>()("StatDatabaseError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

const calculations = [
  { op: "COUNT" },
  { op: "COUNT_DISTINCT", column: "session" },
  { op: "SUM", column: "tokens.input" },
  { op: "SUM", column: "tokens.output" },
  { op: "SUM", column: "tokens.reasoning" },
  { op: "SUM", column: "tokens.cache_read" },
  { op: "SUM", column: "tokens" },
  { op: "SUM", column: "cost.input.microcents" },
  { op: "SUM", column: "cost.output.microcents" },
  { op: "SUM", column: "cost.total.microcents" },
  { op: "AVG", column: "duration" },
  { op: "P50", column: "duration" },
  { op: "P95", column: "duration" },
  { op: "AVG", column: "time_to_first_byte" },
  { op: "P50", column: "time_to_first_byte" },
  { op: "P95", column: "time_to_first_byte" },
  { op: "AVG", column: "tps.output" },
  { op: "SUM", column: "stats_success" },
  { op: "SUM", column: "stats_error" },
] as const

export function handler(): Promise<SyncResult> {
  return Effect.runPromise(syncStats())
}

const syncStats: () => Effect.Effect<SyncResult, SyncError, never> = Effect.fn("StatsCron.sync")(function* () {
  const startedAt = yield* DateTime.nowAsDate
  const periodEnd = new Date(Math.floor(startedAt.getTime() / 3_600_000) * 3_600_000)
  const periodStart = new Date(
    Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth(), periodEnd.getUTCDate() - 6),
  )

  yield* logHoneycombRuntimeCheck()

  const result = yield* runHoneycombQuery({
    start_time: Math.floor(periodStart.getTime() / 1000),
    end_time: Math.floor(periodEnd.getTime() / 1000),
    granularity: DAY_SECONDS,
    breakdowns: ["tier", "provider", "model"],
    calculations,
    calculated_fields: [
      {
        name: "stats_success",
        expression: `IF(AND(GTE($status, "200"), LT($status, "400")), 1, 0)`,
      },
      {
        name: "stats_error",
        expression: `IF(GTE($status, "400"), 1, 0)`,
      },
    ],
    filters: [
      { column: "event_type", op: "=", value: "completions" },
      { column: "model", op: "exists" },
      { column: "user_agent", op: "contains", value: "opencode" },
    ],
    filter_combination: "AND",
    orders: [{ column: "tokens", op: "SUM", order: "descending" }],
    limit: 1000,
  })
  const rows = rankRows([
    ...synthesizeAllTierRows(
      collapseRows(result.results.map((item) => toStatRow("week", periodStart, periodEnd, item))),
    ),
    ...synthesizeAllTierRows(
      collapseRows(
        result.series.map((item) =>
          toStatRow(
            "day",
            item.time,
            new Date(Math.min(item.time.getTime() + DAY_SECONDS * 1000, periodEnd.getTime())),
            item.data,
          ),
        ),
      ),
    ),
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

const runHoneycombQuery: (
  query: Record<string, unknown>,
) => Effect.Effect<HoneycombQueryResult, HoneycombApiError | HoneycombQueryTimeoutError, never> = Effect.fn(
  "StatsCron.runHoneycombQuery",
)(function* (query: Record<string, unknown>) {
  const created = asRecord(yield* honeycombRequest(`/1/queries/${HONEYCOMB_DATASET}`, "POST", query))
  const queryId = asString(created.id)
  if (!queryId) return yield* new HoneycombApiError({ message: "Honeycomb did not return a query id" })

  const queued = asRecord(
    yield* honeycombRequest(`/1/query_results/${HONEYCOMB_DATASET}`, "POST", {
      query_id: queryId,
      disable_series: false,
      disable_total_by_aggregate: true,
      disable_other_by_aggregate: true,
      limit: 1000,
    }),
  )
  const resultId = asString(queued.id)
  if (!resultId) return yield* new HoneycombApiError({ message: "Honeycomb did not return a query result id" })

  return yield* pollHoneycombResult(resultId)
})

const pollHoneycombResult: (
  resultId: string,
  attempt?: number,
) => Effect.Effect<HoneycombQueryResult, HoneycombApiError | HoneycombQueryTimeoutError, never> = Effect.fn(
  "StatsCron.pollHoneycombResult",
)(function* (resultId: string, attempt = 0) {
  if (attempt > 0) yield* Effect.sleep("1000 millis")
  const result = asRecord(yield* honeycombRequest(`/1/query_results/${HONEYCOMB_DATASET}/${resultId}`, "GET"))

  if (result.complete === true) {
    const data = asRecord(result.data)
    return {
      results: asArray(data.results).map((item) => asData(asRecord(item).data)),
      series: asArray(data.series).flatMap((item) => {
        const time = new Date(String(asRecord(item).time ?? ""))
        if (Number.isNaN(time.getTime())) return []
        return [{ time, data: asData(asRecord(item).data) }]
      }),
    }
  }

  if (attempt >= MAX_POLL_ATTEMPTS - 1)
    return yield* new HoneycombQueryTimeoutError({
      message: `Honeycomb query result ${resultId} did not complete`,
      resultId,
    })

  return yield* pollHoneycombResult(resultId, attempt + 1)
})

const honeycombRequest: (
  path: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
) => Effect.Effect<unknown, HoneycombApiError, never> = Effect.fn("StatsCron.honeycombRequest")(function* (
  path: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
) {
  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(`${HONEYCOMB_API_URL}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Honeycomb-Team": Resource.HONEYCOMB_API_KEY.value,
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    catch: (cause) => new HoneycombApiError({ message: `Honeycomb ${method} ${path} request failed`, cause }),
  })
  const text = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) => new HoneycombApiError({ message: `Honeycomb ${method} ${path} response read failed`, cause }),
  })

  if (!response.ok)
    return yield* new HoneycombApiError({
      message: `Honeycomb ${method} ${path} failed: ${response.status} ${text.slice(0, 500)}`,
      status: response.status,
    })
  if (!text) return {}

  const parsed = decodeJson(text)
  if (Option.isNone(parsed))
    return yield* new HoneycombApiError({ message: `Honeycomb ${method} ${path} returned invalid JSON` })
  return parsed.value
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

function logHoneycombRuntimeCheck() {
  return Effect.logInfo("honeycomb api key runtime check").pipe(
    Effect.annotateLogs({
      hasHoneycombApiKey: Boolean(Resource.HONEYCOMB_API_KEY.value),
      honeycombApiKeyLength: Resource.HONEYCOMB_API_KEY.value.length,
      honeycombApiKeySha256: createHash("sha256").update(Resource.HONEYCOMB_API_KEY.value).digest("hex").slice(0, 12),
      honeycombApiUrl: HONEYCOMB_API_URL,
    }),
  )
}

function inserted(column: string) {
  return sql.raw(`values(\`${column}\`)`)
}

function toStatRow(grain: "day" | "week", periodStart: Date, periodEnd: Date, data: HoneycombData): StatRow {
  return {
    grain,
    period_start: periodStart,
    period_end: periodEnd,
    dataset: HONEYCOMB_DATASET,
    tier: normalizeTier(asString(data.tier) || "unknown"),
    client: "all",
    source: "all",
    provider: asString(data.provider) || "unknown",
    model: asString(data.model) || "unknown",
    provider_model: "",
    sessions: Math.round(number(data, "COUNT_DISTINCT(session)")),
    requests: Math.round(number(data, "COUNT")),
    input_tokens: Math.round(number(data, "SUM(tokens.input)")),
    output_tokens: Math.round(number(data, "SUM(tokens.output)")),
    reasoning_tokens: Math.round(number(data, "SUM(tokens.reasoning)")),
    cache_read_tokens: Math.round(number(data, "SUM(tokens.cache_read)")),
    total_tokens: Math.round(number(data, "SUM(tokens)")),
    input_cost_microcents: Math.round(number(data, "SUM(cost.input.microcents)")),
    output_cost_microcents: Math.round(number(data, "SUM(cost.output.microcents)")),
    total_cost_microcents: Math.round(number(data, "SUM(cost.total.microcents)")),
    avg_duration_ms: nullableNumber(data, "AVG(duration)"),
    p50_duration_ms: nullableInteger(data, "P50(duration)"),
    p95_duration_ms: nullableInteger(data, "P95(duration)"),
    avg_ttfb_ms: nullableNumber(data, "AVG(time_to_first_byte)"),
    p50_ttfb_ms: nullableInteger(data, "P50(time_to_first_byte)"),
    p95_ttfb_ms: nullableInteger(data, "P95(time_to_first_byte)"),
    avg_output_tps: nullableNumber(data, "AVG(tps.output)"),
    success_count: Math.round(number(data, "SUM(stats_success)")),
    error_count: Math.round(number(data, "SUM(stats_error)")),
    sample_count: Math.round(number(data, "COUNT")),
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

function number(data: HoneycombData, key: string) {
  const value = data[key]
  if (typeof value === "number") return Number.isFinite(value) ? value : 0
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function nullableNumber(data: HoneycombData, key: string) {
  const value = number(data, key)
  if (value === 0 && data[key] === undefined) return null
  return Number(value.toFixed(2))
}

function nullableInteger(data: HoneycombData, key: string) {
  if (data[key] === undefined) return null
  return Math.round(number(data, key))
}

function asData(value: unknown): HoneycombData {
  return Object.fromEntries(
    Object.entries(asRecord(value)).flatMap(([key, item]) => {
      if (typeof item === "string" || typeof item === "number" || typeof item === "boolean" || item === null)
        return [[key, item]]
      return []
    }),
  )
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function asArray(value: unknown) {
  if (!Array.isArray(value)) return []
  return value
}

function asString(value: unknown) {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return ""
}
