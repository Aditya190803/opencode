import "sst"

declare module "sst" {
  export interface Resource {
    InferenceEventLakeIngest: {
      secret: string
      type: "sst.sst.Linkable"
      url: string
    }
  }
}
