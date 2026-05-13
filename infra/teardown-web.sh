#!/usr/bin/env bash
# Tear down the web deployment (CloudFront + ALB + ECS + IAM + ECR images).

set -euo pipefail

REGION="${AWS_REGION:-us-west-2}"
PROJECT_NAME="${PROJECT_NAME:-teams-bedrock-chatbot}"
STACK_NAME="${STACK_NAME:-${PROJECT_NAME}-web}"
ECR_REPO="${PROJECT_NAME}"

echo "About to delete (region=$REGION):"
echo "  - CloudFormation stack: $STACK_NAME (CloudFront + ALB + ECS + IAM + LogGroup)"
echo "  - ECR repository:        $ECR_REPO (and all images)"
read -rp "Type 'delete' to confirm: " confirm
[[ "$confirm" == "delete" ]] || { echo "Aborted."; exit 1; }

if aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "▶ Deleting CloudFormation stack..."
  aws cloudformation delete-stack --stack-name "$STACK_NAME" --region "$REGION"
  echo "  ⏳ Waiting for stack delete (CloudFront 삭제에 10~15분 걸림)..."
  aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" --region "$REGION"
  echo "  ✓ stack deleted"
fi

if aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$REGION" >/dev/null 2>&1; then
  echo "▶ Deleting ECR repo (with all images)..."
  aws ecr delete-repository --repository-name "$ECR_REPO" --region "$REGION" --force >/dev/null
  echo "  ✓ ECR repo deleted"
fi

echo
echo "✅ Web teardown complete."
echo "   (KB / OSS / S3 는 별도 — ingestion/aws/teardown-kb.sh 로 정리)"
