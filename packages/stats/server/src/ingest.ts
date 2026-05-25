import { Buffer } from "node:buffer"
import { FirehoseClient, PutRecordBatchCommand } from "@aws-sdk/client-firehose"
import { Effect, Layer, Schema } from "effect"
import * as Context from "effect/Context"
import { Resource } from "sst"

const MAX_FIREHOSE_BATCH_SIZE = 500
const MAX_FIREHOSE_ATTEMPTS = 3

type IngestEvent = Record<string, unknown>
type FirehoseRecord = { Data: Uint8Array }

export class IngestError extends Schema.TaggedErrorClass<IngestError>()("IngestError", {
  message: Schema.String,
  failed: Schema.Number,
  cause: Schema.optional(Schema.Defect),
}) {}

export declare namespace Ingest {
  export interface Service {
    readonly write: (events: IngestEvent[]) => Effect.Effect<{ records: number }, IngestError>
  }
}

export class Ingest extends Context.Service<Ingest, Ingest.Service>()("@opencode/stats/Ingest") {
  static readonly layer: Layer.Layer<Ingest> = Layer.effect(
    Ingest,
    Effect.sync(() => {
      const client = new FirehoseClient({})

      const write = Effect.fn("Ingest.write")(function* (events: IngestEvent[]) {
        if (events.length === 0) return { records: 0 }

        const failed = (
          yield* Effect.all(
            chunks(
              events.map((event) => ({ Data: Buffer.from(JSON.stringify(event)) })),
              MAX_FIREHOSE_BATCH_SIZE,
            ).map((batch) => putRecords(client, Resource.InferenceEventLakeIngestConfig.streamName, batch)),
            { concurrency: 8 },
          )
        ).reduce((sum, item) => sum + item, 0)

        if (failed > 0) {
          return yield* new IngestError({ message: "Failed to ingest all inference events", failed })
        }

        return { records: events.length }
      })

      return Ingest.of({ write })
    }),
  )
}

const putRecords: (
  client: FirehoseClient,
  streamName: string,
  records: FirehoseRecord[],
  attempt?: number,
) => Effect.Effect<number, IngestError> = Effect.fn("Ingest.putRecords")(function* (
  client,
  streamName,
  records,
  attempt = 1,
) {
  const result = yield* Effect.tryPromise({
    try: () => client.send(new PutRecordBatchCommand({ DeliveryStreamName: streamName, Records: records })),
    catch: (cause) => new IngestError({ message: "Failed to write inference events to Firehose", failed: records.length, cause }),
  })
  const failed =
    result.RequestResponses?.flatMap((item, index) => {
      const record = records[index]
      if (!item.ErrorCode || !record) return []
      return [record]
    }) ?? []

  if (failed.length === 0) return 0
  if (attempt >= MAX_FIREHOSE_ATTEMPTS) return failed.length

  yield* Effect.sleep(`${250 * 2 ** (attempt - 1)} millis`)
  return yield* putRecords(client, streamName, failed, attempt + 1)
})

function chunks<T>(items: T[], size: number) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  )
}
