import { Schema } from "effect"

export const RankingSnapshotId = Schema.String.check(Schema.isStartsWith("rank_"), Schema.isMaxLength(64)).pipe(
  Schema.brand("RankingSnapshotId"),
)
export type RankingSnapshotId = typeof RankingSnapshotId.Type

export const RankingSource = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(120)).pipe(
  Schema.brand("RankingSource"),
)
export type RankingSource = typeof RankingSource.Type

export const RankingSnapshotPayload = Schema.Record(Schema.String, Schema.Json)
export type RankingSnapshotPayload = typeof RankingSnapshotPayload.Type

export class RankingSnapshot extends Schema.Class<RankingSnapshot>("RankingSnapshot")({
  id: RankingSnapshotId,
  source: RankingSource,
  payload: RankingSnapshotPayload,
  capturedAt: Schema.Date,
  createdAt: Schema.Date,
}) {}
