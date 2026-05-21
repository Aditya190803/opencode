import { Layer, ManagedRuntime } from "effect"
import { AppConfig } from "./config"
import { layer as databaseLayer } from "./database"

export const layer = Layer.mergeAll(AppConfig.layer, databaseLayer)
export const runtime = ManagedRuntime.make(layer)
export type RuntimeServices = ManagedRuntime.ManagedRuntime.Services<typeof runtime>
