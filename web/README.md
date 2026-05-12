# Teams × Bedrock KB 챗봇 (Next.js)

Bedrock Knowledge Base에서 RetrieveAndGenerate API를 호출해 답변과 인용을 보여주는 단일 페이지 챗봇.

## 빠른 시작

```bash
cd web/
cp .env.local.example .env.local
# 기본은 region 만 명시 — 나머지는 SSM Parameter Store에서 자동 로드

npm install   # 이미 설치돼 있으면 생략
npm run dev   # http://localhost:3000
```

## 설정 (Configuration)

런타임 설정은 **SSM Parameter Store** 에서 자동 로드합니다. `setup-kb.sh` 가 실행 시
다음 파라미터들을 `/teams-bedrock-chatbot/` 아래에 자동 publish 합니다:

| Parameter | 형식 예 | 용도 |
|---|---|---|
| `/teams-bedrock-chatbot/kb-id` | `XXXXXXXXXX` (10자) | Bedrock Knowledge Base ID |
| `/teams-bedrock-chatbot/model-id` | `us.anthropic.claude-sonnet-4-6` | 생성 모델 (inference profile ID) |
| `/teams-bedrock-chatbot/region` | `us-west-2` | (참조용) |
| `/teams-bedrock-chatbot/data-source-id` | `XXXXXXXXXX` | (참조용) |
| `/teams-bedrock-chatbot/collection-id` | `<oss-collection-id>` | (참조용) |
| `/teams-bedrock-chatbot/bucket` | `teams-bedrock-kb-<account>-<region>` | (참조용) |

본인 환경의 실제 값은 `aws ssm get-parameters-by-path --path /teams-bedrock-chatbot ...` 로 조회 가능.

### 우선순위

```
process.env.{KB_ID, MODEL_ID, AWS_ACCOUNT_ID}   # 환경변수가 있으면 우선 (로컬 테스트용)
        ↓
SSM /teams-bedrock-chatbot/{kb-id, model-id}    # 기본 — 자동 로드
        ↓
STS GetCallerIdentity                            # AWS_ACCOUNT_ID 미설정 + inference profile 사용 시 자동 조회
        ↓
Hard defaults (region=us-west-2, model=us.anthropic.claude-sonnet-4-6)
```

이렇게 함으로써 **소스코드/`.env.local` 에는 환경별 ID 가 하드코딩되지 않고**, 배포된 KB 가 바뀌어도 SSM 만 업데이트하면 됩니다.

### 환경변수 (Optional Override)

| 키 | 우선순위 | 기본 |
|---|---|---|
| `AWS_REGION` | env > default | `us-west-2` |
| `KB_ID` | env > **SSM** | (SSM 필수) |
| `MODEL_ID` | env > SSM > default | `us.anthropic.claude-sonnet-4-6` |
| `AWS_ACCOUNT_ID` | env > **STS** | (STS 자동) |
| `PARAM_PREFIX` | env > default | `/teams-bedrock-chatbot` |
| `AWS_PROFILE` | env | `default` |

AWS 자격 증명은 별도 설정 없이 `~/.aws/credentials` 의 default 프로필을 자동 사용합니다.

## 구조

```
web/
├── app/
│   ├── api/chat/route.ts    # POST 핸들러. loadConfig() → RetrieveAndGenerate 호출
│   ├── page.tsx             # 채팅 UI (클라이언트 컴포넌트)
│   ├── layout.tsx
│   └── globals.css
├── lib/
│   ├── config.ts            # SSM Parameter Store + STS + env 우선순위 처리, in-process 캐싱
│   └── types.ts             # Citation, ChatMessage, ChatResponse
├── .env.local.example
└── package.json
```

## API

`POST /api/chat`

```json
// 요청
{ "message": "Phoenix 프로젝트 DB는?", "sessionId": "optional" }

// 응답
{
  "answer": "PostgreSQL (Aurora) 입니다...",
  "citations": [
    {
      "excerpt": "DB는 PostgreSQL 권장드립니다...",
      "chatTopic": "프로젝트 Phoenix 개발팀",
      "chatType": "group",
      "participants": ["김민준", "이서연"],
      "threadUrl": "https://teams.microsoft.com/l/message/...",
      "sourceUri": "s3://..."
    }
  ],
  "sessionId": "abc-123"
}
```

- `sessionId` 는 첫 응답에서 받아서 후속 요청에 그대로 넘기면 대화 컨텍스트 유지됨 (Bedrock이 약 24시간 보존)

## 필요한 IAM 권한

Next.js 서버가 사용할 자격 증명(로컬은 본인 IAM, 배포 시 task role)에 다음 권한 필요:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:Retrieve",
        "bedrock:RetrieveAndGenerate",
        "bedrock:InvokeModel"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["ssm:GetParameters"],
      "Resource": "arn:aws:ssm:*:*:parameter/teams-bedrock-chatbot/*"
    },
    {
      "Effect": "Allow",
      "Action": ["sts:GetCallerIdentity"],
      "Resource": "*"
    }
  ]
}
```

## 트러블슈팅

| 증상 | 원인 |
|---|---|
| `KB_ID not found. Set env var KB_ID or SSM parameter /teams-bedrock-chatbot/kb-id` | SSM에 파라미터 없거나 GetParameters 실패. `aws ssm get-parameters-by-path --path /teams-bedrock-chatbot` 로 확인. setup-kb.sh 재실행하거나 수동 `aws ssm put-parameter` |
| `AccessDeniedException` on SSM | IAM 에 `ssm:GetParameters` 권한 부족 |
| `ResourceNotFoundException` (Bedrock) | KB_ID 가 가리키는 KB 가 해당 리전에 없거나 삭제됨 |
| `ValidationException: modelArn` | MODEL_ID 형식 오류. inference profile (`us.*`) 는 AWS_ACCOUNT_ID 필요 |
| 답변 비어 있고 citations 없음 | KB 인덱싱 미완료. `aws bedrock-agent list-ingestion-jobs ...` 로 확인 |

## 빌드

```bash
npm run build    # 프로덕션 빌드
npm run start    # 빌드된 결과로 실행
npm run typecheck
```
