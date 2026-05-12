# Step 3 — AWS 콘솔에서 S3 + Bedrock Knowledge Base 셋업

> 목표: `ingestion/processed/` 의 27쌍 파일을 S3에 올리고, Bedrock Knowledge Base를
> 만들어 동기화한 뒤 콘솔에서 질의가 동작하는지 검증한다.

---

## ⚠️ 시작 전에 — 비용 안내

Bedrock Knowledge Base 자체는 종량제이지만, **벡터 스토어는 항상 켜져 있어 시간당 과금**됩니다.

| 벡터 스토어 옵션 | 최소 비용 (대략) | 권장 |
|---|---|---|
| **OpenSearch Serverless** (Quick create) | **약 $345/월** (search 2 OCU + indexing 2 OCU 최소) | PoC 빠른 시작 |
| Aurora Serverless v2 + pgvector | 약 $45/월 (0.5 ACU 최소) | PoC 후 장기 운영 |
| Pinecone Free Tier | 무료 (제약 큼) | 별도 계정 필요 |

> 💡 PoC만 돌리시려면 **OSS Quick create 후 데모 끝나면 KB 삭제 → OSS 컬렉션도 삭제** 하시는 게 가장 깔끔합니다. 본 가이드는 OSS Quick create 기준입니다.

작업 끝나고 **꼭** 마지막 섹션 "정리(Cleanup)" 따라서 자원 삭제하세요.

---

## 사전 준비

- [ ] AWS 콘솔 로그인, 작업 리전 **us-west-2 (오레곤)** 로 전환
  - Seoul (ap-northeast-2) 도 KB·Claude 사용 가능하지만 us-west-2가 가장 빠르게 신모델 받음
- [ ] Bedrock 모델 액세스: **Titan Embeddings v2** + **Claude Sonnet** 활성화 확인
- [ ] 로컬 AWS CLI 설정 (S3 업로드용) — `aws sts get-caller-identity` 동작 확인

---

## A. Bedrock 모델 액세스 확인

이미 활성화돼 있다고 하셨지만, 다음 두 모델이 켜져 있는지 한 번 더 확인:

1. AWS 콘솔 검색창 → **"Bedrock"** → **Model access** 메뉴
2. 다음 두 모델 모두 **Access granted** 상태인지 확인:
   - **Titan Text Embeddings V2** (`amazon.titan-embed-text-v2:0`)
   - **Claude 3.5 Sonnet** 또는 **Claude 3.7 Sonnet** (가능한 가장 최신 Sonnet)
3. 없으면 **Modify model access** → 해당 모델 체크 → Next → Submit

---

## B. S3 버킷 생성 + 데이터 업로드

### B-1. 버킷 생성

1. 콘솔 검색 → **"S3"** → **Create bucket**
2. **Bucket name**: 전역 고유. 예: `teams-bedrock-kb-<aws-account-id>-usw2`
3. **AWS Region**: **US West (Oregon) us-west-2**
4. 나머지 기본값 (Block all public access 체크 유지, 버저닝/암호화 기본)
5. **Create bucket**

### B-2. processed/ 업로드

로컬 터미널에서 (`ingestion/` 디렉토리 기준):

```bash
cd /Users/heungh/Documents/SA/05.Project/66.Teams_bedrock/ingestion

# 본인 계정 ID 확인
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BUCKET="teams-bedrock-kb-${ACCOUNT_ID}-usw2"

# 업로드
aws s3 sync processed/ "s3://${BUCKET}/teams-chats/" --region us-west-2
```

`processed/` 안의 27쌍(.md + .md.metadata.json) 모두 `s3://.../teams-chats/` 아래에 올라갑니다.

확인:

```bash
aws s3 ls "s3://${BUCKET}/teams-chats/" --region us-west-2 | head
```

54개 파일이 보이면 OK.

---

## C. Knowledge Base 생성

### C-1. 마법사 시작

1. Bedrock 콘솔 → 좌측 **Knowledge Bases** → **Create knowledge base**
2. 옵션 중 **"Knowledge Base with vector store"** 선택

### C-2. Step 1 — Knowledge Base details

| 필드 | 입력 |
|---|---|
| Name | `teams-chats-kb` |
| Description | "Teams chat history for chatbot demo" |
| IAM permissions | **Create and use a new service role** (자동) |
| Data source type | **Amazon S3** |

→ **Next**

### C-3. Step 2 — Configure data source

| 필드 | 입력 |
|---|---|
| Data source name | `teams-chats-source` |
| S3 URI | `s3://teams-bedrock-kb-<account>-usw2/teams-chats/` (B에서 만든 경로) |
| **Chunking strategy** | **No chunking** ← 핵심 |

> 💡 **No chunking** 선택 이유: `transform.ts`가 이미 스레드 단위로 의미 있게 자른 상태입니다. KB가 또 자르면 스레드가 중간에 끊겨 검색 품질이 떨어집니다.

**Advanced settings (Optional)** 펼쳐서:
- **Parsing strategy**: Default parser (Markdown 처리 OK)
- **Metadata 처리**: 자동 — `.metadata.json` 사이드카가 같은 prefix 아래 있으면 KB가 자동 인식

→ **Next**

### C-4. Step 3 — Select embeddings model

| 필드 | 선택 |
|---|---|
| Embeddings model | **Titan Text Embeddings v2** |
| Dimensions | **1024** (기본) |
| Embedding type | Floating-point (기본) |

→ **Next**

### C-5. Step 4 — Configure vector store

**Quick create a new vector store** 선택 → **Amazon OpenSearch Serverless** 자동 선택됨.

> ⚠️ "Create vector store" 시점에 OpenSearch Serverless 컬렉션이 생성되고 **즉시 시간당 과금이 시작**됩니다 (search 2 OCU + indexing 2 OCU 최소).

→ **Next**

### C-6. Step 5 — Review and create

- 모든 설정 확인 → **Create knowledge base**
- 컬렉션 프로비저닝에 **3~5분** 소요 → 상태가 "Ready" 가 될 때까지 대기

---

## D. 데이터 소스 동기화 (Sync)

1. KB 생성이 완료되면 자동으로 KB 상세 페이지로 이동
2. **Data source** 섹션에서 `teams-chats-source` 클릭
3. 우측 상단 **Sync** 버튼 클릭
4. Sync 진행 상태 모니터링 (27개 파일이라 보통 **1~2분** 내 완료)
5. 상태가 **Ready** + Documents scanned: 27 가 나오면 OK

> ❌ Failed가 나오면: Data source의 sync history → 실패 사유 확인. 가장 흔한 원인:
> - IAM 역할이 S3 버킷 읽기 권한 없음 (KB 생성 시 자동 부여되어야 함)
> - `.md.metadata.json` 형식 오류 (sidecar JSON이 깨졌을 때)

---

## E. KB 자체 테스트 (Next.js 만들기 전 검증)

KB 상세 페이지 우측에 **"Test knowledge base"** 패널이 있습니다.

### E-1. 모델 선택

상단 **"Select model"** → **Anthropic Claude 3.5 Sonnet** (또는 최신 Sonnet)

### E-2. 샘플 쿼리

다음 질문들을 차례로 던져 보세요. 각각에 대해 KB가 retrieve한 source chunk와 함께 답해야 합니다.

| 질문 | 기대 답변 |
|---|---|
| Phoenix 프로젝트 DB는 뭘 쓰기로 했어? | PostgreSQL (Aurora 호환) |
| Phoenix 릴리즈 일정 알려줘 | 코드 프리즈 6/5, QA 마감 6/8, 베타 6/15, GA 7/1 |
| 고객사 A의 Bedrock 비용은 어떻게 줄였어? | 프롬프트 캐싱 + Haiku 라우팅으로 약 65% 절감 |
| SAA 자격증 준비 기간 추천은? | 백엔드 경험 시 8주, 주 10-12시간 |
| Bedrock 워크숍은 언제 어떤 내용으로 잡혀? | 6월 셋째 주, 3시간 (Bedrock 기초 / KB / 챗봇 데모) |

답변 아래에 **Sources** 가 보여야 하고, 클릭하면 해당 chunk의 본문과 메타데이터(원본 Teams URL) 가 나옵니다.

---

## F. Step 4 에서 쓸 값 메모

Next.js 앱에서 KB를 호출하려면 다음 값들이 필요합니다. KB 상세 페이지에서 복사:

- **Knowledge base ID**: 예) `ABCDEFGHIJ` (상단 KB 이름 옆 ID)
- **Region**: `us-west-2`
- **Generation model ID**: 예) `anthropic.claude-3-5-sonnet-20241022-v2:0`

`web/.env.local` 에 들어갈 예정이니 메모해 두세요. (저한테 보내실 필요 X — Next.js 코드 작성 후 본인이 직접 채우시면 됩니다)

---

## G. 정리 (Cleanup) — PoC 끝나면 반드시

OSS 컬렉션이 깜빡 켜진 채로 한 달 가면 약 $345 부과됩니다. 데모 끝나면 즉시:

1. Bedrock 콘솔 → Knowledge Bases → `teams-chats-kb` → **Delete**
2. **OpenSearch Serverless** 콘솔 → Collections → KB가 만든 컬렉션 → **Delete**
   (KB 삭제 시 자동 삭제되지 않으니 별도로 지워야 함)
3. **S3** → 버킷 → 비우기(Empty) → 삭제(Delete)
4. (선택) Bedrock 모델 액세스는 그대로 두어도 비용 없음

---

## 체크리스트

- [ ] S3 버킷 생성, `processed/` 업로드 (54개 파일)
- [ ] Knowledge Base 생성 완료, 상태 Ready
- [ ] Data source sync 완료, Documents scanned: 27
- [ ] Test 콘솔에서 위 샘플 쿼리 5개 모두 적절히 답변됨
- [ ] KB ID, Region, Model ID 메모해 둠

위 5개 모두 ✅ 되면 **Step 4 (Next.js 챗봇 구현)** 으로 진행 가능.
