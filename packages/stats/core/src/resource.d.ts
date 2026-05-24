import "sst"

declare module "sst" {
  export interface Resource {
    InferenceEventLake: {
      catalog: string
      database: string
      region: string
      table: string
      tableBucket: string
      type: "sst.sst.Linkable"
      workgroup: string
    }
    InferenceEventLakeIngestConfig: {
      secret: string
      streamName: string
      type: "sst.sst.Linkable"
    }
    StatsSyncConfig: {
      dataset: string
      type: "sst.sst.Linkable"
    }
    StatsDatabase: {
      database: string
      host: string
      password: string
      port: number
      type: "sst.sst.Linkable"
      url: string
      username: string
    }
  }
}
