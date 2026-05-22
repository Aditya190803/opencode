import { Resource } from "@opencode-ai/console-resource"
import type { TraceItem } from "@cloudflare/workers-types"

type MetricData = Record<string, unknown>
type MetricEvent = { time: string; data: MetricData }

export default {
  async tail(events: TraceItem[]) {
    for (const event of events) {
      if (!event.event) continue
      if (!("request" in event.event)) continue
      if (event.event.request.method !== "POST") continue

      const url = new URL(event.event.request.url)
      if (
        url.pathname !== "/zen/v1/chat/completions" &&
        url.pathname !== "/zen/v1/messages" &&
        url.pathname !== "/zen/v1/responses" &&
        !url.pathname.startsWith("/zen/v1/models/") &&
        url.pathname !== "/zen/go/v1/chat/completions" &&
        url.pathname !== "/zen/go/v1/messages" &&
        url.pathname !== "/zen/go/v1/responses" &&
        !url.pathname.startsWith("/zen/go/v1/models/")
      )
        continue

      let data: MetricData = {
        "cf.continent": event.event.request.cf?.continent,
        "cf.country": event.event.request.cf?.country,
        "cf.city": event.event.request.cf?.city,
        "cf.region": event.event.request.cf?.region,
        "cf.latitude": event.event.request.cf?.latitude,
        "cf.longitude": event.event.request.cf?.longitude,
        "cf.timezone": event.event.request.cf?.timezone,
        duration: event.wallTime,
        request_length: parseInt(event.event.request.headers["content-length"] ?? "0"),
        status: event.event.response?.status ?? 0,
        ip: event.event.request.headers["x-real-ip"],
      }
      const time = new Date(event.eventTimestamp ?? Date.now()).toISOString()
      const events: MetricEvent[] = []
      for (const log of event.logs) {
        for (const message of log.message) {
          if (!message.startsWith("_metric:")) continue
          const json = JSON.parse(message.slice(8)) as MetricData
          data = { ...data, ...json }
          if ("llm.error.code" in json) {
            events.push({ time, data: { ...data, event_type: "llm.error" } })
          }
        }
      }
      events.push({ time, data: { ...data, event_type: "completions" } })
      console.log(JSON.stringify(data, null, 2))

      const [honeycomb, lake] = await Promise.all([
        fetch("https://api.honeycomb.io/1/batch/zen", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Honeycomb-Team": Resource.HONEYCOMB_API_KEY.value,
          },
          body: JSON.stringify(events),
        }),
        fetch(Resource.StatsLakeIngest.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${Resource.StatsLakeIngest.secret}`,
          },
          body: JSON.stringify({ events: events.map((event) => toLakeEvent(event.time, event.data)) }),
        }),
      ])
      console.log(honeycomb.status)
      console.log(await honeycomb.text())
      console.log(lake.status)
      console.log(await lake.text())
    }
  },
}

function toLakeEvent(time: string, data: MetricData) {
  const tokensInput = integer(data, "tokens.input")
  const tokensOutput = integer(data, "tokens.output")
  const tokensReasoning = integer(data, "tokens.reasoning")
  const tokensCacheRead = integer(data, "tokens.cache_read")
  const tokensCacheWrite5m = integer(data, "tokens.cache_write_5m")
  const tokensCacheWrite1h = integer(data, "tokens.cache_write_1h")
  const timestampFirstByte = integer(data, "timestamp.first_byte")
  const timestampLastByte = integer(data, "timestamp.last_byte")
  const source = string(data, "source")

  return {
    event_timestamp: time,
    event_date: time.slice(0, 10),
    event_type: string(data, "event_type"),
    dataset: "zen",
    client: string(data, "client"),
    source,
    tier: tier(source),
    provider: string(data, "provider"),
    provider_model: string(data, "provider.model"),
    model: string(data, "model"),
    session: string(data, "session"),
    request: string(data, "request"),
    user_agent: string(data, "user_agent"),
    ip: string(data, "ip"),
    status: integer(data, "status"),
    is_stream: boolean(data, "is_stream"),
    duration_ms: integer(data, "duration"),
    ttfb_ms: integer(data, "time_to_first_byte"),
    request_length: integer(data, "request_length"),
    response_length: integer(data, "response_length"),
    timestamp_first_byte: timestampFirstByte,
    timestamp_last_byte: timestampLastByte,
    tokens_input: tokensInput,
    tokens_output: tokensOutput,
    tokens_reasoning: tokensReasoning,
    tokens_cache_read: tokensCacheRead,
    tokens_cache_write_5m: tokensCacheWrite5m,
    tokens_cache_write_1h: tokensCacheWrite1h,
    tokens_total:
      integer(data, "tokens") ??
      (tokensInput ?? 0) +
        (tokensOutput ?? 0) +
        (tokensReasoning ?? 0) +
        (tokensCacheRead ?? 0) +
        (tokensCacheWrite5m ?? 0) +
        (tokensCacheWrite1h ?? 0),
    cost_input_microcents: integer(data, "cost.input.microcents"),
    cost_output_microcents: integer(data, "cost.output.microcents"),
    cost_cache_read_microcents: integer(data, "cost.cache_read.microcents"),
    cost_cache_write_microcents: integer(data, "cost.cache_write.microcents"),
    cost_total_microcents: integer(data, "cost.total.microcents"),
    output_tps: number(data, "tps.output") ?? outputTps(tokensOutput, timestampFirstByte, timestampLastByte),
    cf_continent: string(data, "cf.continent"),
    cf_country: string(data, "cf.country"),
    cf_city: string(data, "cf.city"),
    cf_region: string(data, "cf.region"),
    cf_latitude: number(data, "cf.latitude"),
    cf_longitude: number(data, "cf.longitude"),
    cf_timezone: string(data, "cf.timezone"),
  }
}

function tier(source: string | undefined) {
  if (source === "anonymous" || source === "free") return "Free"
  if (source === "lite") return "Go"
  if (source === "subscription" || source === "balance") return "Zen"
  if (source === "byok") return "BYOK"
  return undefined
}

function outputTps(tokens: number | undefined, firstByte: number | undefined, lastByte: number | undefined) {
  if (!tokens || !firstByte || !lastByte || lastByte <= firstByte) return undefined
  return Number(((tokens / (lastByte - firstByte)) * 1000).toFixed(6))
}

function string(data: MetricData, key: string) {
  const value = data[key]
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return undefined
}

function boolean(data: MetricData, key: string) {
  const value = data[key]
  if (typeof value === "boolean") return value
  if (typeof value === "string") return value === "true" ? true : value === "false" ? false : undefined
  return undefined
}

function integer(data: MetricData, key: string) {
  const value = number(data, key)
  if (value === undefined) return undefined
  return Math.round(value)
}

function number(data: MetricData, key: string) {
  const value = data[key]
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}
