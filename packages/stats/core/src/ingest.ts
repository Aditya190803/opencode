import { Buffer } from "node:buffer"
import { timingSafeEqual } from "node:crypto"
import { FirehoseClient, PutRecordBatchCommand } from "@aws-sdk/client-firehose"
import { Resource } from "sst"

const MAX_FIREHOSE_BATCH_SIZE = 500
const MAX_FIREHOSE_ATTEMPTS = 3
const client = new FirehoseClient({})

type FirehoseRecord = { Data: Uint8Array }

type FunctionUrlEvent = {
  body?: string | null
  headers?: Record<string, string | undefined>
  isBase64Encoded?: boolean
  requestContext?: {
    http?: {
      method?: string
    }
  }
}

type IngestPayload = {
  events?: unknown
}

export async function handler(event: FunctionUrlEvent) {
  if (event.requestContext?.http?.method !== "POST") return response(405, { ok: false, error: "Method Not Allowed" })
  if (!isAuthorized(event.headers ?? {})) return response(401, { ok: false, error: "Unauthorized" })

  const payload = parsePayload(event)
  if (!payload) return response(400, { ok: false, error: "Invalid JSON body" })

  const events = Array.isArray(payload.events)
    ? payload.events.filter(
        (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : []
  if (events.length === 0) return response(202, { ok: true, records: 0 })

  const failed = (
    await Promise.all(
      chunks(
        events.map((item) => ({ Data: Buffer.from(JSON.stringify(item)) })),
        MAX_FIREHOSE_BATCH_SIZE,
      ).map((batch) => putRecords(Resource.StatsLakeIngestConfig.streamName, batch)),
    )
  ).reduce((sum, item) => sum + item, 0)
  if (failed > 0) return response(502, { ok: false, records: events.length, failed })

  return response(202, { ok: true, records: events.length })
}

async function putRecords(streamName: string, records: FirehoseRecord[], attempt = 1): Promise<number> {
  const result = await client.send(new PutRecordBatchCommand({ DeliveryStreamName: streamName, Records: records }))
  const failed =
    result.RequestResponses?.flatMap((item, index) => {
      const record = records[index]
      if (!item.ErrorCode || !record) return []
      return [record]
    }) ?? []
  if (failed.length === 0) return 0
  if (attempt >= MAX_FIREHOSE_ATTEMPTS) return failed.length

  await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)))
  return putRecords(streamName, failed, attempt + 1)
}

function parsePayload(event: FunctionUrlEvent): IngestPayload | undefined {
  try {
    return JSON.parse(
      event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : (event.body ?? ""),
    ) as IngestPayload
  } catch {
    return undefined
  }
}

function isAuthorized(headers: Record<string, string | undefined>) {
  const actual = Buffer.from(headers.authorization ?? headers.Authorization ?? "")
  const expected = Buffer.from(`Bearer ${Resource.StatsLakeIngestConfig.secret}`)
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

function chunks<T>(items: T[], size: number) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  )
}

function response(statusCode: number, body: Record<string, unknown>) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }
}
