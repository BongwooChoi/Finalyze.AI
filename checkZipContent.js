const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

// ZIP 파일 내용 확인 함수
function checkZipContent() {
  try {
    console.log('ZIP 파일 내용 확인 중...');
    
    // ZIP 파일 경로
    const zipFilePath = path.join(__dirname, 'corpCode.zip');
    
    // ZIP 파일이 존재하는지 확인
    if (!fs.existsSync(zipFilePath)) {
      console.error('회사 코드 ZIP 파일이 존재하지 않습니다.');
      return;
    }
    
    // ZIP 파일 내용 확인
    const zip = new AdmZip(zipFilePath);
    const zipEntries = zip.getEntries();
    
    console.log(`ZIP 파일 안에 총 ${zipEntries.length}개의 파일이 있습니다.`);
    
    // 각 파일의 정보 출력
    zipEntries.forEach((entry, index) => {
      console.log(`파일 ${index + 1}: ${entry.entryName} (${entry.header.size} 바이트)`);
      
      // XML 파일이면 내용의 일부를 출력
      if (entry.entryName.toLowerCase().endsWith('.xml')) {
        const xmlData = entry.getData().toString('utf8');
        console.log('XML 파일 내용 일부:');
        console.log(xmlData.substring(0, 500) + '...');
        
        // XML 파일 추출
        const xmlFilePath = path.join(__dirname, entry.entryName);
        fs.writeFileSync(xmlFilePath, xmlData);
        console.log(`XML 파일을 추출했습니다: ${xmlFilePath}`);
      }
    });
  } catch (error) {
    console.error('ZIP 파일 확인 중 오류 발생:', error);
  }
}

// 함수 실행
checkZipContent(); 