const fs = require('fs');
const path = require('path');

// 회사 이름으로 검색하는 함수
function searchByCorpName(searchTerm) {
  try {
    // JSON 파일 경로
    const jsonFilePath = path.join(__dirname, 'corpCode.json');
    
    // JSON 파일이 존재하는지 확인
    if (!fs.existsSync(jsonFilePath)) {
      console.error('corpCode.json 파일이 존재하지 않습니다. 먼저 parseCorpCodeSimple.js를 실행하세요.');
      return [];
    }
    
    // JSON 파일 읽기
    const jsonData = fs.readFileSync(jsonFilePath, 'utf8');
    const corpList = JSON.parse(jsonData);
    
    // 검색어가 회사 이름에 포함되는 항목 찾기 (대소문자 구분 없이)
    const searchTermLower = searchTerm.toLowerCase();
    const results = corpList.filter(corp => {
      const corpNameLower = corp.corp_name.toLowerCase();
      const corpEngNameLower = corp.corp_eng_name.toLowerCase();
      
      return corpNameLower.includes(searchTermLower) || corpEngNameLower.includes(searchTermLower);
    });
    
    return results;
  } catch (error) {
    console.error('회사 검색 중 오류 발생:', error);
    return [];
  }
}

// 종목 코드로 검색하는 함수
function searchByStockCode(stockCode) {
  try {
    // JSON 파일 경로 (상장 회사만 있는 파일 사용)
    const jsonFilePath = path.join(__dirname, 'listedCorpCode.json');
    
    // JSON 파일이 존재하는지 확인
    if (!fs.existsSync(jsonFilePath)) {
      console.error('listedCorpCode.json 파일이 존재하지 않습니다. 먼저 parseCorpCodeSimple.js를 실행하세요.');
      return null;
    }
    
    // JSON 파일 읽기
    const jsonData = fs.readFileSync(jsonFilePath, 'utf8');
    const corpList = JSON.parse(jsonData);
    
    // 종목 코드가 일치하는 항목 찾기
    const result = corpList.find(corp => corp.stock_code === stockCode);
    
    return result || null;
  } catch (error) {
    console.error('종목 코드 검색 중 오류 발생:', error);
    return null;
  }
}

// 명령줄 인수 처리
function handleCommandLineArgs() {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.log('사용법:');
    console.log('  node searchCorpCode.js -n "회사이름"   // 회사 이름으로 검색');
    console.log('  node searchCorpCode.js -c "종목코드"   // 종목 코드로 검색');
    return;
  }
  
  const option = args[0];
  const searchTerm = args[1];
  
  if (!searchTerm) {
    console.error('검색어를 입력하세요.');
    return;
  }
  
  if (option === '-n') {
    // 회사 이름으로 검색
    const results = searchByCorpName(searchTerm);
    
    if (results.length === 0) {
      console.log(`"${searchTerm}" 검색 결과가 없습니다.`);
    } else {
      console.log(`"${searchTerm}" 검색 결과: ${results.length}개 회사 발견`);
      results.forEach((corp, index) => {
        console.log(`\n${index + 1}. ${corp.corp_name} (${corp.corp_eng_name})`);
        console.log(`   고유번호: ${corp.corp_code}`);
        console.log(`   종목코드: ${corp.stock_code || '상장되지 않음'}`);
        console.log(`   최종변경일자: ${corp.modify_date}`);
      });
    }
  } else if (option === '-c') {
    // 종목 코드로 검색
    const result = searchByStockCode(searchTerm);
    
    if (!result) {
      console.log(`종목코드 "${searchTerm}"에 해당하는 회사가 없습니다.`);
    } else {
      console.log(`종목코드 "${searchTerm}" 검색 결과:`);
      console.log(`회사명: ${result.corp_name} (${result.corp_eng_name})`);
      console.log(`고유번호: ${result.corp_code}`);
      console.log(`종목코드: ${result.stock_code}`);
      console.log(`최종변경일자: ${result.modify_date}`);
    }
  } else {
    console.error('잘못된 옵션입니다. -n 또는 -c를 사용하세요.');
  }
}

// 명령줄에서 실행될 때만 인수 처리
if (require.main === module) {
  handleCommandLineArgs();
}

module.exports = {
  searchByCorpName,
  searchByStockCode
}; 