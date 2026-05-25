import "sst"

declare module "sst" {
  export interface Resource {
    InferenceEventLakeIngestConfig: {
      secret: string
      streamName: string
      type: "sst.sst.Linkable"
    }
  }
}
