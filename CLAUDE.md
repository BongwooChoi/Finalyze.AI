# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

**Finalyze.AI** — OPEN DART(금융감독원 공시) API 데이터를 기반으로 한국 상장기업의 재무제표를 시각화하고 OpenAI GPT로 분석하는 웹앱. Express 서버 + 빌드 과정 없는 순수 HTML/CSS/JS 프런트엔드(SPA, PWA)로 구성되며 Vercel에 서버리스로 배포된다 (https://finalyze-ai.vercel.app).

## 명령어

```
npm start                        # 로컬 서버 실행 (기본 포트 3000)
npm run setup:accounts           # 계정 DB 스키마 준비 (Neon 또는 로컬 SQLite)
npm run check:accounts           # 로그인·데이터 분리·푸시·알림 대기열 검사
npm run check:public-pages        # 공개 페이지·메타데이터·리디렉션·사이트맵 HTTP 검사
npm run check:recent-disclosures  # 최신 실적 공시 선정·페이지 처리·캐시 검사
npm run check:dart-client         # DART 공유 캐시·호출 속도·하루 한도·차단 응답 검사
```

`npm test`는 의도적으로 실패하는 placeholder다. 공개 페이지 검사는 `npm run check:public-pages`를 사용하며, 별도 린트는 없다.

로컬 DB(dart.db) 최초 구축 또는 회사 목록 갱신 시 (순서대로 실행):

```
npm run download-corp-code       # DART에서 corpCode.zip 다운로드
npm run parse-corp-code-simple   # corpCode.json / listedCorpCode.json 생성
node setupDatabase.js            # dart.db에 companies 테이블 적재 + 인덱스 생성
```

회사 검색 유틸: `npm run search-corp-name "삼성전자"` / `npm run search-stock-code "005930"`

`.env`에 `OPEN_DART_API_KEY`, `OPENAI_API_KEY` 필요 (config.js가 로드). Vercel 프로젝트 환경 변수에도 같은 키가 등록되어 있어야 한다.

## 아키텍처

- **server.js** — 모든 Express 라우트, AI 프롬프트 생성·OpenAI API 호출, DART 공시 원문(zip/XML) 파싱까지 담당하는 단일 파일. 로컬(`NODE_ENV !== 'production'`)에서만 `app.listen()`하고, Vercel에서는 `module.exports = app`을 서버리스 핸들러로 사용한다. vercel.json이 모든 경로를 server.js로 라우팅한다.
- **financialService.js** — DART API 호출(`fnlttSinglAcnt.json`)과 dart.db(SQLite) 조회. `REPORT_CODE` 매핑(사업보고서 11011, 반기 11012, 1분기 11013, 3분기 11014)이 여기 있다.
- **dartClient.js / sharedStore.js** — 웹 서버의 DART GET 요청은 반드시 `dartClient.get()`을 사용한다. Redis 공유 응답·중복 요청 잠금·인증키별 1초 간격/하루 8,000회(KST) 제한을 적용한다. 운영에서 공유 저장소 연결 실패 시 DART 직접 호출로 우회하지 않는다. 로컬에서 Redis 환경 변수가 없으면 메모리 저장소를 사용한다.
- **dart.db** — SQLite. `companies`(회사 검색용), `financial_statements` 테이블. **git에 커밋되어 있어 Vercel에서도 회사명/종목코드 검색에 사용된다(읽기 전용)**. 재무제표 데이터 자체는 Vercel 파일시스템이 쓰기 불가이므로 항상 DART API를 실시간 호출한다.
- **public/** — 프레임워크·번들러 없는 SPA. `index.html` 하나에 `js/main.js`(전체 프런트 로직), `css/style.css`. `/`와 `/about`은 `sitePages.js`가 본문 표시 상태와 경로별 메타데이터를 서버 렌더링한다. 서버와 브라우저가 `public/js/site-pages.js`의 설정을 공유한다. Bootstrap 5, Chart.js, html2canvas, jsPDF는 CDN 로드. URL 파라미터 기반 딥링크 복원(`restoreStateFromUrl`) 지원.

### API 엔드포인트 (프런트에서 실제 사용)

- `GET /api/companies/search?keyword=` — 회사명 부분일치 검색 (dart.db)
- `GET /api/companies/stock/:stockCode` — 종목코드 검색 (dart.db)
- `GET /api/financial-analysis` — DART에서 재무제표를 받아 주요 계정 추출 + 재무비율 계산
- `POST /api/ai-financial-analysis` — 위 분석 결과를 OpenAI GPT로 서술 분석
- `GET /api/financial-trend` — 최근 5개년 사업보고서를 연도별 병렬 조회해 손익 추이 반환
- `GET /api/disclosure-list` — 최근 5년 공시목록 프록시 (정기공시 A + 거래소공시 I 병합)
- `GET /api/recent-disclosures` — 대표기업 60개의 최신 실적 공시 최대 5개. `recentDisclosures.js`에서 선정·필요한 페이지 조회·Redis 공유 목록/수집 잠금·5분 캐시를 관리한다. 30일에 5개 미만이면 90일까지 확장한다. 잠정실적은 원문 표의 재무금액을 확인해 월간 판매대수 발표를 제외한다. 일시적 통신 오류는 한 번 재시도하고 원문 일부 실패는 `partial: true`와 확인된 목록을 반환한다(1분 캐시). 실패한 원문은 부적격으로 저장하지 않는다. 로그에는 단계·오류 코드·접수번호·`error.message`를 남기며 axios 객체 전체를 출력하지 않는다. 기업 명단은 분기마다 점검한다.
- `GET /api/provisional-analysis` — 잠정실적 공시 원문(zip)을 내려받아 텍스트 추출 후 OpenAI GPT 분석

**레거시 주의**: `/api/financial-statements`와 `/api/company-report-options`는 프런트에서 사용하지 않는다. 특히 `/api/financial-statements`는 financialService.js에서 export되지 않은 함수(`getFinancialStatements`, `saveFinancialStatementsToDB`)를 참조하므로 호출 시 크래시한다.

## 도메인 로직 핵심

- **금융회사 분기**: 회사명 키워드(`은행`, `보험`, `증권` 등)로 `isFinancialCompany`를 판별해 일반 기업과 다른 계정명 세트(`매출액` 대신 `영업수익`)와 별도 AI 프롬프트를 사용한다.
- **계정명 alias 매칭**: DART 계정명은 회사마다 다르다(예: `당기순이익(손실)`, `영업이익(손실)`). server.js의 `GENERAL_IS_ITEMS`/`FINANCIAL_IS_ITEMS` alias 목록으로 매칭하며, 새 계정 추가 시 이 패턴을 따른다.
- **금액 파싱**: DART 금액은 쉼표 포함 문자열이다 → `parseInt(String(v).replace(/,/g, ''), 10)`.
- **주요계정 API의 한계**: `fnlttSinglAcnt.json`은 유동자산·부채총계 같은 주요계정만 주고 재고자산 등 세부 계정은 없다. 그래서 당좌비율처럼 세부 계정이 필요한 지표는 계산하지 않는다(placeholder 0으로 채우면 틀린 값이 노출된다).
- **연결/개별 우선순위**: 연결재무제표(`fs_div === 'CFS'`) 우선, 없으면 개별(`OFS`) fallback.
- **날짜는 KST 기준**: Vercel 서버는 UTC로 돌기 때문에 공시 날짜 계산 시 UTC+9 보정을 해야 당일 공시가 잘리지 않는다 (`/api/disclosure-list` 참고).
- **OpenAI 호출**: 모델은 `gpt-6-luna`(`OPENAI_MODEL` 상수). Chat Completions API를 `reasoning_effort: 'none'`(리즈닝 비활성화)으로 호출하며, 429 발생 시 지수 백오프로 최대 3회 재시도(`callOpenAIAPI`). 에러 로그에는 axios `error` 객체 전체가 아닌 `error.message`만 남긴다(요청 헤더의 API 키 노출 방지).
- **AI 응답은 structured outputs(JSON)**: `response_format: json_schema`(strict)로 `FINANCIAL_ANALYSIS_SCHEMA` / `PROVISIONAL_ANALYSIS_SCHEMA`에 맞는 JSON(`sections[{category,title,points[{tone,text}]}]`, `rating: positive|mixed|negative`, `summary`)을 받는다. 잠정실적은 차트용 `chartData`도 같은 JSON에 포함된다. `title`은 서버가 직접 붙인다. 강조는 `**굵게**`만 허용하며, 프런트 `renderAiAnalysisHtml()`이 이스케이프 후 `<strong>`으로 바꿔 평가 배지 + 섹션 카드 + ▲▼ 항목으로 렌더링한다(모델 출력 HTML을 그대로 넣지 않음). 섹션 category를 추가하면 프런트 `AI_SECTION_ICONS`에도 아이콘을 추가한다. PDF 내보내기는 `data-export` 속성이 달린 블록만 추출한다(`extractAiAnalysisText`).
- **잠정실적은 정기공시보다 항목이 적다**: 섹션 1~3개, 항목 1~2개로 프롬프트를 따로 두고, 공시에 없는 내용(변동 요인 등)은 섹션을 만들지 않게 한다. "잠정치라 확정 실적과 다를 수 있다"는 안내는 AI가 아니라 프런트가 고정 문구로 표시한다.

## 계정과 알림

- `accountRoutes.js`는 Google ID 토큰·nonce, HttpOnly 세션, 변경 요청의 출처·CSRF를 확인합니다. Google 원본 식별자·이름·사진·로그인 토큰은 저장하지 않습니다. 이메일은 발신 설정과 별도 수신 동의가 있을 때만 암호화해 저장합니다.
- `accountStore.js`는 운영 Neon Postgres(`DATABASE_URL`), 로컬 `.data/accounts.sqlite`를 사용합니다. `USER_ID_SECRET`·`USER_DATA_KEY`·VAPID 키는 영속 데이터와 연결되어 있으므로 재배포마다 교체하지 않습니다. 무료 캐시 Redis를 계정 저장소로 사용하지 않습니다.
- `disclosureNotifications.js`는 관심 기업을 합쳐 A/I002 공시를 수집하고, DB 잠금·대기열·기기별 중복 방지·최대 5회 재시도를 관리합니다. DART 호출은 기존 `dartClient.get()`을 사용하고 LLM을 호출하지 않습니다. 신규 관심 기업의 최초 성공 조회는 과거 공시 기준만 설정합니다.
- `vercel.json`의 Schedules(Beta)가 15분 간격/15분 지터로 `POST /api/jobs/disclosures`를 호출하며 `CRON_SECRET` Bearer 인증이 필수입니다. Preview에는 운영 사용자 DB·인증 키를 연결하지 않습니다. 메일은 `RESEND_API_KEY`·`MAIL_FROM`이 모두 준비된 뒤 활성화합니다.
- UI는 `public/js/accounts.js`, 푸시 수신·이동은 `public/sw.js`입니다. 관심 기업과 푸시 링크를 열어도 분석은 자동 실행하지 않습니다. 처리 정보는 `/privacy`에서 안내합니다.

## 프런트엔드 캐시 무효화 (필수)

public/의 CSS·JS를 수정하면 배포된 사용자에게 반영되도록 **두 곳의 버전을 함께 올려야 한다**:
1. `public/sw.js`의 `CACHE_NAME` (예: `financial-app-cache-v16` → `v17`)
2. `public/index.html`의 자산 쿼리스트링 (예: `js/main.js?v=3.0` → `?v=3.1`)
