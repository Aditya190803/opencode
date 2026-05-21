import "sst"

declare module "sst" {
  export interface Resource {
    HONEYCOMB_API_KEY: {
      type: "sst.sst.Secret"
      value: string
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
