const fs = require('fs');
const path = require('path');
const { DOMParser } = require('@xmldom/xmldom');

// 회사 코드 파싱 함수
function parseCorpCodeFile() {
  try {
    console.log('회사 코드 XML 파일 파싱 중...');
    
    // XML 파일 경로
    const xmlFilePath = path.join(__dirname, 'CORPCODE.xml');
    
    // XML 파일이 존재하는지 확인
    if (!fs.existsSync(xmlFilePath)) {
      console.error('CORPCODE.xml 파일이 존재하지 않습니다.');
      return null;
    }
    
    // XML 파일 읽기
    const xmlData = fs.readFileSync(xmlFilePath, 'utf8');
    
    // DOM 파서를 사용하여 XML 파싱
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlData, 'text/xml');
    
    // 회사 정보 목록 추출
    const listElements = doc.getElementsByTagName('list');
    const corpList = [];
    
    console.log(`총 ${listElements.length}개의 회사 정보를 찾았습니다.`);
    
    // 각 회사 정보 추출
    for (let i = 0; i < listElements.length; i++) {
      const listElement = listElements[i];
      
      const getElementText = (tagName) => {
        const elements = listElement.getElementsByTagName(tagName);
        return elements.length > 0 ? elements[0].textContent : '';
      };
      
      const corp = {
        corp_code: getElementText('corp_code'),
        corp_name: getElementText('corp_name'),
        corp_eng_name: getElementText('corp_eng_name'),
        stock_code: getElementText('stock_code').trim(),
        modify_date: getElementText('modify_date')
      };
      
      corpList.push(corp);
      
      // 진행 상황 표시 (10,000개마다)
      if ((i + 1) % 10000 === 0 || i === listElements.length - 1) {
        console.log(`${i + 1}/${listElements.length} 회사 정보 처리 중...`);
      }
    }
    
    // JSON 파일로 저장
    const jsonFilePath = path.join(__dirname, 'corpCode.json');
    fs.writeFileSync(jsonFilePath, JSON.stringify(corpList, null, 2));
    
    console.log(`회사 코드 정보가 JSON 파일로 저장되었습니다: ${jsonFilePath}`);
    
    // 상장 회사만 필터링 (stock_code가 있는 회사)
    const listedCorps = corpList.filter(corp => corp.stock_code && corp.stock_code !== '');
    console.log(`그 중 상장 회사는 ${listedCorps.length}개입니다.`);
    
    // 상장 회사 정보만 별도 JSON 파일로 저장
    const listedJsonFilePath = path.join(__dirname, 'listedCorpCode.json');
    fs.writeFileSync(listedJsonFilePath, JSON.stringify(listedCorps, null, 2));
    
    console.log(`상장 회사 정보가 JSON 파일로 저장되었습니다: ${listedJsonFilePath}`);
    
    return corpList;
  } catch (error) {
    console.error('회사 코드 파일 파싱 중 오류 발생:', error);
    return null;
  }
}

// 함수 실행
parseCorpCodeFile(); 