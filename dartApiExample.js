// dartApiExample.js
// OPEN DART API를 사용하는 예시 파일

const axios = require('axios');
const config = require('./config');

// API 키 가져오기
const apiKey = config.OPEN_DART_API_KEY;

// OPEN DART API 호출 예시 함수
async function getDartData(corpCode) {
  try {
    const response = await axios.get(`https://opendart.fss.or.kr/api/company.json`, {
      params: {
        crtfc_key: apiKey,
        corp_code: corpCode
      }
    });
    
    return response.data;
  } catch (error) {
    console.error('DART API 호출 중 오류 발생:', error);
    throw error;
  }
}

// 사용 예시
async function main() {
  try {
    // 특정 회사의 정보를 가져오는 예시 (삼성전자 코드로 대체하세요)
    const corpCode = '00000000'; // 실제 회사 코드로 변경 필요
    const data = await getDartData(corpCode);
    console.log('회사 정보:', data);
  } catch (error) {
    console.error('오류:', error);
  }
}

// 스크립트가 직접 실행될 때만 main 함수 호출
if (require.main === module) {
  main();
}

module.exports = {
  getDartData
}; 