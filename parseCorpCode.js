const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const xml2js = require('xml2js');

// ZIP 파일 압축 해제 및 XML 파싱 함수
async function parseCorpCodeFile() {
  try {
    console.log('회사 코드 XML 파일 파싱 중...');
    
    // ZIP 파일 경로
    const zipFilePath = path.join(__dirname, 'corpCode.zip');
    
    // ZIP 파일이 존재하는지 확인
    if (!fs.existsSync(zipFilePath)) {
      console.error('회사 코드 ZIP 파일이 존재하지 않습니다. 먼저 downloadCorpCode.js를 실행하세요.');
      return null;
    }
    
    // ZIP 파일 압축 해제
    const zip = new AdmZip(zipFilePath);
    const zipEntries = zip.getEntries();
    
    // XML 파일 찾기 (일반적으로 'CORPCODE.xml'이라는 이름으로 저장됨)
    const xmlEntry = zipEntries.find(entry => entry.entryName.toLowerCase().endsWith('.xml'));
    
    if (!xmlEntry) {
      console.error('ZIP 파일 내에 XML 파일이 없습니다.');
      return null;
    }
    
    // XML 파일 내용 가져오기
    const xmlData = xmlEntry.getData().toString('utf8');
    
    // XML 파싱
    const parser = new xml2js.Parser({ explicitArray: true });
    const result = await parser.parseStringPromise(xmlData);
    
    // 확인된 XML 구조에 따라 데이터 추출
    if (result.r && result.r.list) {
      const corpList = result.r.list;
      
      console.log(`총 ${corpList.length}개의 회사 정보를 찾았습니다.`);
      
      // 데이터 정리 (배열 안의 배열 구조 단순화)
      const cleanedCorpList = corpList.map(item => {
        return {
          corp_code: item.corp_code ? item.corp_code[0] : '',
          corp_name: item.corp_name ? item.corp_name[0] : '',
          corp_eng_name: item.corp_eng_name ? item.corp_eng_name[0] : '',
          stock_code: item.stock_code ? item.stock_code[0].trim() : '',
          modify_date: item.modify_date ? item.modify_date[0] : ''
        };
      });
      
      // JSON 파일로 저장
      const jsonFilePath = path.join(__dirname, 'corpCode.json');
      fs.writeFileSync(jsonFilePath, JSON.stringify(cleanedCorpList, null, 2));
      
      console.log(`회사 코드 정보가 JSON 파일로 저장되었습니다: ${jsonFilePath}`);
      
      // 상장 회사만 필터링 (stock_code가 있는 회사)
      const listedCorps = cleanedCorpList.filter(corp => corp.stock_code && corp.stock_code.trim() !== '');
      console.log(`그 중 상장 회사는 ${listedCorps.length}개입니다.`);
      
      // 상장 회사 정보만 별도 JSON 파일로 저장
      const listedJsonFilePath = path.join(__dirname, 'listedCorpCode.json');
      fs.writeFileSync(listedJsonFilePath, JSON.stringify(listedCorps, null, 2));
      
      console.log(`상장 회사 정보가 JSON 파일로 저장되었습니다: ${listedJsonFilePath}`);
      
      return cleanedCorpList;
    } else {
      console.error('XML 파일에서 회사 코드 목록을 찾을 수 없습니다.');
      return null;
    }
  } catch (error) {
    console.error('회사 코드 파일 파싱 중 오류 발생:', error);
    return null;
  }
}

// 스크립트가 직접 실행될 때만 함수 호출
if (require.main === module) {
  parseCorpCodeFile();
}

module.exports = {
  parseCorpCodeFile
}; 