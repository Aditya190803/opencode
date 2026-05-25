import { inferenceEventLake, inferenceEventLakeQueryPermissions, lakeCluster } from "./lake"

const domain = (() => {
  if ($app.stage === "production") return "stats.opencode.ai"
  if ($app.stage === "dev") return "stats.dev.opencode.ai"
  return `stats.${$app.stage}.dev.opencode.ai`
})()

////////////////
// DATABASE
////////////////

const cluster = planetscale.getDatabaseOutput({
  name: "opencode-stats",
  organization: "anomalyco",
})

const branch =
  $app.stage === "production"
    ? planetscale.getBranchOutput({
        name: "production",
        organization: cluster.organization,
        database: cluster.name,
      })
    : new planetscale.Branch("StatsDatabaseBranch", {
        database: cluster.name,
        organization: cluster.organization,
        name: $app.stage,
        parentBranch: "production",
      })

const password = new planetscale.Password("StatsDatabasePassword", {
  name: $app.stage,
  database: cluster.name,
  organization: cluster.organization,
  branch: branch.name,
})

const databaseUrl = $interpolate`mysql://${password.username.apply(encodeURIComponent)}:${password.plaintext.apply(
  encodeURIComponent,
)}@${password.accessHostUrl}/${cluster.name}`

export const database = new sst.Linkable("StatsDatabase", {
  properties: {
    host: password.accessHostUrl,
    database: cluster.name,
    username: password.username,
    password: password.plaintext,
    port: 3306,
    url: databaseUrl,
  },
})

new sst.x.DevCommand("StatsStudio", {
  link: [database],
  environment: {
    DATABASE_URL: databaseUrl,
  },
  dev: {
    command: "bun db:studio",
    directory: "packages/stats/core",
    autostart: false,
  },
})

////////////////
// APP
////////////////

export const app = new sst.aws.SolidStart("Stats", {
  path: "packages/stats/app",
  buildCommand: "bun run build",
  domain: {
    name: domain,
    dns: sst.cloudflare.dns(),
  },
  link: [database],
  environment: {
    PUBLIC_URL: `https://${domain}`,
  },
})

////////////////
// SERVICES
////////////////

const statsSyncConfig = new sst.Linkable("StatsSyncConfig", {
  properties: {
    dataset: "zen",
  },
})

export const statSync = new sst.aws.Service("StatsSyncService", {
  cluster: lakeCluster,
  architecture: "arm64",
  cpu: "0.25 vCPU",
  memory: "0.5 GB",
  image: {
    context: ".",
    dockerfile: "packages/stats/server/Dockerfile",
  },
  command: ["bun", "src/stat-sync.ts"],
  link: [database, inferenceEventLake, statsSyncConfig],
  permissions: inferenceEventLakeQueryPermissions,
  scaling: {
    min: 1,
    max: 1,
  },
  dev: {
    command: "bun src/stat-sync.ts",
    directory: "packages/stats/server",
    autostart: false,
  },
})
