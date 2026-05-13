#!/usr/bin/env bash
#
# Deploy Next.js chatbot to ECS Fargate behind ALB + CloudFront.
#
# 단계:
#   1. ECR repo 생성 (없으면)
#   2. Docker image 빌드 (linux/arm64)
#   3. ECR push
#   4. 기본 VPC + 서브넷 자동 조회
#   5. CloudFormation stack deploy
#   6. CloudFront URL 출력
#
# 멱등성: 모든 단계 재실행 안전. 이미지 태그 변경 시 ECS service 가 새 task 로 롤링 업데이트.

set -euo pipefail

# ------------------------------ Config ----------------------------------------
REGION="${AWS_REGION:-us-west-2}"
PROJECT_NAME="${PROJECT_NAME:-teams-bedrock-chatbot}"
ECR_REPO="${PROJECT_NAME}"
IMAGE_TAG="${IMAGE_TAG:-$(date +%Y%m%d-%H%M%S)}"
STACK_NAME="${STACK_NAME:-${PROJECT_NAME}-web}"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO}"
IMAGE_URI="${ECR_URI}:${IMAGE_TAG}"

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "${INFRA_DIR}/../web" && pwd)"

echo
echo "================ Deployment plan ================"
echo "Region:        $REGION"
echo "Account:       $ACCOUNT_ID"
echo "ECR repo:      $ECR_REPO"
echo "Image tag:     $IMAGE_TAG"
echo "Stack name:    $STACK_NAME"
echo "Web dir:       $WEB_DIR"
echo "================================================="
echo
read -rp "Proceed? Type 'yes': " confirm
[[ "$confirm" == "yes" ]] || { echo "Aborted."; exit 1; }

# ---------------------- 1. ECR repository -------------------------------------
echo
echo "▶ [1/5] ECR repository"
if aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$REGION" >/dev/null 2>&1; then
  echo "  ℹ️  Repo $ECR_REPO already exists"
else
  aws ecr create-repository \
    --repository-name "$ECR_REPO" \
    --region "$REGION" \
    --image-scanning-configuration scanOnPush=true >/dev/null
  echo "  ✅ Repo created"
fi

# ---------------------- 2. Docker build + 3. push -----------------------------
echo
echo "▶ [2/5] Docker build (linux/arm64)"
cd "$WEB_DIR"

# Ensure buildx is set up for cross-architecture
docker buildx inspect "${PROJECT_NAME}-builder" >/dev/null 2>&1 \
  || docker buildx create --name "${PROJECT_NAME}-builder" --use >/dev/null

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com" >/dev/null

echo "  building + pushing $IMAGE_URI ..."
docker buildx build \
  --platform linux/arm64 \
  --tag "$IMAGE_URI" \
  --tag "${ECR_URI}:latest" \
  --push \
  .
echo "  ✅ pushed $IMAGE_URI"

# ---------------------- 4. VPC / subnets --------------------------------------
echo
echo "▶ [4/5] Default VPC + subnets"
VPC_ID="$(aws ec2 describe-vpcs \
  --filters Name=is-default,Values=true \
  --query 'Vpcs[0].VpcId' --output text --region "$REGION")"
if [[ "$VPC_ID" == "None" || -z "$VPC_ID" ]]; then
  echo "  ❌ No default VPC found in $REGION. Create one or set VPC_ID/SUBNET_IDS env vars."
  exit 1
fi
SUBNET_IDS="$(aws ec2 describe-subnets \
  --filters "Name=vpc-id,Values=$VPC_ID" Name=default-for-az,Values=true \
  --query 'Subnets[].SubnetId' --output text --region "$REGION" | tr '\t' ',' )"
echo "  VPC:     $VPC_ID"
echo "  Subnets: $SUBNET_IDS"

# ---------------------- 5. CloudFormation deploy ------------------------------
echo
echo "▶ [5/5] CloudFormation deploy"

aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --template-file "${INFRA_DIR}/web-stack.yaml" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
      ProjectName="$PROJECT_NAME" \
      ImageUri="$IMAGE_URI" \
      VpcId="$VPC_ID" \
      SubnetIds="$SUBNET_IDS"

echo
echo "  ⏳ Forcing ECS service to use new image..."
CLUSTER=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`ClusterName`].OutputValue' --output text)
SERVICE=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`ServiceName`].OutputValue' --output text)
aws ecs update-service \
  --cluster "$CLUSTER" --service "$SERVICE" --force-new-deployment \
  --region "$REGION" >/dev/null
echo "  ✓ rolling update started"

echo "  ⏳ Waiting for service to stabilize (~3-5min)..."
aws ecs wait services-stable \
  --cluster "$CLUSTER" --services "$SERVICE" \
  --region "$REGION"
echo "  ✅ service stable"

# ---------------------- Outputs -----------------------------------------------
echo
echo "================ Deployment complete ================"
aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontDomain` || OutputKey==`AlbDnsName` || OutputKey==`LogGroupName`].[OutputKey,OutputValue]' \
  --output table

CF_DOMAIN=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontDomain`].OutputValue' --output text)
echo
echo "🌐 Chatbot URL: $CF_DOMAIN"
echo "💬 Teams webhook URL: ${CF_DOMAIN}/api/teams/webhook"
echo
echo "Note: CloudFront 첫 배포 후 propagation 에 5~10분 추가 소요."
echo "      먼저 직접 ALB DNS 로 검증 가능 (HTTP 만):"
ALB=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`AlbDnsName`].OutputValue' --output text)
echo "  curl http://${ALB}/api/health"
