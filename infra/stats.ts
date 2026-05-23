const domain = (() => {
  if ($app.stage === "production") return "stats.opencode.ai"
  if ($app.stage === "dev") return "stats.dev.opencode.ai"
  return `stats.${$app.stage}.dev.opencode.ai`
})()

const current = aws.getCallerIdentityOutput({})
const partition = aws.getPartitionOutput({})
const region = aws.getRegionOutput({})

const tableBucketName = `opencode-${$app.stage}-datalake`
const tableNamespaceName = "inference"
const tableName = "event"
const glueCatalogName = "s3tablescatalog"
const glueCatalogArn = $interpolate`arn:${partition.partition}:glue:${region.region}:${current.accountId}:catalog`
const glueS3TablesCatalogArn = $interpolate`${glueCatalogArn}/${glueCatalogName}`
const glueS3TablesChildCatalogArn = $interpolate`${glueS3TablesCatalogArn}/${tableBucketName}`
const glueS3TablesDatabaseArn = $interpolate`arn:${partition.partition}:glue:${region.region}:${current.accountId}:database/${glueCatalogName}/${tableBucketName}/${tableNamespaceName}`
const glueS3TablesTableArn = $interpolate`arn:${partition.partition}:glue:${region.region}:${current.accountId}:table/${glueCatalogName}/${tableBucketName}/${tableNamespaceName}/${tableName}`
const s3TablesBucketWildcardArn = $interpolate`arn:${partition.partition}:s3tables:${region.region}:${current.accountId}:bucket/*`

const eventSchema = [
  { name: "event_timestamp", type: "string", required: false },
  { name: "event_date", type: "string", required: false },
  { name: "event_type", type: "string", required: false },
  { name: "dataset", type: "string", required: false },
  { name: "client", type: "string", required: false },
  { name: "source", type: "string", required: false },
  { name: "tier", type: "string", required: false },
  { name: "provider", type: "string", required: false },
  { name: "provider_model", type: "string", required: false },
  { name: "model", type: "string", required: false },
  { name: "session", type: "string", required: false },
  { name: "request", type: "string", required: false },
  { name: "user_agent", type: "string", required: false },
  { name: "ip", type: "string", required: false },
  { name: "status", type: "int", required: false },
  { name: "is_stream", type: "boolean", required: false },
  { name: "duration_ms", type: "long", required: false },
  { name: "ttfb_ms", type: "long", required: false },
  { name: "request_length", type: "long", required: false },
  { name: "response_length", type: "long", required: false },
  { name: "timestamp_first_byte", type: "long", required: false },
  { name: "timestamp_last_byte", type: "long", required: false },
  { name: "tokens_input", type: "long", required: false },
  { name: "tokens_output", type: "long", required: false },
  { name: "tokens_reasoning", type: "long", required: false },
  { name: "tokens_cache_read", type: "long", required: false },
  { name: "tokens_cache_write_5m", type: "long", required: false },
  { name: "tokens_cache_write_1h", type: "long", required: false },
  { name: "tokens_total", type: "long", required: false },
  { name: "cost_input_microcents", type: "long", required: false },
  { name: "cost_output_microcents", type: "long", required: false },
  { name: "cost_cache_read_microcents", type: "long", required: false },
  { name: "cost_cache_write_microcents", type: "long", required: false },
  { name: "cost_total_microcents", type: "long", required: false },
  { name: "output_tps", type: "double", required: false },
  { name: "cf_continent", type: "string", required: false },
  { name: "cf_country", type: "string", required: false },
  { name: "cf_city", type: "string", required: false },
  { name: "cf_region", type: "string", required: false },
  { name: "cf_latitude", type: "double", required: false },
  { name: "cf_longitude", type: "double", required: false },
  { name: "cf_timezone", type: "string", required: false },
]

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
// DATA LAKE
////////////////

const tableBucket = new aws.s3tables.TableBucket("StatsLakeTableBucket", {
  name: tableBucketName,
  forceDestroy: $app.stage !== "production",
  tags: {
    app: $app.name,
    stage: $app.stage,
  },
})

const namespace = new aws.s3tables.Namespace("StatsLakeNamespace", {
  namespace: tableNamespaceName,
  tableBucketArn: tableBucket.arn,
})

const eventsTable = new aws.s3tables.Table("StatsLakeEventsTable", {
  name: tableName,
  namespace: namespace.namespace,
  tableBucketArn: namespace.tableBucketArn,
  format: "ICEBERG",
  metadata: {
    iceberg: {
      schema: {
        fields: eventSchema,
      },
    },
  },
  tags: {
    app: $app.name,
    stage: $app.stage,
  },
})

const s3TablesCatalog = new aws.cloudcontrol.Resource(
  "StatsLakeS3TablesCatalog",
  {
    typeName: "AWS::Glue::Catalog",
    desiredState: $jsonStringify({
      Name: glueCatalogName,
      Description: "Federated catalog for S3 Tables",
      FederatedCatalog: {
        Identifier: s3TablesBucketWildcardArn,
        ConnectionName: "aws:s3tables",
      },
      CreateDatabaseDefaultPermissions: [
        {
          Principal: {
            DataLakePrincipalIdentifier: "IAM_ALLOWED_PRINCIPALS",
          },
          Permissions: ["ALL"],
        },
      ],
      CreateTableDefaultPermissions: [
        {
          Principal: {
            DataLakePrincipalIdentifier: "IAM_ALLOWED_PRINCIPALS",
          },
          Permissions: ["ALL"],
        },
      ],
      AllowFullTableExternalDataAccess: "True",
    }),
  },
  { dependsOn: [tableBucket] },
)

const athenaResultsBucket = new aws.s3.Bucket("StatsLakeAthenaResults", {
  bucket: `opencode-${$app.stage}-stats-athena-results`,
  forceDestroy: $app.stage !== "production",
  tags: {
    app: $app.name,
    stage: $app.stage,
  },
})

const firehoseErrorBucket = new aws.s3.Bucket("StatsLakeFirehoseErrors", {
  bucket: `opencode-${$app.stage}-stats-firehose-errors`,
  forceDestroy: $app.stage !== "production",
  tags: {
    app: $app.name,
    stage: $app.stage,
  },
})

const athenaWorkgroup = new aws.athena.Workgroup("StatsLakeAthenaWorkgroup", {
  name: `opencode-${$app.stage}-stats`,
  forceDestroy: $app.stage !== "production",
  configuration: {
    enforceWorkgroupConfiguration: true,
    publishCloudwatchMetricsEnabled: true,
    resultConfiguration: {
      outputLocation: $interpolate`s3://${athenaResultsBucket.bucket}/`,
    },
  },
  tags: {
    app: $app.name,
    stage: $app.stage,
  },
})

const firehoseRole = new aws.iam.Role("StatsLakeFirehoseRole", {
  assumeRolePolicy: aws.iam.getPolicyDocumentOutput({
    statements: [
      {
        effect: "Allow",
        actions: ["sts:AssumeRole"],
        principals: [
          {
            type: "Service",
            identifiers: ["firehose.amazonaws.com"],
          },
        ],
      },
    ],
  }).json,
  tags: {
    app: $app.name,
    stage: $app.stage,
  },
})

const firehosePolicy = new aws.iam.RolePolicy("StatsLakeFirehosePolicy", {
  role: firehoseRole.id,
  policy: aws.iam.getPolicyDocumentOutput({
    statements: [
      {
        effect: "Allow",
        actions: [
          "s3tables:ListTableBuckets",
          "s3tables:GetTableBucket",
          "s3tables:GetNamespace",
          "s3tables:GetTable",
          "s3tables:GetTableData",
          "s3tables:GetTableMetadataLocation",
          "s3tables:ListNamespaces",
          "s3tables:ListTables",
          "s3tables:PutTableData",
          "s3tables:UpdateTableMetadataLocation",
        ],
        resources: ["*"],
      },
      {
        effect: "Allow",
        actions: [
          "glue:GetCatalog",
          "glue:GetCatalogs",
          "glue:GetDatabase",
          "glue:GetDatabases",
          "glue:GetTable",
          "glue:GetTables",
          "glue:UpdateTable",
        ],
        resources: [
          glueCatalogArn,
          glueS3TablesCatalogArn,
          $interpolate`${glueS3TablesCatalogArn}/*`,
          glueS3TablesDatabaseArn,
          glueS3TablesTableArn,
          $interpolate`arn:${partition.partition}:glue:${region.region}:${current.accountId}:database/*`,
          $interpolate`arn:${partition.partition}:glue:${region.region}:${current.accountId}:table/*/*`,
          $interpolate`arn:${partition.partition}:glue:${region.region}:${current.accountId}:table/${glueCatalogName}/*`,
        ],
      },
      {
        effect: "Allow",
        actions: [
          "s3:AbortMultipartUpload",
          "s3:GetBucketLocation",
          "s3:GetObject",
          "s3:ListBucket",
          "s3:ListBucketMultipartUploads",
          "s3:PutObject",
        ],
        resources: [firehoseErrorBucket.arn, $interpolate`${firehoseErrorBucket.arn}/*`],
      },
      {
        effect: "Allow",
        actions: ["lakeformation:GetDataAccess"],
        resources: ["*"],
      },
    ],
  }).json,
})

const firehose = new aws.kinesis.FirehoseDeliveryStream(
  "StatsLakeFirehose",
  {
    name: `opencode-${$app.stage}-datalake-ingest`,
    destination: "iceberg",
    icebergConfiguration: {
      appendOnly: true,
      bufferingInterval: 60,
      bufferingSize: 1,
      catalogArn: glueS3TablesChildCatalogArn,
      destinationTableConfigurations: [
        {
          databaseName: namespace.namespace,
          tableName: eventsTable.name,
          s3ErrorOutputPrefix: "events/",
        },
      ],
      roleArn: firehoseRole.arn,
      s3BackupMode: "FailedDataOnly",
      s3Configuration: {
        roleArn: firehoseRole.arn,
        bucketArn: firehoseErrorBucket.arn,
        errorOutputPrefix: "errors/!{firehose:error-output-type}/",
      },
    },
    tags: {
      app: $app.name,
      stage: $app.stage,
    },
  },
  { dependsOn: [s3TablesCatalog, eventsTable, firehosePolicy] },
)

export const lake = new sst.Linkable("StatsLake", {
  properties: {
    region: region.region,
    catalog: $interpolate`${glueCatalogName}/${tableBucket.name}`,
    database: namespace.namespace,
    table: eventsTable.name,
    tableBucket: tableBucket.name,
    workgroup: athenaWorkgroup.name,
    dataset: "zen",
  },
})

const ingestSecret = new random.RandomPassword("StatsLakeIngestSecret", { length: 32 })

const ingestConfig = new sst.Linkable("StatsLakeIngestConfig", {
  properties: {
    streamName: firehose.name,
    secret: ingestSecret.result,
  },
})

const ingestFunction = new sst.aws.Function("StatsLakeIngestFunction", {
  handler: "packages/stats/function/src/ingest.handler",
  runtime: "nodejs22.x",
  timeout: "30 seconds",
  url: true,
  link: [ingestConfig],
  permissions: [
    {
      actions: ["firehose:PutRecord", "firehose:PutRecordBatch"],
      resources: [firehose.arn],
    },
  ],
})

export const lakeIngest = new sst.Linkable("StatsLakeIngest", {
  properties: {
    url: ingestFunction.url,
    secret: ingestSecret.result,
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
    DATABASE_URL: databaseUrl,
    PUBLIC_URL: `https://${domain}`,
    SST_STAGE: $app.stage,
  },
})

////////////////
// JOBS
////////////////

export const statSync = new sst.aws.Cron("StatsSync", {
  schedule: "rate(1 minute)",
  function: {
    handler: "packages/stats/function/src/stat.handler",
    runtime: "nodejs22.x",
    timeout: "5 minutes",
    link: [database, lake],
    permissions: [
      {
        actions: ["athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults"],
        resources: [athenaWorkgroup.arn],
      },
      {
        actions: [
          "glue:GetCatalog",
          "glue:GetCatalogs",
          "glue:GetDatabase",
          "glue:GetDatabases",
          "glue:GetTable",
          "glue:GetTables",
          "glue:GetPartitions",
        ],
        resources: [
          glueCatalogArn,
          glueS3TablesCatalogArn,
          $interpolate`${glueS3TablesCatalogArn}/*`,
          glueS3TablesDatabaseArn,
          glueS3TablesTableArn,
          $interpolate`arn:${partition.partition}:glue:${region.region}:${current.accountId}:database/*`,
          $interpolate`arn:${partition.partition}:glue:${region.region}:${current.accountId}:table/*/*`,
          $interpolate`arn:${partition.partition}:glue:${region.region}:${current.accountId}:table/${glueCatalogName}/*`,
        ],
      },
      {
        actions: ["s3:GetBucketLocation", "s3:ListBucket"],
        resources: [athenaResultsBucket.arn],
      },
      {
        actions: ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload", "s3:ListBucketMultipartUploads"],
        resources: [$interpolate`${athenaResultsBucket.arn}/*`],
      },
      {
        actions: [
          "s3tables:GetTableBucket",
          "s3tables:GetNamespace",
          "s3tables:GetTable",
          "s3tables:GetTableData",
          "s3tables:GetTableMetadataLocation",
          "s3tables:ListNamespaces",
          "s3tables:ListTables",
        ],
        resources: ["*"],
      },
      {
        actions: ["lakeformation:GetDataAccess"],
        resources: ["*"],
      },
    ],
  },
})
