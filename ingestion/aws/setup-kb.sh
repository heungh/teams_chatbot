#!/usr/bin/env bash
#
# End-to-end Bedrock Knowledge Base setup via AWS CLI.
#
# Creates: S3 bucket + uploads processed/, IAM role, OSS policies + collection,
#          OSS vector index, KB, data source, then kicks off ingestion.
#
# Idempotent where reasonable (skips resources that already exist).
# Run from ingestion/ directory.

set -euo pipefail

# ------------------------------ Config ----------------------------------------
REGION="${AWS_REGION:-us-west-2}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGION_SHORT="${REGION//-/}"

BUCKET="${KB_BUCKET:-teams-bedrock-kb-${ACCOUNT_ID}-${REGION_SHORT}}"
S3_PREFIX="teams-chats"

ROLE_NAME="${KB_ROLE:-teams-bedrock-kb-role}"
ENCRYPTION_POLICY="${KB_ENCRYPTION_POLICY:-teams-chats-enc}"
NETWORK_POLICY="${KB_NETWORK_POLICY:-teams-chats-net}"
DATA_ACCESS_POLICY="${KB_DATA_ACCESS_POLICY:-teams-chats-data}"
COLLECTION_NAME="${KB_COLLECTION:-teams-chats-coll}"
INDEX_NAME="${KB_INDEX:-teams-chats-vector}"
KB_NAME="${KB_NAME:-teams-chats-kb}"
DS_NAME="${KB_DATA_SOURCE:-teams-chats-source}"

PARAM_PREFIX="${PARAM_PREFIX:-/teams-bedrock-chatbot}"
GENERATION_MODEL_ID="${GENERATION_MODEL_ID:-us.anthropic.claude-sonnet-4-6}"

EMBEDDING_MODEL_ARN="arn:aws:bedrock:${REGION}::foundation-model/amazon.titan-embed-text-v2:0"

INGESTION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROCESSED_DIR="${INGESTION_DIR}/processed"

CALLER_ARN="$(aws sts get-caller-identity --query Arn --output text)"

echo
echo "================ Configuration ================"
echo "Region:           $REGION"
echo "Account:          $ACCOUNT_ID"
echo "S3 bucket:        $BUCKET"
echo "  prefix:         $S3_PREFIX"
echo "IAM role:         $ROLE_NAME"
echo "OSS collection:   $COLLECTION_NAME"
echo "OSS index:        $INDEX_NAME"
echo "Knowledge Base:   $KB_NAME"
echo "Data source:      $DS_NAME"
echo "Caller (you):     $CALLER_ARN"
echo "==============================================="
echo
echo "⚠️  This will create paid AWS resources (OSS Serverless ~\$345/month minimum)."
read -rp "Proceed? Type 'yes' to confirm: " confirm
[[ "$confirm" == "yes" ]] || { echo "Aborted."; exit 1; }

# ---------------------- 1. S3 bucket + upload ---------------------------------
echo
echo "▶ [1/7] S3 bucket"

if aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" 2>/dev/null; then
  echo "  ℹ️  Bucket $BUCKET already exists. Skipping create."
else
  if [[ "$REGION" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"
  else
    aws s3api create-bucket \
      --bucket "$BUCKET" \
      --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION"
  fi
  echo "  ✅ Bucket created: $BUCKET"
fi

echo "  uploading processed/ ..."
aws s3 sync "$PROCESSED_DIR" "s3://${BUCKET}/${S3_PREFIX}/" --region "$REGION" --only-show-errors
COUNT=$(aws s3 ls "s3://${BUCKET}/${S3_PREFIX}/" --region "$REGION" | wc -l | tr -d ' ')
echo "  ✅ Uploaded. Bucket now has $COUNT files under $S3_PREFIX/"

# ---------------------- 2. IAM role for KB ------------------------------------
echo
echo "▶ [2/7] IAM role"

TRUST_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "bedrock.amazonaws.com"},
    "Action": "sts:AssumeRole",
    "Condition": {
      "StringEquals": {"aws:SourceAccount": "$ACCOUNT_ID"},
      "ArnLike": {"aws:SourceArn": "arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:knowledge-base/*"}
    }
  }]
}
EOF
)

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "  ℹ️  Role $ROLE_NAME already exists. Skipping create."
else
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$TRUST_POLICY" \
    --description "Bedrock Knowledge Base service role for Teams chat KB" >/dev/null
  echo "  ✅ Role created"
fi

ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

INLINE_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel"],
      "Resource": ["${EMBEDDING_MODEL_ARN}"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::${BUCKET}",
        "arn:aws:s3:::${BUCKET}/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["aoss:APIAccessAll"],
      "Resource": ["arn:aws:aoss:${REGION}:${ACCOUNT_ID}:collection/*"]
    }
  ]
}
EOF
)

aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "${ROLE_NAME}-inline" \
  --policy-document "$INLINE_POLICY"
echo "  ✅ Inline policy attached"

# ---------------------- 3. OSS policies ---------------------------------------
echo
echo "▶ [3/7] OpenSearch Serverless security policies"

# Encryption policy
ENC_POLICY=$(cat <<EOF
{
  "Rules": [{"ResourceType": "collection", "Resource": ["collection/${COLLECTION_NAME}"]}],
  "AWSOwnedKey": true
}
EOF
)
if aws opensearchserverless get-security-policy --name "$ENCRYPTION_POLICY" --type encryption --region "$REGION" >/dev/null 2>&1; then
  echo "  ℹ️  Encryption policy $ENCRYPTION_POLICY already exists"
else
  aws opensearchserverless create-security-policy \
    --name "$ENCRYPTION_POLICY" --type encryption \
    --policy "$ENC_POLICY" --region "$REGION" >/dev/null
  echo "  ✅ Encryption policy created"
fi

# Network policy (public access for simplicity — restrict later if needed)
NET_POLICY=$(cat <<EOF
[{
  "Rules": [
    {"ResourceType": "collection", "Resource": ["collection/${COLLECTION_NAME}"]},
    {"ResourceType": "dashboard",  "Resource": ["collection/${COLLECTION_NAME}"]}
  ],
  "AllowFromPublic": true
}]
EOF
)
if aws opensearchserverless get-security-policy --name "$NETWORK_POLICY" --type network --region "$REGION" >/dev/null 2>&1; then
  echo "  ℹ️  Network policy $NETWORK_POLICY already exists"
else
  aws opensearchserverless create-security-policy \
    --name "$NETWORK_POLICY" --type network \
    --policy "$NET_POLICY" --region "$REGION" >/dev/null
  echo "  ✅ Network policy created"
fi

# Data access policy: allow KB role + current caller (so this script can create the index)
DATA_POLICY=$(cat <<EOF
[{
  "Rules": [
    {
      "ResourceType": "index",
      "Resource": ["index/${COLLECTION_NAME}/*"],
      "Permission": [
        "aoss:CreateIndex","aoss:UpdateIndex","aoss:DeleteIndex","aoss:DescribeIndex",
        "aoss:ReadDocument","aoss:WriteDocument"
      ]
    },
    {
      "ResourceType": "collection",
      "Resource": ["collection/${COLLECTION_NAME}"],
      "Permission": [
        "aoss:CreateCollectionItems","aoss:DescribeCollectionItems",
        "aoss:UpdateCollectionItems","aoss:DeleteCollectionItems"
      ]
    }
  ],
  "Principal": ["${ROLE_ARN}", "${CALLER_ARN}"]
}]
EOF
)
if aws opensearchserverless get-access-policy --name "$DATA_ACCESS_POLICY" --type data --region "$REGION" >/dev/null 2>&1; then
  echo "  ℹ️  Data access policy $DATA_ACCESS_POLICY already exists — updating principals"
  POLICY_VERSION=$(aws opensearchserverless get-access-policy --name "$DATA_ACCESS_POLICY" --type data --region "$REGION" --query 'accessPolicyDetail.policyVersion' --output text)
  aws opensearchserverless update-access-policy \
    --name "$DATA_ACCESS_POLICY" --type data \
    --policy-version "$POLICY_VERSION" \
    --policy "$DATA_POLICY" --region "$REGION" >/dev/null
else
  aws opensearchserverless create-access-policy \
    --name "$DATA_ACCESS_POLICY" --type data \
    --policy "$DATA_POLICY" --region "$REGION" >/dev/null
  echo "  ✅ Data access policy created"
fi

# ---------------------- 4. OSS collection -------------------------------------
echo
echo "▶ [4/7] OpenSearch Serverless collection"

EXISTING_COLLECTION=$(aws opensearchserverless list-collections \
  --region "$REGION" \
  --query "collectionSummaries[?name=='${COLLECTION_NAME}'].id | [0]" \
  --output text 2>/dev/null || echo "")

if [[ "$EXISTING_COLLECTION" != "None" && -n "$EXISTING_COLLECTION" ]]; then
  echo "  ℹ️  Collection $COLLECTION_NAME already exists (id=$EXISTING_COLLECTION)"
  COLLECTION_ID="$EXISTING_COLLECTION"
else
  COLLECTION_ID=$(aws opensearchserverless create-collection \
    --name "$COLLECTION_NAME" \
    --type VECTORSEARCH \
    --description "Vector store for Teams chat KB" \
    --region "$REGION" \
    --query 'createCollectionDetail.id' --output text)
  echo "  ✅ Collection creation initiated (id=$COLLECTION_ID)"
fi

echo "  ⏳ Waiting for collection to become ACTIVE..."
for i in {1..30}; do
  STATUS=$(aws opensearchserverless batch-get-collection \
    --ids "$COLLECTION_ID" --region "$REGION" \
    --query 'collectionDetails[0].status' --output text)
  if [[ "$STATUS" == "ACTIVE" ]]; then
    echo "  ✅ Collection ACTIVE"
    break
  fi
  printf "."
  sleep 10
done
[[ "$STATUS" == "ACTIVE" ]] || { echo "❌ Collection not ACTIVE after 5 minutes (status=$STATUS)"; exit 1; }

COLLECTION_ARN=$(aws opensearchserverless batch-get-collection \
  --ids "$COLLECTION_ID" --region "$REGION" \
  --query 'collectionDetails[0].arn' --output text)
COLLECTION_ENDPOINT=$(aws opensearchserverless batch-get-collection \
  --ids "$COLLECTION_ID" --region "$REGION" \
  --query 'collectionDetails[0].collectionEndpoint' --output text)
echo "  endpoint: $COLLECTION_ENDPOINT"

# ---------------------- 5. OSS vector index -----------------------------------
echo
echo "▶ [5/7] Vector index in OSS collection"

# Small wait — data access policy needs ~30s to propagate after collection ACTIVE
echo "  ⏳ Waiting 30s for data access policy propagation..."
sleep 30

AWS_REGION="$REGION" \
OSS_ENDPOINT="$COLLECTION_ENDPOINT" \
INDEX_NAME="$INDEX_NAME" \
npm run --silent aws:create-index

echo "  ⏳ Waiting 30s for index to become queryable..."
sleep 30

# ---------------------- 6. Knowledge Base + Data Source -----------------------
echo
echo "▶ [6/7] Bedrock Knowledge Base + data source"

KB_CONFIG=$(cat <<EOF
{
  "type": "VECTOR",
  "vectorKnowledgeBaseConfiguration": {
    "embeddingModelArn": "${EMBEDDING_MODEL_ARN}"
  }
}
EOF
)

STORAGE_CONFIG=$(cat <<EOF
{
  "type": "OPENSEARCH_SERVERLESS",
  "opensearchServerlessConfiguration": {
    "collectionArn": "${COLLECTION_ARN}",
    "vectorIndexName": "${INDEX_NAME}",
    "fieldMapping": {
      "vectorField": "bedrock-knowledge-base-default-vector",
      "textField": "AMAZON_BEDROCK_TEXT_CHUNK",
      "metadataField": "AMAZON_BEDROCK_METADATA"
    }
  }
}
EOF
)

EXISTING_KB=$(aws bedrock-agent list-knowledge-bases --region "$REGION" \
  --query "knowledgeBaseSummaries[?name=='${KB_NAME}'].knowledgeBaseId | [0]" \
  --output text 2>/dev/null || echo "")

if [[ "$EXISTING_KB" != "None" && -n "$EXISTING_KB" ]]; then
  echo "  ℹ️  KB $KB_NAME already exists (id=$EXISTING_KB)"
  KB_ID="$EXISTING_KB"
else
  KB_ID=$(aws bedrock-agent create-knowledge-base \
    --region "$REGION" \
    --name "$KB_NAME" \
    --role-arn "$ROLE_ARN" \
    --knowledge-base-configuration "$KB_CONFIG" \
    --storage-configuration "$STORAGE_CONFIG" \
    --query 'knowledgeBase.knowledgeBaseId' --output text)
  echo "  ✅ KB created (id=$KB_ID)"
fi

DS_CONFIG=$(cat <<EOF
{
  "type": "S3",
  "s3Configuration": {
    "bucketArn": "arn:aws:s3:::${BUCKET}",
    "inclusionPrefixes": ["${S3_PREFIX}/"]
  }
}
EOF
)

INGESTION_CONFIG=$(cat <<EOF
{
  "chunkingConfiguration": {
    "chunkingStrategy": "NONE"
  }
}
EOF
)

EXISTING_DS=$(aws bedrock-agent list-data-sources \
  --knowledge-base-id "$KB_ID" --region "$REGION" \
  --query "dataSourceSummaries[?name=='${DS_NAME}'].dataSourceId | [0]" \
  --output text 2>/dev/null || echo "")

if [[ "$EXISTING_DS" != "None" && -n "$EXISTING_DS" ]]; then
  echo "  ℹ️  Data source $DS_NAME already exists (id=$EXISTING_DS)"
  DS_ID="$EXISTING_DS"
else
  DS_ID=$(aws bedrock-agent create-data-source \
    --region "$REGION" \
    --knowledge-base-id "$KB_ID" \
    --name "$DS_NAME" \
    --data-source-configuration "$DS_CONFIG" \
    --vector-ingestion-configuration "$INGESTION_CONFIG" \
    --query 'dataSource.dataSourceId' --output text)
  echo "  ✅ Data source created (id=$DS_ID)"
fi

# ---------------------- 7. Ingestion sync -------------------------------------
echo
echo "▶ [7/7] Start ingestion job"

JOB_ID=$(aws bedrock-agent start-ingestion-job \
  --region "$REGION" \
  --knowledge-base-id "$KB_ID" \
  --data-source-id "$DS_ID" \
  --query 'ingestionJob.ingestionJobId' --output text)
echo "  ✅ Ingestion job started (id=$JOB_ID)"

echo "  ⏳ Polling ingestion status..."
for i in {1..60}; do
  STATUS=$(aws bedrock-agent get-ingestion-job \
    --region "$REGION" \
    --knowledge-base-id "$KB_ID" \
    --data-source-id "$DS_ID" \
    --ingestion-job-id "$JOB_ID" \
    --query 'ingestionJob.status' --output text)
  if [[ "$STATUS" == "COMPLETE" || "$STATUS" == "FAILED" ]]; then
    break
  fi
  printf "."
  sleep 10
done
echo

if [[ "$STATUS" == "COMPLETE" ]]; then
  STATS=$(aws bedrock-agent get-ingestion-job \
    --region "$REGION" \
    --knowledge-base-id "$KB_ID" \
    --data-source-id "$DS_ID" \
    --ingestion-job-id "$JOB_ID" \
    --query 'ingestionJob.statistics' --output json)
  echo "  ✅ Ingestion COMPLETE"
  echo "  stats: $STATS"
else
  echo "  ❌ Ingestion ended with status: $STATUS"
  echo "     Check details: aws bedrock-agent get-ingestion-job --knowledge-base-id $KB_ID --data-source-id $DS_ID --ingestion-job-id $JOB_ID --region $REGION"
  exit 1
fi

# ---------------------- 8. Publish config to SSM Parameter Store --------------
echo
echo "▶ [8/8] Publishing config to SSM Parameter Store"

write_param() {
  local name="$1"
  local value="$2"
  aws ssm put-parameter --region "$REGION" \
    --name "$name" --value "$value" \
    --type String --overwrite >/dev/null
  echo "  ✓ $name"
}

write_param "${PARAM_PREFIX}/kb-id" "$KB_ID"
write_param "${PARAM_PREFIX}/data-source-id" "$DS_ID"
write_param "${PARAM_PREFIX}/collection-id" "$COLLECTION_ID"
write_param "${PARAM_PREFIX}/bucket" "$BUCKET"
write_param "${PARAM_PREFIX}/region" "$REGION"
write_param "${PARAM_PREFIX}/model-id" "$GENERATION_MODEL_ID"

# ---------------------- Done --------------------------------------------------
echo
echo "================ Summary ================"
echo "KB_ID:            $KB_ID"
echo "DATA_SOURCE_ID:   $DS_ID"
echo "COLLECTION_ID:    $COLLECTION_ID"
echo "BUCKET:           $BUCKET"
echo "REGION:           $REGION"
echo "MODEL_ID:         $GENERATION_MODEL_ID"
echo
echo "Config published to SSM under ${PARAM_PREFIX}/"
echo "Next.js app will resolve these automatically; .env.local only needs AWS_REGION (optional)."
echo
echo "Quick test:"
echo "  aws bedrock-agent-runtime retrieve-and-generate \\"
echo "    --region $REGION \\"
echo "    --input text='Phoenix 프로젝트 DB는 뭘 쓰기로 했어?' \\"
echo "    --retrieve-and-generate-configuration '{"
echo "      \"type\": \"KNOWLEDGE_BASE\","
echo "      \"knowledgeBaseConfiguration\": {"
echo "        \"knowledgeBaseId\": \"$KB_ID\","
echo "        \"modelArn\": \"arn:aws:bedrock:$REGION::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0\""
echo "      }"
echo "    }'"
echo
echo "🧹 To tear down: ingestion/aws/teardown-kb.sh"
