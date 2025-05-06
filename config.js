// config.js
// dotenv 라이브러리를 사용하여 .env 파일에서 환경 변수를 로드합니다.
// 프로젝트에 dotenv를 설치해야 합니다: npm install dotenv

// 강제로 .env 파일을 로드합니다
require('dotenv').config({ override: true });

// 환경 변수 설정
const config = {
  OPEN_DART_API_KEY: process.env.OPEN_DART_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || 'your_gemini_api_key_here' // Gemini API 키 추가
};

// 환경 변수가 설정되어 있는지 확인
if (!config.OPEN_DART_API_KEY) {
  console.warn('경고: OPEN_DART_API_KEY가 설정되지 않았습니다.');
}

if (!config.GEMINI_API_KEY) {
  console.warn('경고: GEMINI_API_KEY가 설정되지 않았습니다.');
}

console.log('환경변수 로드 상태:');
console.log('OPEN_DART_API_KEY:', config.OPEN_DART_API_KEY ? '설정됨' : '설정되지 않음');
console.log('GEMINI_API_KEY:', config.GEMINI_API_KEY ? '설정됨' : '설정되지 않음');

module.exports = config; 