const current = aws.getCallerIdentityOutput({})
const partition = aws.getPartitionOutput({})
const region = aws.getRegionOutput({})

const tableBucketName = `opencode-${$app.stage}-lake`
const inferenceNamespaceName = "inference"
const inferenceEventTableName = "event"
const glueCatalogName = "s3tablescatalog"
const glueCatalogArn = $interpolate`arn:${partition.partition}:glue:${region.region}:${current.accountId}:catalog`
const glueS3TablesCatalogArn = $interpolate`${glueCatalogArn}/${glueCatalogName}`
const glueS3TablesChildCatalogArn = $interpolate`${glueS3TablesCatalogArn}/${tableBucketName}`
const glueS3TablesDatabaseArn = $interpolate`arn:${partition.partition}:glue:${region.region}:${current.accountId}:database/${glueCatalogName}/${tableBucketName}/${inferenceNamespaceName}`
const glueS3TablesTableArn = $interpolate`arn:${partition.partition}:glue:${region.region}:${current.accountId}:table/${glueCatalogName}/${tableBucketName}/${inferenceNamespaceName}/${inferenceEventTableName}`
const s3TablesBucketWildcardArn = $interpolate`arn:${partition.partition}:s3tables:${region.region}:${current.accountId}:bucket/*`

const tableBucket = new aws.s3tables.TableBucket(
  "LakeTableBucket",
  {
    name: tableBucketName,
    forceDestroy: $app.stage !== "production",
  },
  { aliases: [{ name: "StatsLakeTableBucket" }] },
)

const inferenceNamespace = new aws.s3tables.Namespace(
  "LakeInferenceNamespace",
  {
    namespace: inferenceNamespaceName,
    tableBucketArn: tableBucket.arn,
  },
  { aliases: [{ name: "StatsLakeNamespace" }] },
)

const inferenceEventTable = new aws.s3tables.Table(
  "LakeInferenceEventTable",
  {
    name: inferenceEventTableName,
    namespace: inferenceNamespace.namespace,
    tableBucketArn: inferenceNamespace.tableBucketArn,
    format: "ICEBERG",
    metadata: {
      iceberg: {
        schema: {
          fields: [
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
          ],
        },
      },
    },
  },
  { aliases: [{ name: "StatsLakeEventsTable" }] },
)

const s3TablesCatalog = new aws.cloudcontrol.Resource(
  "LakeS3TablesCatalog",
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
  { aliases: [{ name: "StatsLakeS3TablesCatalog" }], dependsOn: [tableBucket] },
)

const athenaResultsBucket = new aws.s3.Bucket(
  "LakeAthenaResults",
  {
    bucket: `opencode-${$app.stage}-datalake-athena-results`,
    forceDestroy: $app.stage !== "production",
  },
  { aliases: [{ name: "StatsLakeAthenaResults" }] },
)

const firehoseErrorBucket = new aws.s3.Bucket(
  "LakeInferenceEventFirehoseErrors",
  {
    bucket: `opencode-${$app.stage}-inference-event-firehose-errors`,
    forceDestroy: $app.stage !== "production",
  },
  { aliases: [{ name: "StatsLakeFirehoseErrors" }] },
)

const athenaWorkgroup = new aws.athena.Workgroup(
  "LakeAthenaWorkgroup",
  {
    name: `opencode-${$app.stage}-datalake`,
    forceDestroy: $app.stage !== "production",
    configuration: {
      enforceWorkgroupConfiguration: true,
      publishCloudwatchMetricsEnabled: true,
      resultConfiguration: {
        outputLocation: $interpolate`s3://${athenaResultsBucket.bucket}/`,
      },
    },
  },
  { aliases: [{ name: "StatsLakeAthenaWorkgroup" }] },
)

const firehoseRole = new aws.iam.Role(
  "LakeInferenceEventFirehoseRole",
  {
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
  },
  { aliases: [{ name: "StatsLakeFirehoseRole" }] },
)

const firehosePolicy = new aws.iam.RolePolicy(
  "LakeInferenceEventFirehosePolicy",
  {
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
  },
  { aliases: [{ name: "StatsLakeFirehosePolicy" }] },
)

const firehose = new aws.kinesis.FirehoseDeliveryStream(
  "LakeInferenceEventFirehose",
  {
    name: `opencode-${$app.stage}-inference-event-ingest`,
    destination: "iceberg",
    icebergConfiguration: {
      appendOnly: true,
      bufferingInterval: 60,
      bufferingSize: 1,
      catalogArn: glueS3TablesChildCatalogArn,
      destinationTableConfigurations: [
        {
          databaseName: inferenceNamespace.namespace,
          tableName: inferenceEventTable.name,
          s3ErrorOutputPrefix: "event/",
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
  },
  { aliases: [{ name: "StatsLakeFirehose" }], dependsOn: [s3TablesCatalog, inferenceEventTable, firehosePolicy] },
)

export const inferenceEventLake = new sst.Linkable("InferenceEventLake", {
  properties: {
    region: region.region,
    catalog: $interpolate`${glueCatalogName}/${tableBucket.name}`,
    database: inferenceNamespace.namespace,
    table: inferenceEventTable.name,
    tableBucket: tableBucket.name,
    workgroup: athenaWorkgroup.name,
  },
})

const ingestSecret = new random.RandomPassword(
  "InferenceEventLakeIngestSecret",
  { length: 32 },
  { aliases: [{ name: "StatsLakeIngestSecret" }] },
)

const ingestConfig = new sst.Linkable("InferenceEventLakeIngestConfig", {
  properties: {
    streamName: firehose.name,
    secret: ingestSecret.result,
  },
})

const ingestFunction = new sst.aws.Function("InferenceEventLakeIngestFunction", {
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

export const inferenceEventLakeIngest = new sst.Linkable("InferenceEventLakeIngest", {
  properties: {
    url: ingestFunction.url,
    secret: ingestSecret.result,
  },
})

export const inferenceEventLakeQueryPermissions = [
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
]
