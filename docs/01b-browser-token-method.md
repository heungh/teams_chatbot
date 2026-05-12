# Step 1b — 브라우저 Teams 세션 토큰으로 메시지 수집

> Graph Explorer 권한 동의가 관리자 승인에 막혔을 때 사용. 이미 동의가 완료된
> 공식 Teams 웹앱의 access token을 그대로 빌려서 Graph API를 호출한다.

---

## ⚠️ 보안 원칙

- 토큰은 비밀번호와 동급. **절대로 채팅/메일/깃/스크린샷 캡처에 노출 금지.**
- 본인 로컬 터미널에서 환경변수로만 사용 (`export GRAPH_TOKEN=...`).
- 토큰 수명: 약 1시간. 만료 시 Teams 웹 새로고침 후 재추출.
- 작업 끝나면 <https://mysignins.microsoft.com/security-info> 에서 "Sign out everywhere" 한 번 눌러 두기.

---

## 1. Teams 웹 로그인

1. Chrome 또는 Edge로 <https://teams.microsoft.com> 접속 후 회사 계정 로그인
2. 평소 보던 채팅 목록이 뜨는지 확인

---

## 2. DevTools에서 올바른 토큰 추출 ★중요★

Teams 웹은 동시에 여러 백엔드로 요청을 보냅니다 — `ic3.teams.office.com`,
`presence.teams.microsoft.com`, `graph.microsoft.com` 등. **반드시 `graph.microsoft.com`
요청의 토큰**을 골라야 합니다.

### 절차

1. **F12** → **Network** 탭
2. 필터(Filter) 입력창에 정확히: `graph.microsoft.com`
3. Teams에서 페이지를 한 번 **새로고침** (Cmd+R) 또는 채팅을 클릭
4. 필터에 잡힌 요청 중 **아무거나 클릭** (예: `/me`, `/me/chats`, `/users/...`)
5. 우측 패널 → **Headers** → **Request Headers** 섹션
6. `Authorization: Bearer eyJ0eXAi...` → **`Bearer ` 뒤의 긴 문자열만** 복사

### 토큰 검증 (선택)

복사한 토큰을 <https://jwt.ms> 에 붙여 넣어 페이로드 확인:

| 필드 | 기대값 |
|---|---|
| `aud` | `https://graph.microsoft.com` 또는 `00000003-0000-0000-c000-000000000046` |
| `scp` | `Chat.Read`, `Chat.ReadWrite`, `User.Read` 등이 포함 |
| `upn` | 본인 회사 이메일 |
| `exp` | 미래 시각 (Unix epoch) |

`aud` 가 `ic3.teams.office.com` 이면 **잘못된 토큰**. 필터에 다시 `graph.microsoft.com`만
정확히 입력해서 재시도.

---

## 3. 환경변수 설정 + 의존성 설치

터미널에서:

```bash
cd /Users/heungh/Documents/SA/05.Project/66.Teams_bedrock/ingestion

# 의존성 설치 (최초 1회)
npm install

# 토큰 등록 (이 셸 세션 동안만 유효)
export GRAPH_TOKEN="복사한_토큰_붙여넣기"
```

> 토큰을 `.env` 파일에 적어 두려면 반드시 `.gitignore`에 `.env` 가 들어 있는지 확인.
> 본 프로젝트 `ingestion/.gitignore` 에는 이미 포함되어 있음.

---

## 4. 채팅 목록만 먼저 조회 (드라이런)

```bash
npm run fetch -- --list-only
```

출력 예:

```
1) /me
   Ha, Heungsu (heungh@example.com)
2) chat list
   page 1... +50
   page 2... +12
   62 chats total
   → ingestion/raw/chats.json
3) (--list-only) skipping message fetch
```

`ingestion/raw/chats.json` 을 열어서 KB에 넣고 싶은 채팅을 고르세요.
ID는 `19:abc...@unq.gbl.spaces` 같은 긴 문자열입니다.

---

## 5. 선택한 채팅의 메시지 수집

채팅 ID를 콤마로 구분해 환경변수로 전달:

```bash
export CHAT_IDS="19:abc...@unq.gbl.spaces,19:def...@unq.gbl.spaces"
npm run fetch
```

또는 모든 채팅을 다 받고 싶다면 (시간 오래 걸림):

```bash
unset CHAT_IDS
npm run fetch
```

결과:

```
ingestion/raw/
├── me.json
├── chats.json
├── messages_프로젝트A_논의.json
└── messages_oneOnOne_19abcdef.json
```

각 `messages_*.json` 의 구조:

```json
{
  "chatId": "19:abc...@unq.gbl.spaces",
  "topic": "프로젝트 A 논의",
  "chatType": "group",
  "fetchedAt": "2026-05-11T...",
  "messages": [ /* 모든 페이지 합친 결과 */ ]
}
```

---

## 6. 자주 만나는 에러

| 증상 | 원인 / 해결 |
|---|---|
| `Graph 401: InvalidAuthenticationToken` | 토큰 만료. Teams 웹 새로고침 → 재추출 |
| `Graph 403: Authorization_RequestDenied` | 토큰 audience가 Graph가 아님 (ic3 등). 2번 절차 다시 |
| `Graph 429: TooManyRequests` | 호출 속도 제한. 스크립트가 자동 재시도하지만 너무 잦으면 잠시 대기 |
| `GRAPH_TOKEN environment variable is required` | `export GRAPH_TOKEN=...` 누락 또는 다른 셸 세션 |
| 메시지 본문이 비어 있음 | 시스템 메시지(joined/left 등)이거나 첨부만 있는 메시지. Step 2에서 필터링 |

---

## 7. Step 1 체크리스트 (브라우저 토큰 경로)

- [ ] `ingestion/raw/me.json` 생성 — 본인 정보 확인됨
- [ ] `ingestion/raw/chats.json` 생성 — 채팅 목록 확보
- [ ] 1개 이상의 `ingestion/raw/messages_*.json` 생성
- [ ] 토큰 사용 후 셸 종료 또는 `unset GRAPH_TOKEN` 으로 정리

✅ 위 체크 끝나면 **Step 2 — 변환 스크립트** 로 진행.
