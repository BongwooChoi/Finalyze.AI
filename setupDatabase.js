const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// 데이터베이스 파일 경로
const dbPath = path.join(__dirname, 'dart.db');

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

// 테이블 생성 함수
function createTables(db) {
  return new Promise((resolve, reject) => {
    // 회사 정보 테이블 생성
    db.run(`
      CREATE TABLE IF NOT EXISTS companies (
        corp_code TEXT PRIMARY KEY,
        corp_name TEXT NOT NULL,
        corp_eng_name TEXT,
        stock_code TEXT,
        modify_date TEXT
      )
    `, (err) => {
      if (err) {
        reject(err);
        return;
      }
      
      // 재무제표 데이터 테이블 생성
      db.run(`
        CREATE TABLE IF NOT EXISTS financial_statements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          corp_code TEXT NOT NULL,
          bsns_year TEXT NOT NULL,
          reprt_code TEXT NOT NULL,
          fs_div TEXT NOT NULL,
          sj_div TEXT NOT NULL,
          account_nm TEXT NOT NULL,
          thstrm_amount TEXT,
          thstrm_add_amount TEXT,
          frmtrm_amount TEXT,
          frmtrm_add_amount TEXT,
          bfefrmtrm_amount TEXT,
          FOREIGN KEY (corp_code) REFERENCES companies (corp_code)
        )
      `, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  });
}

// JSON 파일에서 회사 정보 불러오기
function loadCompaniesFromJSON() {
  try {
    const corpCodePath = path.join(__dirname, 'corpCode.json');
    
    if (!fs.existsSync(corpCodePath)) {
      console.error('corpCode.json 파일이 존재하지 않습니다. 먼저 parseCorpCodeSimple.js를 실행하세요.');
      return null;
    }
    
    const jsonData = fs.readFileSync(corpCodePath, 'utf8');
    return JSON.parse(jsonData);
  } catch (error) {
    console.error('회사 정보 파일 로드 중 오류 발생:', error);
    return null;
  }
}

// 회사 정보 DB에 저장
function saveCompaniesToDB(db, companies) {
  return new Promise((resolve, reject) => {
    // 기존 데이터 확인
    db.get('SELECT COUNT(*) as count FROM companies', (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      
      if (row.count > 0) {
        console.log(`이미 ${row.count}개의 회사 정보가 DB에 저장되어 있습니다.`);
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
          INSERT INTO companies (corp_code, corp_name, corp_eng_name, stock_code, modify_date)
          VALUES (?, ?, ?, ?, ?)
        `);
        
        let counter = 0;
        
        companies.forEach((company, index) => {
          stmt.run(
            company.corp_code,
            company.corp_name,
            company.corp_eng_name,
            company.stock_code,
            company.modify_date,
            function(err) {
              if (err) {
                console.error(`회사 정보 저장 중 오류 발생 (${company.corp_name}):`, err);
              } else {
                counter++;
              }
              
              // 진행 상황 표시 (10,000개마다)
              if ((index + 1) % 10000 === 0 || index === companies.length - 1) {
                console.log(`${index + 1}/${companies.length} 회사 정보 처리 중...`);
              }
              
              // 모든 데이터 처리 완료시 트랜잭션 종료
              if (index === companies.length - 1) {
                db.run('COMMIT', (err) => {
                  if (err) {
                    reject(err);
                  } else {
                    console.log(`총 ${counter}개의 회사 정보가 DB에 저장되었습니다.`);
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

// 인덱스 생성
function createIndices(db) {
  return new Promise((resolve, reject) => {
    // 회사명 검색 인덱스
    db.run('CREATE INDEX IF NOT EXISTS idx_corp_name ON companies (corp_name)', (err) => {
      if (err) {
        reject(err);
        return;
      }
      
      // 종목코드 검색 인덱스
      db.run('CREATE INDEX IF NOT EXISTS idx_stock_code ON companies (stock_code)', (err) => {
        if (err) {
          reject(err);
          return;
        }
        
        // 재무제표 검색 인덱스
        db.run('CREATE INDEX IF NOT EXISTS idx_financial_corp_code ON financial_statements (corp_code)', (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    });
  });
}

// 메인 함수
async function setupDatabase() {
  const db = connectDB();
  
  try {
    console.log('데이터베이스 테이블 생성 중...');
    await createTables(db);
    
    console.log('회사 정보를 JSON 파일에서 로드 중...');
    const companies = loadCompaniesFromJSON();
    
    if (companies) {
      console.log('회사 정보를 DB에 저장 중...');
      await saveCompaniesToDB(db, companies);
      
      console.log('인덱스 생성 중...');
      await createIndices(db);
      
      console.log('데이터베이스 설정이 완료되었습니다.');
    }
  } catch (error) {
    console.error('데이터베이스 설정 중 오류 발생:', error);
  } finally {
    db.close((err) => {
      if (err) {
        console.error('데이터베이스 연결 종료 오류:', err.message);
      } else {
        console.log('데이터베이스 연결이 종료되었습니다.');
      }
    });
  }
}

// 스크립트가 직접 실행될 때만 수행
if (require.main === module) {
  setupDatabase();
}

module.exports = {
  connectDB,
  createTables,
  createIndices
}; 