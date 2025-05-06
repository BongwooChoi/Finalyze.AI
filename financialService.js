const axios = require('axios');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const sqlite3 = require('sqlite3').verbose();

// 데이터베이스 파일 경로
const dbPath = path.join(__dirname, 'dart.db');

// API 키
const apiKey = config.OPEN_DART_API_KEY;

// 재무제표 코드 매핑
const REPORT_CODE = {
  '1분기보고서': '11013',
  '반기보고서': '11012',
  '3분기보고서': '11014',
  '사업보고서': '11011'
};

// 재무제표 구분 매핑
const FS_DIV = {
  '재무상태표': 'BS',
  '손익계산서': 'IS'
};

// 회사 이름으로 고유번호 검색
function searchCompanyByName(db, companyName) {
  return new Promise((resolve, reject) => {
    // 부분 일치 검색 (LIKE 연산자 사용)
    const query = `SELECT * FROM companies WHERE corp_name LIKE ? ORDER BY modify_date DESC LIMIT 10`;
    db.all(query, [`%${companyName}%`], (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

// 종목 코드로 고유번호 검색
function searchCompanyByStockCode(db, stockCode) {
  return new Promise((resolve, reject) => {
    const query = `SELECT * FROM companies WHERE stock_code = ? LIMIT 1`;
    db.get(query, [stockCode], (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row);
      }
    });
  });
}

// 단일회사 주요계정 데이터 가져오기
async function fetchFinancialStatements(corpCode, bsnsYear, reprtCode) {
  try {
    console.log(`${corpCode} 회사의 ${bsnsYear}년 재무제표 데이터를 가져오는 중...`);
    
    if (!apiKey) {
      console.error('DART API 키가 설정되지 않았습니다. config.js 파일을 확인하세요.');
      throw new Error('DART API 키가 설정되지 않았습니다.');
    }
    
    const url = 'https://opendart.fss.or.kr/api/fnlttSinglAcnt.json';
    
    console.log(`DART API 요청 파라미터: corpCode=${corpCode}, bsnsYear=${bsnsYear}, reprtCode=${reprtCode}`);
    
    const response = await axios.get(url, {
      params: {
        crtfc_key: apiKey,
        corp_code: corpCode,
        bsns_year: bsnsYear,
        reprt_code: reprtCode
      },
      timeout: 15000 // 15초 타임아웃 설정
    });
    
    console.log(`DART API 응답 상태 코드: ${response.status}, 응답 데이터 status: ${response.data.status}`);
    
    if (response.data.status === '000') {
      if (response.data.list && response.data.list.length > 0) {
        console.log(`${response.data.list.length}개의 재무제표 항목을 가져왔습니다.`);
        return response.data.list;
      } else {
        console.warn(`${corpCode} 회사의 ${bsnsYear}년 재무제표 데이터가 없습니다. (응답 list가 비어있음)`);
        return [];
      }
    } else if (response.data.status === '013') {
      console.warn(`${corpCode} 회사의 ${bsnsYear}년에 해당하는 데이터가 없습니다. (DART API status: 013)`);
      return [];
    } else {
      console.error('DART API로부터 오류 응답 수신:', response.data);
      throw new Error(`DART API 오류 (${response.data.status}): ${response.data.message || '알 수 없는 DART API 오류'}`);
    }
  } catch (error) {
    if (error.response) {
      console.error('DART API 요청 실패 (HTTP 에러 응답):', error.response.status, error.response.data);
      throw new Error(`DART API 서버 응답 오류 (${error.response.status}): ${error.response.data.message || '내용 없음'}`);
    } else if (error.code === 'ECONNABORTED') {
      console.error('DART API 요청 타임아웃:', error.message);
      throw new Error('DART API 요청 시간이 초과되었습니다. 나중에 다시 시도해주세요.');
    } else if (error.request) {
      console.error('DART API 네트워크 오류 (요청은 했으나 응답 없음):', error.message);
      throw new Error(`DART API 네트워크 오류: ${error.message}`);
    } else {
      console.error('DART API 호출 중 예기치 않은 오류 발생:', error.message);
      throw new Error(`재무제표 데이터 조회 준비 중 오류: ${error.message}`);
    }
  }
}

// 재무제표 데이터 DB에 저장
function saveFinancialStatementsToDB(db, corpCode, bsnsYear, reprtCode, statements) {
  return new Promise((resolve, reject) => {
    // 기존 데이터 확인 (중복 방지)
    const checkQuery = `
      SELECT COUNT(*) as count FROM financial_statements 
      WHERE corp_code = ? AND bsns_year = ? AND reprt_code = ?
    `;
    
    db.get(checkQuery, [corpCode, bsnsYear, reprtCode], (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      
      if (row.count > 0) {
        console.log(`이미 ${row.count}개의 재무제표 항목이 DB에 저장되어 있습니다.`);
        resolve(row.count);
        return;
      }
      
      // 트랜잭션 시작
      db.run('BEGIN TRANSACTION', (err) => {
        if (err) {
          reject(err);
          return;
        }
        
        const stmt = db.prepare(`
          INSERT INTO financial_statements (
            corp_code, bsns_year, reprt_code, fs_div, sj_div, account_nm, 
            thstrm_amount, thstrm_add_amount, frmtrm_amount, frmtrm_add_amount, bfefrmtrm_amount
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        let counter = 0;
        
        statements.forEach((item, index) => {
          stmt.run(
            corpCode,
            bsnsYear,
            reprtCode,
            item.fs_div,
            item.sj_div,
            item.account_nm,
            item.thstrm_amount,
            item.thstrm_add_amount,
            item.frmtrm_amount,
            item.frmtrm_add_amount,
            item.bfefrmtrm_amount,
            function(err) {
              if (err) {
                console.error(`재무제표 항목 저장 중 오류 발생 (${item.account_nm}):`, err);
              } else {
                counter++;
              }
              
              // 모든 데이터 처리 완료시 트랜잭션 종료
              if (index === statements.length - 1) {
                db.run('COMMIT', (err) => {
                  if (err) {
                    reject(err);
                  } else {
                    console.log(`총 ${counter}개의 재무제표 항목이 DB에 저장되었습니다.`);
                    resolve(counter);
                  }
                });
              }
            }
          );
        });
        
        stmt.finalize();
      });
    });
  });
}

// 재무제표 데이터 조회
function getFinancialStatements(db, corpCode, bsnsYear, reprtCode, sjDiv) {
  return new Promise((resolve, reject) => {
    let query = `
      SELECT * FROM financial_statements 
      WHERE corp_code = ? AND bsns_year = ? AND reprt_code = ?
    `;
    
    const params = [corpCode, bsnsYear, reprtCode];
    
    if (sjDiv) {
      query += ` AND sj_div = ?`;
      params.push(sjDiv);
    }
    
    // 정렬 추가
    query += ` ORDER BY id`;
    
    db.all(query, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

// 특정 계정과목 데이터 가져오기 (예: 당기순이익, 매출액 등)
function getSpecificAccount(db, corpCode, accountName, years) {
  return new Promise(async (resolve, reject) => {
    try {
      const results = [];
      
      // 각 연도별로 데이터 조회
      for (const year of years) {
        // 사업보고서(11011)에서 먼저 조회 시도
        let rows = await getAccountDataForYear(db, corpCode, accountName, year, '11011');
        
        // 사업보고서에 데이터가 없으면 다른 보고서 유형도 확인
        if (!rows || rows.length === 0) {
          // 분기/반기 보고서 순서대로 시도
          const reportCodes = ['11014', '11012', '11013']; // 3분기, 반기, 1분기 순
          
          for (const reportCode of reportCodes) {
            rows = await getAccountDataForYear(db, corpCode, accountName, year, reportCode);
            if (rows && rows.length > 0) break;
          }
        }
        
        if (rows && rows.length > 0) {
          results.push({
            bsns_year: year,
            account_nm: accountName,
            thstrm_amount: rows[0].thstrm_amount
          });
        } else {
          console.log(`${corpCode}의 ${year}년 ${accountName} 데이터가 없습니다.`);
        }
      }
      
      resolve(results);
    } catch (err) {
      reject(err);
    }
  });
}

// 특정 연도, 특정 보고서 코드에 대한 계정과목 데이터 조회 (내부 헬퍼 함수)
function getAccountDataForYear(db, corpCode, accountName, year, reportCode) {
  return new Promise((resolve, reject) => {
    const query = `
      SELECT bsns_year, account_nm, thstrm_amount 
      FROM financial_statements 
      WHERE corp_code = ? AND account_nm = ? AND bsns_year = ? AND reprt_code = ?
      LIMIT 1
    `;
    
    db.all(query, [corpCode, accountName, year, reportCode], (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

// 데이터베이스 연결
function connectDB() {
  return new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.error('데이터베이스 연결 오류:', err.message);
    } else {
      console.log('SQLite 데이터베이스에 연결되었습니다.');
    }
  });
}

module.exports = {
  connectDB,
  fetchFinancialStatements,
  getSpecificAccount,
  searchCompanyByName,
  searchCompanyByStockCode,
  REPORT_CODE,
  FS_DIV
}; 