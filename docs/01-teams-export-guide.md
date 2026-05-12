# Step 1 — Microsoft Teams 채팅 export 가이드

> 목표: Azure AD 앱 등록 없이, **Microsoft Graph Explorer**(브라우저 도구)만으로 본인의
> Teams 1:1 / 그룹 채팅 메시지를 JSON으로 받아 `ingestion/raw/` 폴더에 저장한다.

---

## 0. 사전 준비

- 회사/학교 Microsoft 365 계정 (Teams를 평소 사용 중인 그 계정)
- 최신 브라우저 (Chrome / Edge / Safari)
- 본 프로젝트 루트: `/Users/heungh/Documents/SA/05.Project/66.Teams_bedrock`

---

## 1. Graph Explorer 로그인

1. 브라우저로 이동: <https://developer.microsoft.com/en-us/graph/graph-explorer>
2. 좌측 상단 **"Sign in with Microsoft"** 클릭 → 회사 계정으로 로그인
3. 로그인 후 좌측 패널에 본인 이메일이 표시되면 OK

> ⚠️ "Need admin approval" 같은 메시지가 뜨면 회사 테넌트에서 Graph Explorer 자체를
> 차단한 것. 이 경우는 가이드 끝의 **Fallback** 섹션 참고.

---

## 2. 권한 (Scope) 동의

Graph Explorer 좌측 패널의 **"Modify permissions (Preview)"** 또는 상단 자물쇠 아이콘 클릭.

다음 권한을 찾아서 **Consent** 버튼 클릭:

| Permission | 용도 |
|---|---|
| `User.Read` | 본인 프로필 (보통 이미 동의됨) |
| `Chat.Read` | 본인이 속한 1:1 / 그룹 채팅 메시지 읽기 |
| `Chat.ReadBasic` | 채팅 목록 메타데이터 |

각 항목 옆 **Consent** → 팝업에서 **수락(Accept)**.

> 💡 `ChannelMessage.Read.All` 은 관리자 동의 필요 → 이번 단계에서는 **신경 쓰지 않음**.

---

## 3. 본인 정보 확인 (sanity check)

상단 입력창에 아래 입력 후 **Run query**:

```
GET https://graph.microsoft.com/v1.0/me
```

응답에 본인 `displayName`, `mail`, `id` 가 보이면 인증 OK.

**본인 `id` 값을 메모**해 두세요. (변환 스크립트에서 "내 메시지 vs 상대 메시지" 구분에 사용)

---

## 4. 채팅 목록 가져오기

```
GET https://graph.microsoft.com/v1.0/me/chats?$top=50
```

응답 예시 (요약):

```json
{
  "value": [
    {
      "id": "19:abc...@unq.gbl.spaces",
      "topic": "프로젝트 A 논의",
      "chatType": "group",
      "createdDateTime": "2025-09-12T...",
      "lastUpdatedDateTime": "2026-05-10T..."
    },
    {
      "id": "19:def...@unq.gbl.spaces",
      "topic": null,
      "chatType": "oneOnOne",
      ...
    }
  ]
}
```

### 저장

응답 우측 상단 **"Response preview"** 영역의 JSON을 전체 복사 →
`ingestion/raw/chats.json` 으로 저장.

> `chatType` 종류:
> - `oneOnOne` — 1:1 DM
> - `group` — 사용자가 만든 그룹 채팅
> - `meeting` — 회의 채팅

### 어떤 채팅을 KB에 넣을지 고르기

`chats.json` 을 열어서 **KB에 넣고 싶은 채팅의 `id` 값들을 골라**서 메모하세요.
(보통 `topic` 이 있는 그룹 채팅이 검색 가치가 높습니다.)

---

## 5. 특정 채팅의 메시지 가져오기

채팅 1개당 한 번씩 호출:

```
GET https://graph.microsoft.com/v1.0/me/chats/{chat-id}/messages?$top=50
```

`{chat-id}` 부분에 4단계에서 골라둔 ID를 넣습니다 (예: `19:abc...@unq.gbl.spaces`).

### 페이지네이션

응답 JSON 맨 아래에 다음 필드가 있으면 메시지가 더 있다는 뜻:

```json
"@odata.nextLink": "https://graph.microsoft.com/v1.0/me/chats/.../messages?$skiptoken=..."
```

→ 그 URL을 그대로 복사해서 다시 **Run query** → 다음 50개 응답.
→ 모든 페이지를 받을 때까지 반복.

### 저장 규칙

채팅 하나의 모든 페이지 응답을 **합쳐서** 한 파일에 저장:

```
ingestion/raw/messages_<짧은-식별자>.json
```

예시 파일명:
- `messages_projectA.json`  (그룹 채팅 "프로젝트 A 논의")
- `messages_kim_1on1.json`  (김OO과의 1:1)

저장 형식 (직접 합쳐 주세요 — 아주 간단):

```json
{
  "chatId": "19:abc...@unq.gbl.spaces",
  "topic": "프로젝트 A 논의",
  "chatType": "group",
  "messages": [
    /* 1페이지 응답의 value[] 전체 */
    /* 2페이지 응답의 value[] 전체 */
    /* ... */
  ]
}
```

> 💡 페이지가 많으면(>5) 6단계의 자동화 스크립트 사용을 권장.

---

## 6. (선택) 페이지네이션이 많을 때 — 미니 fetch 스크립트

Graph Explorer는 한 페이지씩 수동 클릭이 번거로우므로, 토큰만 복사해서
로컬에서 자동 페이지네이션하는 스크립트입니다.

### 6-1. Access Token 복사

Graph Explorer 좌측 패널 → **"Access token"** 탭 → 토큰 문자열 전체 복사.

> ⚠️ 토큰은 **약 1시간 유효**. 만료되면 페이지 새로고침 후 다시 복사.

### 6-2. 환경변수로 토큰 설정 (터미널에서)

```bash
cd /Users/heungh/Documents/SA/05.Project/66.Teams_bedrock
export GRAPH_TOKEN="여기에_토큰_붙여넣기"
```

### 6-3. 스크립트 실행 (Step 2에서 함께 만들 예정)

Step 2에서 만들 `ingestion/fetch-messages.ts` 가 위 환경변수와
`chats.json` 을 읽어 모든 페이지를 자동 수집해 `messages_*.json` 으로 저장합니다.

→ **5단계가 너무 번거로우면 일단 채팅 1개만 수동으로 받아 두시고,
Step 2에서 fetch 스크립트로 나머지를 자동화**해도 됩니다.

---

## 7. 메시지 JSON 안에 들어있는 주요 필드 (참고)

KB 변환 시 어떤 정보를 보존할지 미리 감 잡기 위함:

| 필드 | 의미 |
|---|---|
| `id` | 메시지 ID (스레드의 부모 식별에 사용) |
| `replyToId` | null이면 새 스레드, 값이 있으면 그 메시지에 대한 리플라이 |
| `createdDateTime` | 작성 시각 (ISO 8601) |
| `from.user.displayName` | 보낸 사람 이름 |
| `from.user.id` | 보낸 사람 ID |
| `body.content` | 본문 (HTML 또는 plain text) |
| `body.contentType` | `"html"` \| `"text"` |
| `attachments[]` | 파일/카드 첨부 |
| `mentions[]` | @멘션된 사용자 |
| `webUrl` | Teams에서 해당 메시지로 가는 deep link **(인용 링크에 핵심)** |

---

## 8. 체크리스트 — Step 1 완료 기준

다음을 만족하면 Step 2로 진행 가능:

- [ ] `ingestion/raw/chats.json` 생성됨
- [ ] KB에 넣고 싶은 채팅 ID들을 골랐음
- [ ] 최소 **1개 이상**의 `ingestion/raw/messages_*.json` 생성됨
  (각 파일에 `chatId`, `topic`, `chatType`, `messages[]` 포함)
- [ ] 본인 user `id` 를 메모해 둠

---

## Fallback — Graph Explorer 자체가 막혔을 때

회사 테넌트에서 Graph Explorer 사용을 차단한 경우:

1. **PowerShell + Microsoft Graph SDK** (Mac도 가능)
   ```bash
   brew install --cask powershell
   pwsh
   Install-Module Microsoft.Graph -Scope CurrentUser
   Connect-MgGraph -Scopes "Chat.Read","User.Read"
   Get-MgChat | ConvertTo-Json -Depth 10 > chats.json
   Get-MgChatMessage -ChatId "<chat-id>" -All | ConvertTo-Json -Depth 10 > messages_x.json
   ```
   → 결과 파일을 `ingestion/raw/` 로 이동.

2. **Microsoft 365 개인 데이터 export** (account.microsoft.com → Privacy →
   Download your data) — 처리에 수시간~수일 소요. 받은 ZIP 안의 Teams 메시지
   JSON을 그대로 사용.

위 두 경로 모두 막혔다면 알려주세요 — 다른 접근(예: Power Automate 플로우)을 안내합니다.

---

## 다음 단계

`raw/messages_*.json` 이 1개라도 준비되면 **Step 2 — 변환 스크립트**로 넘어갑니다.
변환 스크립트가 하는 일:

- HTML 본문 → 깨끗한 텍스트
- `replyToId` 따라가며 메시지를 **스레드 단위로 묶기**
- 각 스레드를 **Markdown 1개 + `.metadata.json` 1개**로 출력
- `webUrl` 을 메타데이터에 보존 → 챗봇 답변에서 원본 메시지로 deep link
