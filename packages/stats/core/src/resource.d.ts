import "sst"

declare module "sst" {
  export interface Resource {
    StatsLake: {
      catalog: string
      database: string
      dataset: string
      region: string
      table: string
      tableBucket: string
      type: "sst.sst.Linkable"
      workgroup: string
    }
    StatsLakeIngestConfig: {
      secret: string
      streamName: string
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
