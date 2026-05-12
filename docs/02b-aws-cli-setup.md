# Step 3 (대안) — AWS CLI로 S3 + Bedrock Knowledge Base 셋업

> 콘솔 클릭 대신 CLI로 처리하고 싶을 때. `ingestion/aws/setup-kb.sh` 가 7단계를
> 자동 실행하고, 막히는 부분이 있으면 본 문서의 step-by-step 절을 참고.

콘솔 가이드와 동일한 자원이 만들어집니다 — S3 버킷, IAM 역할, OSS 컬렉션(보안 정책 3개 포함),
벡터 인덱스, Knowledge Base, Data Source, 인덱싱 잡 완료까지.

---

## ⚠️ 비용 안내

- **OpenSearch Serverless** 컬렉션이 ACTIVE 되는 순간 시간당 과금 시작 (~$345/월 최소)
- PoC 끝나면 반드시 `teardown-kb.sh` 실행해 정리

---

## 사전 준비

```bash
aws --version            # AWS CLI v2 권장
aws sts get-caller-identity   # 인증 + 리전 확인
node --version           # >= 20 (OSS 인덱스 헬퍼용)
```

리전을 `us-west-2` 외로 쓰려면 환경변수로 오버라이드:

```bash
export AWS_REGION=ap-northeast-2   # 또는 us-east-1, us-west-2 등
```

Bedrock 모델 액세스(Titan Embed v2, Claude Sonnet) 활성화는 미리 콘솔에서 확인.

---

## 가장 빠른 길 — 한 줄 실행

```bash
cd /Users/heungh/Documents/SA/05.Project/66.Teams_bedrock/ingestion
./aws/setup-kb.sh
```

스크립트가 시작 시 설정값을 출력하고 `yes` 입력 확인을 받습니다. 약 **5~10분** 소요.
끝나면 KB ID와 테스트 명령을 출력해 줍니다.

---

## 안에서 무슨 일이 벌어지는가 (CLI 단계별)

스크립트가 막힐 때 디버깅용으로 참고. 모든 명령은 `us-west-2` 기준.

### 변수 셋업

```bash
export REGION=us-west-2
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export BUCKET="teams-bedrock-kb-${ACCOUNT_ID}-usw2"
export ROLE_NAME="teams-bedrock-kb-role"
export ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
export COLLECTION_NAME="teams-chats-coll"
export INDEX_NAME="teams-chats-vector"
export KB_NAME="teams-chats-kb"
export DS_NAME="teams-chats-source"
export EMBEDDING_MODEL_ARN="arn:aws:bedrock:${REGION}::foundation-model/amazon.titan-embed-text-v2:0"
```

### 1. S3 버킷 + 업로드

```bash
aws s3api create-bucket \
  --bucket "$BUCKET" --region "$REGION" \
  --create-bucket-configuration "LocationConstraint=$REGION"

aws s3 sync processed/ "s3://${BUCKET}/teams-chats/" --region "$REGION"
```

### 2. IAM 역할 (Bedrock가 가정할 신뢰관계 + 권한)

`trust.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "bedrock.amazonaws.com"},
    "Action": "sts:AssumeRole",
    "Condition": {
      "StringEquals": {"aws:SourceAccount": "ACCOUNT_ID"},
      "ArnLike": {"aws:SourceArn": "arn:aws:bedrock:REGION:ACCOUNT_ID:knowledge-base/*"}
    }
  }]
}
```

`role-policy.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect":"Allow","Action":["bedrock:InvokeModel"],
     "Resource":["arn:aws:bedrock:REGION::foundation-model/amazon.titan-embed-text-v2:0"]},
    {"Effect":"Allow","Action":["s3:GetObject","s3:ListBucket"],
     "Resource":["arn:aws:s3:::BUCKET","arn:aws:s3:::BUCKET/*"]},
    {"Effect":"Allow","Action":["aoss:APIAccessAll"],
     "Resource":["arn:aws:aoss:REGION:ACCOUNT_ID:collection/*"]}
  ]
}
```

```bash
aws iam create-role --role-name "$ROLE_NAME" \
  --assume-role-policy-document file://trust.json
aws iam put-role-policy --role-name "$ROLE_NAME" \
  --policy-name "${ROLE_NAME}-inline" \
  --policy-document file://role-policy.json
```

### 3. OpenSearch Serverless 보안 정책 3종

콘솔에선 KB 마법사가 자동으로 만들지만, CLI에선 다음 3개를 KB **이전에** 만들어야 합니다.

- **Encryption policy** (AWS 관리 키 사용 — 가장 간단)
- **Network policy** (Public access — 데모용. 보안 강화는 VPC 옵션)
- **Data access policy** (KB 역할 + 인덱스를 만들 본인 ARN 둘 다 포함)

```bash
# Encryption
aws opensearchserverless create-security-policy --name teams-chats-enc \
  --type encryption --region "$REGION" --policy '{
    "Rules":[{"ResourceType":"collection","Resource":["collection/'$COLLECTION_NAME'"]}],
    "AWSOwnedKey":true
  }'

# Network
aws opensearchserverless create-security-policy --name teams-chats-net \
  --type network --region "$REGION" --policy '[{
    "Rules":[
      {"ResourceType":"collection","Resource":["collection/'$COLLECTION_NAME'"]},
      {"ResourceType":"dashboard","Resource":["collection/'$COLLECTION_NAME'"]}
    ],
    "AllowFromPublic":true
  }]'

# Data access (KB role + you)
CALLER_ARN=$(aws sts get-caller-identity --query Arn --output text)
aws opensearchserverless create-access-policy --name teams-chats-data \
  --type data --region "$REGION" --policy '[{
    "Rules":[
      {"ResourceType":"index","Resource":["index/'$COLLECTION_NAME'/*"],
       "Permission":["aoss:CreateIndex","aoss:UpdateIndex","aoss:DescribeIndex","aoss:ReadDocument","aoss:WriteDocument"]},
      {"ResourceType":"collection","Resource":["collection/'$COLLECTION_NAME'"],
       "Permission":["aoss:DescribeCollectionItems","aoss:UpdateCollectionItems"]}
    ],
    "Principal":["'$ROLE_ARN'","'$CALLER_ARN'"]
  }]'
```

### 4. OSS 컬렉션

```bash
aws opensearchserverless create-collection \
  --name "$COLLECTION_NAME" --type VECTORSEARCH \
  --region "$REGION"

# ACTIVE 될 때까지 대기 (~3분)
aws opensearchserverless batch-get-collection \
  --names "$COLLECTION_NAME" --region "$REGION" \
  --query 'collectionDetails[0].status'
```

### 5. 벡터 인덱스 생성 ★ 여기가 AWS CLI 단독 불가 ★

OSS의 데이터 플레인 (인덱스 CRUD)은 OpenSearch HTTP API이며 SigV4(`aoss` 서비스) 서명이 필요합니다. `aws` CLI에는 해당 명령이 없어 작은 TS 헬퍼로 호출:

```bash
export OSS_ENDPOINT=$(aws opensearchserverless batch-get-collection \
  --names "$COLLECTION_NAME" --region "$REGION" \
  --query 'collectionDetails[0].collectionEndpoint' --output text)

# 데이터 정책 전파 대기
sleep 30

npm run aws:create-index
```

만드는 인덱스의 필드:

| 필드 | 타입 | 용도 |
|---|---|---|
| `bedrock-knowledge-base-default-vector` | knn_vector(1024, hnsw/faiss) | 임베딩 |
| `AMAZON_BEDROCK_TEXT_CHUNK` | text | 원본 청크 본문 |
| `AMAZON_BEDROCK_METADATA` | text (no index) | 메타데이터 JSON |

(필드명은 Bedrock KB 기본 매핑과 일치시켜 둠 → KB 생성 시 fieldMapping에 그대로 매칭)

### 6. Knowledge Base + Data Source

```bash
COLLECTION_ARN=$(aws opensearchserverless batch-get-collection \
  --names "$COLLECTION_NAME" --region "$REGION" \
  --query 'collectionDetails[0].arn' --output text)

KB_ID=$(aws bedrock-agent create-knowledge-base --region "$REGION" \
  --name "$KB_NAME" \
  --role-arn "$ROLE_ARN" \
  --knowledge-base-configuration '{
    "type":"VECTOR",
    "vectorKnowledgeBaseConfiguration":{
      "embeddingModelArn":"'$EMBEDDING_MODEL_ARN'"
    }
  }' \
  --storage-configuration '{
    "type":"OPENSEARCH_SERVERLESS",
    "opensearchServerlessConfiguration":{
      "collectionArn":"'$COLLECTION_ARN'",
      "vectorIndexName":"'$INDEX_NAME'",
      "fieldMapping":{
        "vectorField":"bedrock-knowledge-base-default-vector",
        "textField":"AMAZON_BEDROCK_TEXT_CHUNK",
        "metadataField":"AMAZON_BEDROCK_METADATA"
      }
    }
  }' \
  --query 'knowledgeBase.knowledgeBaseId' --output text)

DS_ID=$(aws bedrock-agent create-data-source --region "$REGION" \
  --knowledge-base-id "$KB_ID" \
  --name "$DS_NAME" \
  --data-source-configuration '{
    "type":"S3",
    "s3Configuration":{
      "bucketArn":"arn:aws:s3:::'$BUCKET'",
      "inclusionPrefixes":["teams-chats/"]
    }
  }' \
  --vector-ingestion-configuration '{
    "chunkingConfiguration":{"chunkingStrategy":"NONE"}
  }' \
  --query 'dataSource.dataSourceId' --output text)
```

> 핵심: `chunkingStrategy: NONE` — `transform.ts` 가 이미 스레드 단위로 잘랐기 때문에 KB가 또 자르지 않게.

### 7. Ingestion 시작 + 폴링

```bash
JOB_ID=$(aws bedrock-agent start-ingestion-job --region "$REGION" \
  --knowledge-base-id "$KB_ID" \
  --data-source-id "$DS_ID" \
  --query 'ingestionJob.ingestionJobId' --output text)

# 폴링
while true; do
  STATUS=$(aws bedrock-agent get-ingestion-job --region "$REGION" \
    --knowledge-base-id "$KB_ID" --data-source-id "$DS_ID" \
    --ingestion-job-id "$JOB_ID" \
    --query 'ingestionJob.status' --output text)
  echo "status=$STATUS"
  [[ "$STATUS" == "COMPLETE" || "$STATUS" == "FAILED" ]] && break
  sleep 10
done
```

---

## 검증 — CLI로 RAG 호출 한 번

KB가 동작하는지 콘솔 Test 패널 없이 바로 CLI에서 확인:

```bash
aws bedrock-agent-runtime retrieve-and-generate \
  --region "$REGION" \
  --input '{"text":"Phoenix 프로젝트 DB는 뭘 쓰기로 했어?"}' \
  --retrieve-and-generate-configuration '{
    "type":"KNOWLEDGE_BASE",
    "knowledgeBaseConfiguration":{
      "knowledgeBaseId":"'$KB_ID'",
      "modelArn":"arn:aws:bedrock:'$REGION'::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0"
    }
  }'
```

→ output.text 에 "PostgreSQL (Aurora 호환)" 같은 답변이, citations[] 에 source chunks 가 보이면 KB 정상.

샘플 질의 (다 한 번씩 돌려보면 좋음):

| 질문 | 기대 답변 |
|---|---|
| Phoenix 프로젝트 DB는 뭘 쓰기로 했어? | PostgreSQL (Aurora) |
| Phoenix 릴리즈 일정 | 코드 프리즈 6/5, 베타 6/15, GA 7/1 |
| 고객사 A 비용 절감 방법 | 프롬프트 캐싱 + Haiku 라우팅, 65% 절감 |
| SAA 자격증 준비 기간 | 백엔드 경험 시 8주 |
| Bedrock 워크숍 일정과 내용 | 6월 셋째 주, Bedrock 기초/KB/챗봇 데모 3시간 |

---

## 정리 (Cleanup)

```bash
./aws/teardown-kb.sh
```

OSS 컬렉션 → IAM 역할 → S3 버킷 순으로 삭제. 확인 메시지에 `delete` 입력해야 진행.

---

## 결과 메모 (Step 4 에서 사용)

setup 끝나면 다음 값들 메모:

```
AWS_REGION=us-west-2
KB_ID=<setup-kb.sh 출력에서 복사>
MODEL_ID=anthropic.claude-3-5-sonnet-20241022-v2:0
```

Step 4 의 Next.js 앱 `.env.local` 에 들어갈 값입니다.
