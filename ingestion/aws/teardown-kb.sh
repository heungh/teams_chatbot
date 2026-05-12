#!/usr/bin/env bash
#
# Tear down everything created by setup-kb.sh.
# Order matters — children before parents.

set -euo pipefail

REGION="${AWS_REGION:-us-west-2}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGION_SHORT="${REGION//-/}"

BUCKET="${KB_BUCKET:-teams-bedrock-kb-${ACCOUNT_ID}-${REGION_SHORT}}"
ROLE_NAME="${KB_ROLE:-teams-bedrock-kb-role}"
ENCRYPTION_POLICY="${KB_ENCRYPTION_POLICY:-teams-chats-enc}"
NETWORK_POLICY="${KB_NETWORK_POLICY:-teams-chats-net}"
DATA_ACCESS_POLICY="${KB_DATA_ACCESS_POLICY:-teams-chats-data}"
COLLECTION_NAME="${KB_COLLECTION:-teams-chats-coll}"
KB_NAME="${KB_NAME:-teams-chats-kb}"
PARAM_PREFIX="${PARAM_PREFIX:-/teams-bedrock-chatbot}"

echo "About to delete (region=$REGION):"
echo "  - SSM:       ${PARAM_PREFIX}/* parameters"
echo "  - KB:        $KB_NAME"
echo "  - OSS:       $COLLECTION_NAME + 3 policies"
echo "  - IAM:       $ROLE_NAME"
echo "  - S3:        $BUCKET (and all contents)"
read -rp "Type 'delete' to confirm: " confirm
[[ "$confirm" == "delete" ]] || { echo "Aborted."; exit 1; }

# SSM parameters
echo "▶ Deleting SSM parameters..."
for SUFFIX in kb-id data-source-id collection-id bucket region model-id; do
  NAME="${PARAM_PREFIX}/${SUFFIX}"
  if aws ssm delete-parameter --name "$NAME" --region "$REGION" 2>/dev/null; then
    echo "  ✓ $NAME"
  fi
done

# Knowledge Base + Data Sources
KB_ID=$(aws bedrock-agent list-knowledge-bases --region "$REGION" \
  --query "knowledgeBaseSummaries[?name=='${KB_NAME}'].knowledgeBaseId | [0]" \
  --output text 2>/dev/null || echo "None")
if [[ "$KB_ID" != "None" && -n "$KB_ID" ]]; then
  echo "▶ Deleting data sources..."
  for DS_ID in $(aws bedrock-agent list-data-sources --knowledge-base-id "$KB_ID" --region "$REGION" \
                  --query 'dataSourceSummaries[].dataSourceId' --output text); do
    aws bedrock-agent delete-data-source --knowledge-base-id "$KB_ID" --data-source-id "$DS_ID" --region "$REGION" >/dev/null
    echo "  ✓ data source $DS_ID"
  done
  echo "▶ Deleting Knowledge Base..."
  aws bedrock-agent delete-knowledge-base --knowledge-base-id "$KB_ID" --region "$REGION" >/dev/null
  echo "  ✓ KB $KB_ID"
fi

# OSS collection + policies
COLLECTION_ID=$(aws opensearchserverless list-collections --region "$REGION" \
  --query "collectionSummaries[?name=='${COLLECTION_NAME}'].id | [0]" \
  --output text 2>/dev/null || echo "None")
if [[ "$COLLECTION_ID" != "None" && -n "$COLLECTION_ID" ]]; then
  echo "▶ Deleting OSS collection..."
  aws opensearchserverless delete-collection --id "$COLLECTION_ID" --region "$REGION" >/dev/null
  echo "  ✓ collection $COLLECTION_ID"
fi

for P in "$DATA_ACCESS_POLICY:data" "$NETWORK_POLICY:network" "$ENCRYPTION_POLICY:encryption"; do
  NAME="${P%%:*}"
  TYPE="${P##*:}"
  if [[ "$TYPE" == "data" ]]; then
    aws opensearchserverless delete-access-policy --name "$NAME" --type "$TYPE" --region "$REGION" >/dev/null 2>&1 \
      && echo "  ✓ access policy $NAME" || true
  else
    aws opensearchserverless delete-security-policy --name "$NAME" --type "$TYPE" --region "$REGION" >/dev/null 2>&1 \
      && echo "  ✓ $TYPE policy $NAME" || true
  fi
done

# IAM role
if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "▶ Deleting IAM role..."
  for P in $(aws iam list-role-policies --role-name "$ROLE_NAME" --query 'PolicyNames[]' --output text); do
    aws iam delete-role-policy --role-name "$ROLE_NAME" --policy-name "$P"
  done
  aws iam delete-role --role-name "$ROLE_NAME"
  echo "  ✓ role $ROLE_NAME"
fi

# S3 bucket
if aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" 2>/dev/null; then
  echo "▶ Emptying + deleting S3 bucket..."
  aws s3 rm "s3://${BUCKET}" --recursive --region "$REGION" --only-show-errors
  aws s3api delete-bucket --bucket "$BUCKET" --region "$REGION"
  echo "  ✓ bucket $BUCKET"
fi

echo
echo "✅ Teardown complete."
