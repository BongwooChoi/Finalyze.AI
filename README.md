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