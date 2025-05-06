const axios = require('axios');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// API 키 가져오기
const apiKey = config.OPEN_DART_API_KEY;

// 회사 코드 파일 다운로드 함수
async function downloadCorpCodeFile() {
  try {
    console.log('회사 코드 파일 다운로드 중...');
    
    // 저장할 파일 경로
    const downloadPath = path.join(__dirname, 'corpCode.zip');
    
    // axios로 파일 다운로드 (responseType: 'arraybuffer'로 바이너리 데이터 받기)
    const response = await axios({
      method: 'GET',
      url: 'https://opendart.fss.or.kr/api/corpCode.xml',
      params: {
        crtfc_key: apiKey
      },
      responseType: 'arraybuffer'
    });
    
    // 파일로 저장
    fs.writeFileSync(downloadPath, response.data);
    
    console.log(`회사 코드 파일이 성공적으로 다운로드 되었습니다: ${downloadPath}`);
    console.log('이 zip 파일을 압축 해제하면 회사 코드 정보가 담긴 XML 파일을 볼 수 있습니다.');
  } catch (error) {
    if (error.response) {
      console.error('회사 코드 파일 다운로드 실패:', error.response.status, error.response.statusText);
      
      // 오류 코드에 따른 메시지 표시
      const errorCodes = {
        '010': '등록되지 않은 키입니다.',
        '011': '사용할 수 없는 키입니다. 오픈API에 등록되었으나, 일시적으로 사용 중지된 키입니다.',
        '012': '접근할 수 없는 IP입니다.',
        '013': '조회된 데이타가 없습니다.',
        '014': '파일이 존재하지 않습니다.',
        '020': '요청 제한을 초과하였습니다.',
        '021': '조회 가능한 회사 개수가 초과하였습니다.(최대 100건)',
        '100': '필드의 부적절한 값입니다.',
        '101': '부적절한 접근입니다.',
        '800': '시스템 점검으로 인한 서비스가 중지 중입니다.',
        '900': '정의되지 않은 오류가 발생하였습니다.',
        '901': '사용자 계정의 개인정보 보유기간이 만료되어 사용할 수 없는 키입니다.'
      };
      
      if (error.response.data) {
        try {
          const data = JSON.parse(Buffer.from(error.response.data).toString());
          console.error('오류 메시지:', data.message);
          console.error('오류 상태:', data.status, '-', errorCodes[data.status] || '알 수 없는 오류');
        } catch (e) {
          console.error('상세 오류 정보를 파싱할 수 없습니다.');
        }
      }
    } else {
      console.error('회사 코드 파일 다운로드 중 오류 발생:', error.message);
    }
  }
}

// 스크립트가 직접 실행될 때만 함수 호출
if (require.main === module) {
  downloadCorpCodeFile();
}

module.exports = {
  downloadCorpCodeFile
}; 