# OPEN DART API 프로젝트

OPEN DART API를 사용하여 금융감독원 공시 데이터를 가져오는 프로젝트입니다.

## 설치 방법

```
npm install
```

## 환경 변수 설정

1. 프로젝트 루트 디렉토리에 `.env` 파일을 생성합니다.
2. 아래와 같이 OPEN DART API 키를 설정합니다:

```
OPEN_DART_API_KEY=여기에_실제_API_키를_입력하세요
```

## OPEN DART API 키 발급 방법

1. [OPEN DART](https://opendart.fss.or.kr/) 웹사이트에 접속합니다.
2. 회원가입 후 로그인합니다.
3. [API 키 신청](https://opendart.fss.or.kr/intro/main.do) 메뉴에서 API 키를 신청합니다.
4. 발급받은 API 키를 `.env` 파일에 설정합니다.

## 회사코드 파일 다운로드

DART API를 사용하기 위해서는 회사의 고유번호(corp_code)가 필요합니다. 다음 명령어로 회사코드 파일을 다운로드할 수 있습니다:

```
npm run download-corp-code
```

다운로드한 ZIP 파일을 파싱하여 JSON 파일로 변환하려면 다음 명령어를 실행합니다:

```
npm run parse-corp-code-simple
```

이 명령어는 다음 두 개의 파일을 생성합니다:
- `corpCode.json`: 모든 회사 정보 (약 11만개)
- `listedCorpCode.json`: 상장 회사 정보만 포함 (약 3,800개)

## 회사 검색하기

회사 이름으로 검색하려면:

```
npm run search-corp-name "회사이름"
```

또는 직접 스크립트 실행:

```
node searchCorpCode.js -n "회사이름"
```

종목 코드로 검색하려면:

```
npm run search-stock-code "종목코드"
```

또는 직접 스크립트 실행:

```
node searchCorpCode.js -c "종목코드"
```

예시: 삼성전자 검색
```
node searchCorpCode.js -c "005930"
```

## 실행 방법

```
npm start
```

## 메인 화면 최신 실적 공시

- 검색창 아래에 대표기업 60개의 정기보고서·잠정실적을 기업별 최신 1건씩, 최대 5개·1열로 표시합니다. 기업 명단은 `recentDisclosures.js`의 `FEATURED_STOCK_CODES`에서 관리하는 편집 목록이며 인기 순위가 아닙니다.
- 목록의 ‘공시 보기’는 기업 정보·공시 목록으로 이동하고 해당 공시를 강조합니다. 새 탭·새로고침·공유 주소에서도 분석을 자동 실행하지 않으며, 사용자가 ‘분석하기’를 눌러야 재무·AI 분석을 요청합니다.
- `/api/recent-disclosures`는 OPEN DART의 정기공시 A와 공정공시 I002를 조회합니다. 기본 최근 30일, 결과가 5개 미만이면 최근 90일로 넓힙니다. 최신 5개보다 오래된 페이지는 조회를 중단하되 같은 날짜의 연결·정정 공시는 계속 확인합니다. 정정 전·철회·자회사 공시를 제외하고 같은 날 연결 잠정실적을 우선합니다.
- 잠정실적 원문의 재무금액을 확인해 판매대수만 발표한 공시는 제외합니다. 목록을 만드는 과정에서는 OpenAI를 호출하지 않습니다.
- 일시적인 통신 오류·HTTP 408/5xx는 한 번 재시도합니다. 원문 일부를 끝내 확인하지 못해도 다른 공시는 표시하고 부분 조회 안내를 제공합니다. 실패한 원문을 부적격으로 캐시하지 않으며, 부분 조회 결과는 1분 후 다시 수집할 수 있습니다. API 사용량 제한 등 DART 업무 오류와 HTTP 403/429는 즉시 재시도하지 않습니다.
- Redis·메모리·CDN에서 목록을 5분 캐시하고 브라우저도 메인 화면이 보일 때 5분마다 확인합니다. 수집 잠금은 Redis에서 공유하여 여러 서버·재배포 후에도 한 번만 수집합니다. 조회 실패 후에는 서버 전체가 1분 동안 재수집을 쉬며, 24시간 이내의 마지막 목록이 있으면 확인 시각과 함께 표시합니다. 수동 새로고침 버튼은 없으며 조회 실패·갱신 지연 시에만 ‘다시 시도’를 표시합니다.
- `dartClient.js`는 모든 웹 API의 DART 호출을 한곳에서 처리합니다. 인증키별로 Redis의 원자 연산을 사용해 요청 시작 간격을 1초 이상, 하루 전송 예약량을 8,000회 이하로 제한합니다(KST 날짜). 캐시 적중은 DART 호출로 세지 않습니다. 같은 키를 쓰는 외부 프로젝트·로컬 스크립트의 호출은 이 제한에 포함되지 않습니다.
- 목록·재무 API 응답은 5분, 접수번호별 ZIP 원문은 7일 동안 공유합니다. HTTP 403/429 또는 DART 011/012를 받으면 5분, DART 020을 받으면 다음 KST 날짜까지 추가 호출을 중지합니다. 공유 캐시 장애 시 운영 서버가 제한 장치를 우회해 DART를 직접 호출하지 않습니다.
- Vercel에는 무료 `finalyze-dart-cache`(Upstash Redis, 자동 유료 전환 비활성)를 연결했습니다. `KV_REST_API_URL`/`KV_REST_API_TOKEN` 또는 `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`을 사용합니다. 로컬은 해당 변수가 없으면 메모리 저장소를 사용하며 여러 프로세스를 통합하지 않습니다.
- `npm run check:recent-disclosures`는 실제 외부 API 호출 없이 선정·페이지 처리·KST 날짜·동시 요청·장애 복구를 검사합니다. `npm run check:public-pages`는 HTTP 응답과 공개 페이지를 검사합니다.
- `npm run check:dart-client`는 공유 응답·동시 요청·호출 속도·하루 한도·차단 응답·인증정보 비노출을 검사합니다.

## 공개 페이지와 검색엔진 확인

- `/`는 기업 검색·분석 화면, `/about`은 소개·사용법·분석 기준·FAQ입니다.
- `sitePages.js`가 공통 HTML에서 각 경로의 본문 표시 상태와 고유 메타데이터를 렌더링합니다. 공통 메타데이터는 `public/js/site-pages.js`에서 관리합니다.
- 기존 `/#about` 주소는 브라우저에서 `/about`으로 연결됩니다. 앱 안에서 이동할 때는 선택한 기업·공시를 유지합니다.
- 공개 URL 목록은 `public/sitemap.xml`에서 관리합니다. `lastmod`와 소개 문서 확인일은 실제 공개 내용이 변경된 날짜를 사용합니다.
- `npm run check:public-pages`로 HTTP 응답, 초기 HTML의 본문·메타데이터, 리디렉션과 사이트맵을 검사합니다. 외부 DART·OpenAI 호출은 하지 않습니다.
- Search Console 소유권 확인용 `public/google6cac55f830514a99.html`은 배포 후에도 유지해야 합니다. 실제 색인 여부·사이트맵 제출 상태는 Search Console과 Bing Webmaster Tools에서 별도로 확인합니다.
