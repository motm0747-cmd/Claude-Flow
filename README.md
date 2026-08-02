# Claude Flow

가계부·자산관리 웹앱. 계좌·카드(실적/혜택/할부)·거래·고정비·투자적립(DCA)·리포트·목표·예산·부채·위시리스트·건강점수·환율까지 한 곳에서 관리합니다.

이제 **아이폰·아이패드·PC·안드로이드 어디서나** 설치형 웹앱(PWA)으로 쓰고, **로그인 한 번으로 모든 기기가 같은 데이터를 공유**합니다.

---

## 무엇이 달라졌나

| | 이전 | 지금 |
|---|---|---|
| 형태 | HTML 파일을 직접 열기 | URL로 접속하는 **설치형 웹앱(PWA)** |
| 설치 | 아이폰 홈화면 추가만 | 폰·패드·PC·안드로이드 **모두 설치 가능** |
| 오프라인 | 브라우저 캐시 의존 | **서비스워커로 오프라인 동작** |
| 데이터 | 그 기기 안에만 | **클라우드 자동 동기화(선택)** — 모든 기기 공유 |

> 클라우드 동기화는 **선택 기능**입니다. 켜지 않으면 예전처럼 데이터는 그 기기에만 저장되고, 앱은 100% 동일하게 동작합니다.

---

## 1. 웹에 올리기 (배포)

정적 파일만 있으면 되므로 아래 **무료** 서비스 중 아무거나 쓰면 됩니다. 이 저장소를 연결하면 끝입니다.

### 추천: Cloudflare Pages (무료)
1. https://dash.cloudflare.com → **Workers & Pages → Create → Pages → Connect to Git**
2. 이 GitHub 저장소 선택
3. 빌드 설정: **Framework preset = None**, **Build command 비움**, **Output directory = `/`(루트)**
4. Deploy → `https://claude-flow.pages.dev` 같은 주소가 생깁니다.

### 대안
- **Vercel** — New Project → 저장소 선택 → Framework: *Other* → Deploy
- **Netlify** — Add new site → Import → Publish directory: 루트
- **GitHub Pages** — Settings → Pages → Branch를 `main`(또는 배포 브랜치) `/root`로 지정
  - 단, 프로젝트 하위 경로(`/저장소이름/`)로 열려도 상대경로로 되어 있어 정상 동작합니다.

배포가 끝나면 그 **URL을 모든 기기에서 그대로 열면 됩니다.**

---

## 2. 각 기기에 "앱"으로 설치

| 기기 | 방법 |
|---|---|
| **아이폰 / 아이패드 (Safari)** | 공유 버튼 → **홈 화면에 추가** |
| **안드로이드 (Chrome)** | 메뉴(⋮) → **앱 설치 / 홈 화면에 추가** |
| **PC (Chrome / Edge)** | 주소창 오른쪽 **설치 아이콘(⊕)** → 설치 |

설치하면 별도 앱처럼 아이콘이 생기고, 주소창 없이 전체화면으로 뜨며, 오프라인에서도 열립니다.

---

## 3. 클라우드 동기화 켜기 (Supabase · 무료)

여러 기기에서 **같은 데이터**를 쓰려면 한 번만 설정하면 됩니다. 무료 한도로 충분합니다.

### 3-1. Supabase 프로젝트 만들기
1. https://supabase.com → 가입 → **New project**
2. 프로젝트 이름·비밀번호(DB 비밀번호) 정하고 생성 (1~2분 소요)

### 3-2. 데이터베이스 준비
1. 왼쪽 메뉴 **SQL Editor → New query**
2. 이 저장소의 [`supabase/schema.sql`](supabase/schema.sql) 내용을 통째로 붙여넣고 **Run**
   - 사용자별 데이터 테이블 + 본인만 접근 가능한 보안(RLS) + 최근 30개 자동 백업이 만들어집니다.

### 3-3. (선택) 이메일 인증 방식 정하기
- **Authentication → Providers → Email** 이 기본으로 켜져 있습니다.
- 혼자 여러 기기에서 쓰는 용도라면 **Authentication → Sign In / Providers**에서
  *"Confirm email"* 을 꺼 두면 가입 즉시 로그인됩니다(가장 간단).
  켜 두면 가입 시 확인 메일의 링크를 눌러야 합니다.

### 3-4-A. (배포용) 앱에 프로젝트 내장하기 — 사용자는 입력 불필요 ⭐
여러 사람에게 배포하거나 앱처럼 쓰려면, [`config.js`](config.js)에 프로젝트 정보를 한 번만 넣어두세요. 그러면 **사용자는 URL·키를 입력할 필요 없이 이메일·비밀번호만으로 가입**할 수 있습니다.

```js
window.CLAUDE_FLOW_CONFIG = {
  supabaseUrl: 'https://xxxx.supabase.co',
  supabaseAnonKey: 'eyJ...',      // anon / public 키
  allowCustomProject: true         // 사용자가 자기 Supabase를 쓰도록 허용할지
};
```

> **anon key를 코드에 넣어도 되나요?** 네. anon key는 Supabase가 브라우저 공개를 전제로 설계한 키이고, 실제 보호는 RLS 정책이 담당합니다(`supabase/schema.sql` 적용 필수 — 로그인 사용자는 자기 행만 접근).
> ❌ `service_role` / `secret` 키는 절대 넣지 마세요. RLS를 우회합니다.

배포 시 함께 확인할 것:
- **Authentication → Providers → Email**의 *Confirm email* — 켜두면 가입자가 확인 메일을 눌러야 합니다(공개 배포 시 권장).
- 서버 AI(`ai` 함수)를 켜두면 **가입한 모든 사용자가 소유자의 Gemini 키를 사용**합니다. 원치 않으면 함수를 배포하지 않거나, 사용자별 키 입력 방식으로 두세요.
- Supabase 무료 플랜의 용량·대역폭 한도를 넘지 않는지 주기적으로 확인하세요.

`config.js`를 비워두면 아래 3-4-B 방식(사용자가 직접 입력)으로 동작합니다.

### 3-4-B. 앱에 연결 (개인용 · 직접 입력)
1. Supabase **Project Settings → API** 에서 두 값을 복사:
   - **Project URL** (`https://xxxx.supabase.co`)
   - **anon public** key (`eyJ…` 로 시작 — 공개되어도 안전한 키입니다)
2. 배포된 Claude Flow 앱을 열고 **설정(⚙︎) → 클라우드 동기화**
3. URL·anon key 붙여넣고 **연결** → 이메일·비밀번호로 **회원가입/로그인**
4. 끝! 다른 기기에서도 같은 계정으로 로그인하면 데이터가 자동으로 맞춰집니다.

> **동작 방식:** 첫 기기에서 로그인하면 지금 로컬 데이터가 클라우드로 올라갑니다.
> 새 기기(빈 상태)에서 로그인하면 클라우드 데이터를 받아옵니다.
> 이후에는 저장하면 ~1.5초 뒤 자동 업로드, 앱을 열거나 다시 켤 때 최신본을 받아옵니다.

### 3-5. 실시간 동기화 (한 줄 추가 실행)
`schema.sql` 에는 실시간 발행 설정도 포함돼 있어요. 이미 예전 버전만 실행했다면, SQL Editor 에서 아래 한 줄만 더 실행하면 **두 기기를 동시에 켜둬도 즉시** 반영됩니다.

```sql
alter publication supabase_realtime add table public.flow_state;
```

---

### 3-6. 서버 AI (선택 — 키를 서버로 옮기기)
AI 해설(리포트·주간 브리핑)을 **서버에서** 처리하면 → 키가 브라우저에 노출되지 않고, **모든 기기에서 키 없이** AI가 켜져요. 로그인돼 있으면 앱이 자동으로 서버 AI를 우선 사용합니다(없으면 기존 로컬 키로 폴백).

1. Supabase **Edge Functions → 새 함수 `ai` 생성** → [`supabase/functions/ai/index.ts`](supabase/functions/ai/index.ts) 내용을 붙여넣고 **Deploy**
2. **Edge Functions → Secrets** 에 `GEMINI_API_KEY = 당신의 Gemini 키` 추가 (선택: `AI_MODEL`)
3. 끝 — 앱에서 로그인 상태면 자동으로 서버 AI를 씁니다. (`verify_jwt`는 켠 채로 두세요: 로그인한 사람만 호출 가능)

> CLI를 쓰면: `supabase functions deploy ai` + `supabase secrets set GEMINI_API_KEY=…`

## 4. 데이터 안전

- **로컬 우선:** 앱은 항상 기기 저장소를 먼저 씁니다. 인터넷/클라우드가 안 돼도 그대로 동작합니다.
- **덮어쓰기 방지:** 비어 있거나 더 오래된 클라우드 데이터로 로컬을 절대 덮어쓰지 않습니다. 충돌이 감지되면 로컬 스냅샷을 `claudeflow_conflict_backup` 에 백업한 뒤 진행합니다.
- **서버 백업:** `schema.sql` 을 적용하면 저장할 때마다 최근 30개 버전이 `flow_state_history` 에 남습니다.
- **수동 백업:** 설정 → **데이터 내보내기**로 언제든 JSON 파일로 저장할 수 있습니다.

### 알아두기 (현재 동기화 정책)
- 충돌 해결은 **마지막 저장 우선(rev 기준)** + 자동 로컬 백업입니다. 두 기기에서 **동시에 오프라인으로** 편집한 뒤 각각 올리면, 나중에 올린 쪽이 남고 다른 쪽은 백업으로 보존됩니다. 한 사람이 기기를 번갈아 쓰는 일반적인 상황에서는 문제가 없습니다.

---

## 5. 파일 구조

```
index.html            앱 본체 (UI·로직 전부)
sync.js               클라우드 동기화 엔진 (Supabase, 옵트인)
sw.js                 서비스워커 (오프라인·설치)
manifest.webmanifest  PWA 매니페스트
icons/                앱 아이콘 (PNG·SVG)
supabase/schema.sql   Supabase 데이터베이스 스키마
```

---

## 6. 로컬에서 실행

서비스워커는 `file://` 이 아니라 **서버로 띄워야** 동작합니다.

```bash
# 저장소 폴더에서
python3 -m http.server 8080
# 브라우저에서 http://localhost:8080 접속
```

---

## 7. 외부 연동

- **Pretendard** 폰트 (CDN)
- **Supabase** — 클라우드 동기화(선택). anon key 는 공개 키이며 RLS로 보호됩니다.
- **Gemini** — 리포트 AI 해설(선택). 키는 사용자가 직접 넣고 그 기기에만 저장됩니다.
- **환율 API** — USD/KRW 자동 갱신(실패 시 수동 입력 가능).
