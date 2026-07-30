# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

**Finalyze.AI** — OPEN DART(금융감독원 공시) API 데이터를 기반으로 한국 상장기업의 재무제표를 시각화하고 Gemini AI로 분석하는 웹앱. Express 서버 + 빌드 과정 없는 순수 HTML/CSS/JS 프런트엔드(SPA, PWA)로 구성되며 Vercel에 서버리스로 배포된다 (https://finalyze-ai.vercel.app).

## 명령어

```
npm start                        # 로컬 서버 실행 (기본 포트 3000)
```

테스트·린트는 없다 (`npm test`는 의도적으로 실패하는 placeholder).

로컬 DB(dart.db) 최초 구축 또는 회사 목록 갱신 시 (순서대로 실행):

```
npm run download-corp-code       # DART에서 corpCode.zip 다운로드
npm run parse-corp-code-simple   # corpCode.json / listedCorpCode.json 생성
node setupDatabase.js            # dart.db에 companies 테이블 적재 + 인덱스 생성
```

회사 검색 유틸: `npm run search-corp-name "삼성전자"` / `npm run search-stock-code "005930"`

`.env`에 `OPEN_DART_API_KEY`, `GEMINI_API_KEY` 필요 (config.js가 로드).

## 아키텍처

- **server.js** — 모든 Express 라우트, Gemini 프롬프트 생성·호출, DART 공시 원문(zip/XML) 파싱까지 담당하는 단일 파일. 로컬(`NODE_ENV !== 'production'`)에서만 `app.listen()`하고, Vercel에서는 `module.exports = app`을 서버리스 핸들러로 사용한다. vercel.json이 모든 경로를 server.js로 라우팅한다.
- **financialService.js** — DART API 호출(`fnlttSinglAcnt.json`)과 dart.db(SQLite) 조회. `REPORT_CODE` 매핑(사업보고서 11011, 반기 11012, 1분기 11013, 3분기 11014)이 여기 있다.
- **dart.db** — SQLite. `companies`(회사 검색용), `financial_statements` 테이블. **git에 커밋되어 있어 Vercel에서도 회사명/종목코드 검색에 사용된다(읽기 전용)**. 재무제표 데이터 자체는 Vercel 파일시스템이 쓰기 불가이므로 항상 DART API를 실시간 호출한다.
- **public/** — 프레임워크·번들러 없는 SPA. `index.html` 하나에 `js/main.js`(전체 프런트 로직), `css/style.css`. Bootstrap 5, Chart.js, html2canvas, jsPDF는 CDN 로드. URL 파라미터 기반 딥링크 복원(`restoreStateFromUrl`) 지원.

### API 엔드포인트 (프런트에서 실제 사용)

- `GET /api/companies/search?keyword=` — 회사명 부분일치 검색 (dart.db)
- `GET /api/companies/stock/:stockCode` — 종목코드 검색 (dart.db)
- `GET /api/financial-analysis` — DART에서 재무제표를 받아 주요 계정 추출 + 재무비율 계산
- `POST /api/ai-financial-analysis` — 위 분석 결과를 Gemini로 서술 분석
- `GET /api/financial-trend` — 최근 5개년 사업보고서를 연도별 병렬 조회해 손익 추이 반환
- `GET /api/disclosure-list` — 최근 5년 공시목록 프록시 (정기공시 A + 거래소공시 I 병합)
- `GET /api/provisional-analysis` — 잠정실적 공시 원문(zip)을 내려받아 텍스트 추출 후 Gemini 분석

**레거시 주의**: `/api/financial-statements`와 `/api/company-report-options`는 프런트에서 사용하지 않는다. 특히 `/api/financial-statements`는 financialService.js에서 export되지 않은 함수(`getFinancialStatements`, `saveFinancialStatementsToDB`)를 참조하므로 호출 시 크래시한다.

## 도메인 로직 핵심

- **금융회사 분기**: 회사명 키워드(`은행`, `보험`, `증권` 등)로 `isFinancialCompany`를 판별해 일반 기업과 다른 계정명 세트(`매출액` 대신 `영업수익`)와 별도 Gemini 프롬프트를 사용한다.
- **계정명 alias 매칭**: DART 계정명은 회사마다 다르다(예: `당기순이익(손실)`, `영업이익(손실)`). server.js의 `GENERAL_IS_ITEMS`/`FINANCIAL_IS_ITEMS` alias 목록으로 매칭하며, 새 계정 추가 시 이 패턴을 따른다.
- **금액 파싱**: DART 금액은 쉼표 포함 문자열이다 → `parseInt(String(v).replace(/,/g, ''), 10)`.
- **연결/개별 우선순위**: 연결재무제표(`fs_div === 'CFS'`) 우선, 없으면 개별(`OFS`) fallback.
- **날짜는 KST 기준**: Vercel 서버는 UTC로 돌기 때문에 공시 날짜 계산 시 UTC+9 보정을 해야 당일 공시가 잘리지 않는다 (`/api/disclosure-list` 참고).
- **Gemini 호출**: 모델은 `gemini-3.1-flash-lite`, 429 발생 시 지수 백오프로 최대 3회 재시도(`callGeminiAPI`). AI 응답은 Markdown이 아닌 HTML 조각(`<p>`, `<span class="positive|negative|neutral">`, `<strong>`)으로 받도록 프롬프트에서 강제하며, 잠정실적 분석은 응답 마지막 줄의 `CHART_DATA:{...}` JSON을 분리해 차트 데이터로 쓴다.

## 프런트엔드 캐시 무효화 (필수)

public/의 CSS·JS를 수정하면 배포된 사용자에게 반영되도록 **두 곳의 버전을 함께 올려야 한다**:
1. `public/sw.js`의 `CACHE_NAME` (예: `financial-app-cache-v16` → `v17`)
2. `public/index.html`의 자산 쿼리스트링 (예: `js/main.js?v=3.0` → `?v=3.1`)
