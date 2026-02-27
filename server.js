const express = require('express');
const path = require('path');
const financialService = require('./financialService');
const axios = require('axios');
const dotenv = require('dotenv');
const config = require('./config');

// 환경변수 로드
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// 정적 파일 제공
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// 데이터베이스 연결
const db = financialService.connectDB();

// REPORT_CODE 상수 가져오기 (클라이언트에서 보고서 이름을 표시하기 위함)
const REPORT_CODE_MAP = financialService.REPORT_CODE;
const REVERSE_REPORT_CODE_MAP = Object.fromEntries(Object.entries(REPORT_CODE_MAP).map(([key, value]) => [value, key]));

// 금융회사 판별 키워드
const FINANCIAL_COMPANY_KEYWORDS = ['금융', '은행', '보험', '증권', '캐피탈', '카드', '투자', '자산운용', '저축은행', '생명', '화재', '손해'];

// 금융회사 여부 판별 함수
function isFinancialCompany(companyName) {
  if (!companyName) return false;
  return FINANCIAL_COMPANY_KEYWORDS.some(keyword => companyName.includes(keyword));
}

// 일반 기업 재무제표 계정명
const GENERAL_BS_ITEMS = ['자산총계', '부채총계', '자본총계', '유동자산', '비유동자산', '유동부채', '비유동부채'];
const GENERAL_IS_ITEMS = ['매출액', '영업이익', '법인세비용차감전순이익', '당기순이익'];

// 금융회사 재무제표 계정명 (은행, 보험, 증권 등)
const FINANCIAL_BS_ITEMS = ['자산총계', '부채총계', '자본총계', '현금및예치금', '대출채권', '유가증권', '책임준비금'];
const FINANCIAL_IS_ITEMS = [
  // 수익 관련 (매출액 대체)
  { name: '영업수익', aliases: ['영업수익', '순영업수익', '이자수익', '순이자손익', '보험료수익'] },
  // 영업이익
  { name: '영업이익', aliases: ['영업이익', '영업손익'] },
  // 법인세비용차감전순이익
  { name: '법인세비용차감전순이익', aliases: ['법인세비용차감전순이익', '법인세비용차감전순손익', '법인세비용차감전계속사업이익'] },
  // 당기순이익
  { name: '당기순이익', aliases: ['당기순이익', '당기순손익', '분기순이익', '반기순이익'] }
];

// 메인 페이지
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 회사명으로 검색하는 API
app.get('/api/companies/search', async (req, res) => {
  try {
    const keyword = req.query.keyword;
    
    if (!keyword || keyword.length < 2) {
      return res.status(400).json({ 
        status: 'error', 
        message: '검색어는 2글자 이상 입력해주세요.' 
      });
    }
    
    const companies = await financialService.searchCompanyByName(db, keyword);
    
    res.json({
      status: 'success',
      data: companies
    });
  } catch (error) {
    console.error('회사 검색 중 오류 발생:', error);
    res.status(500).json({ 
      status: 'error', 
      message: '서버 오류가 발생했습니다.' 
    });
  }
});

// 주식 코드로 회사 정보 가져오기
app.get('/api/companies/stock/:stockCode', async (req, res) => {
  try {
    const stockCode = req.params.stockCode;
    
    if (!stockCode) {
      return res.status(400).json({ 
        status: 'error', 
        message: '종목 코드를 입력해주세요.' 
      });
    }
    
    const company = await financialService.searchCompanyByStockCode(db, stockCode);
    
    if (!company) {
      return res.status(404).json({ 
        status: 'error', 
        message: '해당 종목 코드의 회사를 찾을 수 없습니다.' 
      });
    }
    
    res.json({
      status: 'success',
      data: company
    });
  } catch (error) {
    console.error('종목 코드 검색 중 오류 발생:', error);
    res.status(500).json({ 
      status: 'error', 
      message: '서버 오류가 발생했습니다.' 
    });
  }
});

// 회사의 사용 가능한 사업연도 및 보고서 유형 조회 API
app.get('/api/company-report-options/:corpCode', async (req, res) => {
  try {
    const corpCode = req.params.corpCode;

    if (!corpCode) {
      return res.status(400).json({
        status: 'error',
        message: '회사 코드가 필요합니다.'
      });
    }

    // financial_statements 테이블에서 해당 회사의 모든 bsns_year와 reprt_code를 조회
    // Vercel 환경에서는 DB에 데이터가 없을 수 있으므로,
    // 이 API는 실제 DART API를 호출해서 해당 회사가 어떤 연도/보고서 공시를 했는지
    // 확인하는 로직이 더 적합할 수 있으나, 현재 구조에서는 DB 우선 조회.
    // TODO: 장기적으로는 DART API를 통해 특정 기업의 공시 목록을 가져오는 기능 추가 고려
    const query = `
      SELECT DISTINCT bsns_year, reprt_code 
      FROM financial_statements 
      WHERE corp_code = ? 
      ORDER BY bsns_year DESC, reprt_code ASC
    `;

    db.all(query, [corpCode], (err, rows) => {
      if (err) {
        console.error('보고서 옵션 조회 중 DB 오류:', err);
        return res.status(500).json({
          status: 'error',
          message: '데이터베이스 오류가 발생했습니다.'
        });
      }

      if (rows.length === 0) {
        // DB에 데이터가 없는 경우, 기본값 (최근 5년, 모든 보고서 유형) 제공 또는 에러 처리
        // 여기서는 빈 결과를 반환하여 클라이언트에서 기본값을 사용하도록 유도할 수 있음
        // 또는 DART API를 통해 직접 조회하는 로직 추가 (구현 복잡도 증가)
        console.warn(`보고서 옵션 조회: ${corpCode}에 대한 데이터가 DB에 없습니다.`);
        // 기본 옵션 (최근 5년, 모든 보고서 유형)을 제공해볼 수 있음
        const currentYear = new Date().getFullYear();
        const defaultYears = Array.from({ length: 5 }, (_, i) => String(currentYear - i));
        const defaultReportTypes = Object.keys(REPORT_CODE_MAP); // 또는 값인 코드 ['11011', '11012', ...]

        const reportTypesByYear = {};
        defaultYears.forEach(year => {
          reportTypesByYear[year] = defaultReportTypes.map(name => ({
            code: REPORT_CODE_MAP[name],
            name: name
          }));
        });
        
        return res.json({
          status: 'success',
          data: {
            years: defaultYears,
            reportTypesByYear: reportTypesByYear,
            isDefault: true // 기본값 사용 여부 플래그
          }
        });
      }

      const years = [...new Set(rows.map(row => row.bsns_year))].sort((a, b) => b - a); // 중복 제거 및 내림차순 정렬
      const reportTypesByYear = {};

      rows.forEach(row => {
        if (!reportTypesByYear[row.bsns_year]) {
          reportTypesByYear[row.bsns_year] = [];
        }
        reportTypesByYear[row.bsns_year].push({
          code: row.reprt_code,
          name: REVERSE_REPORT_CODE_MAP[row.reprt_code] || '알수없음' // 코드를 이름으로 변환
        });
      });
      
      // 각 연도별 보고서 유형 정렬 (예: 사업보고서 우선)
      for (const year in reportTypesByYear) {
        reportTypesByYear[year].sort((a, b) => {
          // 정렬 순서 (예: 사업보고서 > 반기 > 3분기 > 1분기)
          const order = {'11011': 1, '11012': 2, '11014': 3, '11013': 4};
          return (order[a.code] || 99) - (order[b.code] || 99);
        });
      }

      res.json({
        status: 'success',
        data: {
          years: years,
          reportTypesByYear: reportTypesByYear,
          isDefault: false
        }
      });
    });

  } catch (error) {
    console.error('보고서 옵션 조회 API 오류:', error);
    res.status(500).json({
      status: 'error',
      message: '서버 오류가 발생했습니다.'
    });
  }
});

// 재무제표 데이터 가져오기
app.get('/api/financial-statements', async (req, res) => {
  try {
    const { corp_code, bsns_year, reprt_code } = req.query;
    
    if (!corp_code || !bsns_year || !reprt_code) {
      return res.status(400).json({ 
        status: 'error', 
        message: '회사 고유번호, 사업연도, 보고서 코드는 필수 입력값입니다.' 
      });
    }
    
    // DB에서 해당 재무제표 데이터 조회
    let financialStatements = await financialService.getFinancialStatements(
      db, corp_code, bsns_year, reprt_code
    );
    
    // DB에 데이터가 없는 경우 DART API에서 가져와서 저장
    if (financialStatements.length === 0) {
      const newData = await financialService.fetchFinancialStatements(
        corp_code, bsns_year, reprt_code
      );
      
      if (newData) {
        await financialService.saveFinancialStatementsToDB(
          db, corp_code, bsns_year, reprt_code, newData
        );
        
        // 저장 후 다시 조회
        financialStatements = await financialService.getFinancialStatements(
          db, corp_code, bsns_year, reprt_code
        );
      }
    }
    
    // 재무제표별로 데이터 그룹화
    const grouped = {};
    
    financialStatements.forEach(item => {
      const key = item.sj_div;
      if (!grouped[key]) {
        grouped[key] = [];
      }
      grouped[key].push(item);
    });
    
    res.json({
      status: 'success',
      data: grouped
    });
  } catch (error) {
    console.error('재무제표 조회 중 오류 발생:', error);
    res.status(500).json({ 
      status: 'error', 
      message: '서버 오류가 발생했습니다.' 
    });
  }
});

// 특정 계정과목의 연도별 데이터 가져오기 (차트 데이터용)
app.get('/api/financial-trend', async (req, res) => {
  try {
    const { corp_code, account_nm } = req.query;
    let { years } = req.query;
    
    if (!corp_code || !account_nm) {
      return res.status(400).json({ 
        status: 'error', 
        message: '회사 고유번호와 계정과목은 필수 입력값입니다.' 
      });
    }
    
    // 연도가 없는 경우 최근 5년으로 설정
    if (!years) {
      const currentYear = new Date().getFullYear();
      years = Array.from({ length: 5 }, (_, i) => String(currentYear - 4 + i));
    } else if (typeof years === 'string') {
      years = years.split(',');
    }
    
    console.log(`트렌드 API - ${corp_code} 회사의 ${account_nm} 데이터 조회, 대상 연도: ${years.join(',')}`);
    
    // 계정과목 데이터 조회
    const accountData = await financialService.getSpecificAccount(
      db, corp_code, account_nm, years
    );
    
    console.log(`트렌드 API - 조회 결과: ${accountData.length}개 연도 데이터 발견`);
    
    // 차트 데이터 형식으로 변환
    const chartData = {
      labels: years,
      datasets: [{
        label: account_nm,
        data: []
      }]
    };
    
    // 연도별 데이터 매핑
    years.forEach(year => {
      const yearData = accountData.find(item => item.bsns_year === year);
      if (yearData) {
        // 금액 문자열에서 쉼표 제거하고 숫자로 변환
        const amount = parseInt(yearData.thstrm_amount.replace(/,/g, ''));
        chartData.datasets[0].data.push(amount);
      } else {
        // 데이터가 없는 경우 null 처리
        chartData.datasets[0].data.push(null);
      }
    });
    
    // 유효한 데이터가 하나라도 있는지 확인
    const hasValidData = chartData.datasets[0].data.some(value => value !== null);
    
    if (!hasValidData) {
      console.warn(`트렌드 API - ${corp_code} 회사의 ${account_nm} 유효한 데이터가 없습니다.`);
      return res.status(404).json({ 
        status: 'error', 
        message: '해당 계정과목의 데이터가 없습니다.' 
      });
    }
    
    res.json({
      status: 'success',
      data: chartData
    });
  } catch (error) {
    console.error('재무 트렌드 조회 중 오류 발생:', error);
    res.status(500).json({ 
      status: 'error', 
      message: '서버 오류가 발생했습니다.' 
    });
  }
});

// 재무제표 전체 분석 API
app.get('/api/financial-analysis', async (req, res) => {
  try {
    const { corp_code, bsns_year, reprt_code } = req.query;
    
    console.log('재무분석 API 요청 파라미터:', { corp_code, bsns_year, reprt_code });
    
    if (!corp_code || !bsns_year || !reprt_code) {
      console.log('재무분석 API - 필수 파라미터 누락:', { corp_code, bsns_year, reprt_code });
      return res.status(400).json({ 
        status: 'error', 
        message: '회사 고유번호, 사업연도, 보고서 코드는 필수 입력값입니다.' 
      });
    }
    
    let financialStatements = [];
    
    // Vercel 환경에서는 항상 DART API에서 데이터를 가져옵니다.
    console.log(`재무분석 API - ${corp_code} 회사의 ${bsns_year}년 재무제표 데이터를 DART API에서 가져오는 중...`);
    try {
      const newData = await financialService.fetchFinancialStatements(
        corp_code, bsns_year, reprt_code
      );
      
      if (newData && newData.length > 0) {
        financialStatements = newData;
        console.log(`재무분석 API - ${corp_code} 회사의 ${bsns_year}년 재무제표 데이터 DART API에서 가져오기 완료: ${financialStatements.length}개`);
      } else {
        console.warn(`재무분석 API - ${corp_code} 회사의 ${bsns_year}년 재무제표 데이터를 DART API에서 가져오지 못했습니다.`);
        // DB 저장 로직이 없으므로, 여기서 바로 404 반환
        return res.status(404).json({
          status: 'error',
          message: '해당 회사의 재무제표 데이터를 DART API에서 찾을 수 없습니다.'
        });
      }
    } catch (apiError) {
      console.error(`재무분석 API - DART API 호출 중 오류 발생:`, apiError);
      return res.status(500).json({
        status: 'error',
        message: `DART API 데이터 조회 중 오류가 발생했습니다: ${apiError.message}`
      });
    }
    
    // 데이터가 없는 경우 (API에서도 못 가져온 경우)
    if (financialStatements.length === 0) {
      console.warn(`재무분석 API - ${corp_code} 회사의 ${bsns_year}년 재무제표 데이터가 없습니다. (최종 확인)`);
      return res.status(404).json({
        status: 'error',
        message: '해당 회사의 재무제표 데이터를 찾을 수 없습니다.'
      });
    }
    
    // 회사명 조회 (금융회사 판별용)
    let companyName = '';
    try {
      const company = await new Promise((resolve, reject) => {
        db.get('SELECT corp_name FROM companies WHERE corp_code = ?', [corp_code], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });
      companyName = company?.corp_name || '';
    } catch (e) {
      console.warn('회사명 조회 실패:', e.message);
    }

    // 금융회사 여부 판별
    const isFinancial = isFinancialCompany(companyName);
    console.log(`재무분석 API - ${corp_code} (${companyName}) 금융회사 여부: ${isFinancial}`);

    // 전체 재무제표에서 주요 항목 추출
    const analysis = {
      balanceSheet: {},
      incomeStatement: {},
      ratio: {},
      isFinancialCompany: isFinancial,
      companyName: companyName
    };

    // 재무상태표 데이터 추출
    const bsItems = financialStatements.filter(item => item.sj_div === 'BS');

    // 손익계산서 데이터 추출
    const isItems = financialStatements.filter(item => item.sj_div === 'IS');

    console.log(`재무분석 API - ${corp_code} 회사의 ${bsns_year}년 재무제표 데이터: BS=${bsItems.length}개, IS=${isItems.length}개`);

    // 주요 재무상태표 항목 추출 (일반 기업 및 금융회사 공통)
    const bsKeyItems = GENERAL_BS_ITEMS;
    bsKeyItems.forEach(itemName => {
      const item = bsItems.find(i => i.account_nm === itemName);
      if (item) {
        analysis.balanceSheet[itemName] = {
          current: item.thstrm_amount ? parseInt(item.thstrm_amount.replace(/,/g, '')) : 0,
          previous: item.frmtrm_amount ? parseInt(item.frmtrm_amount.replace(/,/g, '')) : 0
        };
      }
    });

    // 금융회사의 경우 추가 재무상태표 항목 추출
    if (isFinancial) {
      const financialBsItems = ['현금및예치금', '대출채권', '유가증권', '책임준비금', '예수부채', '차입부채'];
      financialBsItems.forEach(itemName => {
        const item = bsItems.find(i => i.account_nm.includes(itemName.replace('및', '').replace('부채', '')));
        if (item) {
          analysis.balanceSheet[itemName] = {
            current: item.thstrm_amount ? parseInt(item.thstrm_amount.replace(/,/g, '')) : 0,
            previous: item.frmtrm_amount ? parseInt(item.frmtrm_amount.replace(/,/g, '')) : 0
          };
        }
      });
    }

    // 손익계산서 항목 추출 (금융회사 대응)
    if (isFinancial) {
      // 금융회사용 손익계산서 항목 (alias 포함 검색)
      FINANCIAL_IS_ITEMS.forEach(itemConfig => {
        let foundItem = null;
        // 별칭들 중에서 데이터가 있는 항목 찾기
        for (const alias of itemConfig.aliases) {
          foundItem = isItems.find(i => i.account_nm === alias || i.account_nm.includes(alias));
          if (foundItem) break;
        }
        if (foundItem) {
          analysis.incomeStatement[itemConfig.name] = {
            current: foundItem.thstrm_amount ? parseInt(foundItem.thstrm_amount.replace(/,/g, '')) : 0,
            previous: foundItem.frmtrm_amount ? parseInt(foundItem.frmtrm_amount.replace(/,/g, '')) : 0,
            originalName: foundItem.account_nm // 원래 계정명 저장
          };
        }
      });
    } else {
      // 일반 기업용 손익계산서 항목
      const isKeyItems = GENERAL_IS_ITEMS;
      isKeyItems.forEach(itemName => {
        const item = isItems.find(i => i.account_nm === itemName);
        if (item) {
          analysis.incomeStatement[itemName] = {
            current: item.thstrm_amount ? parseInt(item.thstrm_amount.replace(/,/g, '')) : 0,
            previous: item.frmtrm_amount ? parseInt(item.frmtrm_amount.replace(/,/g, '')) : 0
          };
        }
      });
    }
    
    // 데이터의 유효성 검사
    const hasBalanceSheetData = Object.keys(analysis.balanceSheet).length > 0;
    const hasIncomeStatementData = Object.keys(analysis.incomeStatement).length > 0;
    
    if (!hasBalanceSheetData && !hasIncomeStatementData) {
      console.warn(`재무분석 API - ${corp_code} 회사의 ${bsns_year}년 재무제표에 유효한 데이터가 없습니다.`);
      return res.status(404).json({
        status: 'error',
        message: '재무제표에 유효한 데이터가 없습니다.'
      });
    }
    
    // 재무 비율 계산
    try {
      // 금융회사의 경우 '영업수익'을 매출액 대신 사용
      const revenueKey = isFinancial ? '영업수익' : '매출액';
      const revenueData = analysis.incomeStatement[revenueKey];

      // 1. 유동비율 = 유동자산 / 유동부채 * 100 (금융회사는 해당 없음)
      if (!isFinancial && analysis.balanceSheet['유동자산'] && analysis.balanceSheet['유동부채'] && analysis.balanceSheet['유동부채'].current !== 0) {
        analysis.ratio['유동비율'] = {
          current: (analysis.balanceSheet['유동자산'].current / analysis.balanceSheet['유동부채'].current * 100).toFixed(2),
          previous: analysis.balanceSheet['유동부채'].previous !== 0 ?
            (analysis.balanceSheet['유동자산'].previous / analysis.balanceSheet['유동부채'].previous * 100).toFixed(2) : 0
        };
      }

      // 2. 부채비율 = 부채총계 / 자본총계 * 100
      if (analysis.balanceSheet['부채총계'] && analysis.balanceSheet['자본총계'] && analysis.balanceSheet['자본총계'].current !== 0) {
        analysis.ratio['부채비율'] = {
          current: (analysis.balanceSheet['부채총계'].current / analysis.balanceSheet['자본총계'].current * 100).toFixed(2),
          previous: analysis.balanceSheet['자본총계'].previous !== 0 ?
            (analysis.balanceSheet['부채총계'].previous / analysis.balanceSheet['자본총계'].previous * 100).toFixed(2) : 0
        };
      }

      // 3. 자기자본비율 = 자본총계 / 자산총계 * 100 (금융회사의 경우 BIS 비율과 유사한 의미)
      if (analysis.balanceSheet['자본총계'] && analysis.balanceSheet['자산총계'] && analysis.balanceSheet['자산총계'].current !== 0) {
        analysis.ratio['자기자본비율'] = {
          current: (analysis.balanceSheet['자본총계'].current / analysis.balanceSheet['자산총계'].current * 100).toFixed(2),
          previous: analysis.balanceSheet['자산총계'].previous !== 0 ?
            (analysis.balanceSheet['자본총계'].previous / analysis.balanceSheet['자산총계'].previous * 100).toFixed(2) : 0
        };
      }

      // 4. 영업이익률 = 영업이익 / 영업수익(또는 매출액) * 100
      if (analysis.incomeStatement['영업이익'] && revenueData && revenueData.current !== 0) {
        const ratioName = isFinancial ? '영업이익률' : '매출액영업이익률';
        analysis.ratio[ratioName] = {
          current: (analysis.incomeStatement['영업이익'].current / revenueData.current * 100).toFixed(2),
          previous: revenueData.previous !== 0 ?
            (analysis.incomeStatement['영업이익'].previous / revenueData.previous * 100).toFixed(2) : 0
        };
      }

      // 5. 순이익률 = 당기순이익 / 영업수익(또는 매출액) * 100
      if (analysis.incomeStatement['당기순이익'] && revenueData && revenueData.current !== 0) {
        const ratioName = isFinancial ? '순이익률' : '매출액순이익률';
        analysis.ratio[ratioName] = {
          current: (analysis.incomeStatement['당기순이익'].current / revenueData.current * 100).toFixed(2),
          previous: revenueData.previous !== 0 ?
            (analysis.incomeStatement['당기순이익'].previous / revenueData.previous * 100).toFixed(2) : 0
        };
      }

      // 6. ROE(자기자본이익률) = 당기순이익 / 자본총계 * 100
      if (analysis.incomeStatement['당기순이익'] && analysis.balanceSheet['자본총계'] && analysis.balanceSheet['자본총계'].current !== 0) {
        analysis.ratio['ROE'] = {
          current: (analysis.incomeStatement['당기순이익'].current / analysis.balanceSheet['자본총계'].current * 100).toFixed(2),
          previous: analysis.balanceSheet['자본총계'].previous !== 0 ?
            (analysis.incomeStatement['당기순이익'].previous / analysis.balanceSheet['자본총계'].previous * 100).toFixed(2) : 0
        };
      }

      // 7. ROA(총자산이익률) = 당기순이익 / 자산총계 * 100
      if (analysis.incomeStatement['당기순이익'] && analysis.balanceSheet['자산총계'] && analysis.balanceSheet['자산총계'].current !== 0) {
        analysis.ratio['ROA'] = {
          current: (analysis.incomeStatement['당기순이익'].current / analysis.balanceSheet['자산총계'].current * 100).toFixed(2),
          previous: analysis.balanceSheet['자산총계'].previous !== 0 ?
            (analysis.incomeStatement['당기순이익'].previous / analysis.balanceSheet['자산총계'].previous * 100).toFixed(2) : 0
        };
      }

      // 8. 당좌비율 (금융회사 제외)
      if (!isFinancial && analysis.balanceSheet['유동자산'] && analysis.balanceSheet['유동부채'] &&
          analysis.balanceSheet['유동부채'].current !== 0) {
        const inventoryCurrent = 0;
        const inventoryPrevious = 0;

        analysis.ratio['당좌비율'] = {
          current: ((analysis.balanceSheet['유동자산'].current - inventoryCurrent) /
                  analysis.balanceSheet['유동부채'].current * 100).toFixed(2),
          previous: analysis.balanceSheet['유동부채'].previous !== 0 ?
            ((analysis.balanceSheet['유동자산'].previous - inventoryPrevious) /
             analysis.balanceSheet['유동부채'].previous * 100).toFixed(2) : 0
        };
      }
    } catch (ratioError) {
      console.error(`재무분석 API - 재무비율 계산 중 오류 발생:`, ratioError);
    }
    
    console.log(`재무분석 API - ${corp_code} 회사의 ${bsns_year}년 재무분석 완료:`, {
      balanceSheet: Object.keys(analysis.balanceSheet).length,
      incomeStatement: Object.keys(analysis.incomeStatement).length,
      ratio: Object.keys(analysis.ratio).length
    });
    
    res.json({
      status: 'success',
      data: analysis
    });
  } catch (error) {
    console.error('재무제표 분석 중 오류 발생:', error);
    res.status(500).json({ 
      status: 'error', 
      message: '서버에서 재무제표 분석 중 오류가 발생했습니다.', 
      error: error.message 
    });
  }
});

// AI 기반 재무분석 API
app.post('/api/ai-financial-analysis', async (req, res) => {
  try {
    const { companyName, year, previousYear, balanceSheet, incomeStatement, ratio, isFinancialCompany: isFinancial } = req.body;

    if (!companyName || !year || !balanceSheet || !incomeStatement) {
      return res.status(400).json({
        status: 'error',
        message: '회사명, 연도, 재무상태표, 손익계산서는 필수 입력값입니다.'
      });
    }

    // 금융회사 여부 판별 (클라이언트에서 전달받거나 서버에서 판별)
    const isFinancialComp = isFinancial !== undefined ? isFinancial : isFinancialCompany(companyName);
    console.log(`AI 재무분석 요청: ${companyName} (${year}년) - 금융회사: ${isFinancialComp}`);

    // 재무 데이터 분석 프롬프트 구성
    const prompt = createFinancialAnalysisPrompt(companyName, year, previousYear, balanceSheet, incomeStatement, ratio, isFinancialComp);
    
    // Gemini API 호출
    const analysis = await callGeminiAPI(prompt);
    
    res.json({
      status: 'success',
      analysis: analysis
    });
  } catch (error) {
    console.error('AI 재무분석 중 오류 발생:', error);
    res.status(500).json({ 
      status: 'error', 
      message: `AI 재무분석 중 오류가 발생했습니다: ${error.message}` 
    });
  }
});

// Gemini API 호출 함수
async function callGeminiAPI(prompt) {
  try {
    const apiKey = config.GEMINI_API_KEY;
    
    if (!apiKey) {
      throw new Error('Gemini API 키가 설정되지 않았습니다. config.js 파일에 GEMINI_API_KEY를 설정해주세요.');
    }
    
    // API 엔드포인트 URL (Gemini 3 Flash 모델 사용)
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`,
      {
        contents: [
          {
            parts: [
              {
                text: prompt
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.2,
          topK: 40,
          topP: 0.95,
          maxOutputTokens: 1024
        }
      }
    );
    
    // 응답에서 텍스트 추출
    if (response.data.candidates && response.data.candidates.length > 0 && 
        response.data.candidates[0].content && response.data.candidates[0].content.parts && 
        response.data.candidates[0].content.parts.length > 0) {
      return response.data.candidates[0].content.parts[0].text;
    } else {
      console.error('유효하지 않은 Gemini API 응답:', JSON.stringify(response.data));
      throw new Error('AI 응답 형식이 유효하지 않습니다.');
    }
  } catch (error) {
    console.error('Gemini API 호출 중 오류 발생:', error);
    if (error.response) {
      console.error('API 오류 응답:', error.response.data);
    }
    throw new Error(`Gemini API 호출 실패: ${error.message}`);
  }
}

// 재무분석 프롬프트 생성 함수
function createFinancialAnalysisPrompt(companyName, year, previousYear, balanceSheet, incomeStatement, ratio, isFinancialCompany = false) {
  // 재무 데이터 정리
  const financialData = {
    company: companyName,
    year: year,
    previousYear: previousYear,
    isFinancialCompany: isFinancialCompany,
    balanceSheet: {},
    incomeStatement: {},
    ratio: {}
  };

  // 재무상태표 데이터 정리
  if (balanceSheet) {
    Object.entries(balanceSheet).forEach(([key, value]) => {
      financialData.balanceSheet[key] = {
        current: value.current,
        previous: value.previous,
        change: value.change,
        changeRate: value.changeRate
      };
    });
  }

  // 손익계산서 데이터 정리
  if (incomeStatement) {
    Object.entries(incomeStatement).forEach(([key, value]) => {
      financialData.incomeStatement[key] = {
        current: value.current,
        previous: value.previous,
        change: value.change,
        changeRate: value.changeRate
      };
    });
  }

  // 재무비율 데이터 정리
  if (ratio) {
    Object.entries(ratio).forEach(([key, value]) => {
      financialData.ratio[key] = {
        current: value.current,
        previous: value.previous,
        change: value.change
      };
    });
  }

  // 금융회사용 프롬프트
  if (isFinancialCompany) {
    return `
다음은 ${companyName}의 ${year}년 재무제표 데이터입니다. 이 회사는 금융회사(은행, 보험, 증권 등)입니다. 금융업 특성을 고려하여 재무 상태에 대한 간결하고 통찰력 있는 분석을 제공해주세요.

재무 데이터:
${JSON.stringify(financialData, null, 2)}

다음 지침을 따라 금융회사 관점에서 분석해주세요:
1. 영업수익(또는 순이자손익), 영업이익, 당기순이익의 변화를 분석하고 수익성 추이를 설명해주세요.
2. 자산(대출채권, 유가증권 등), 부채(예수금, 차입금 등), 자본의 구조 변화를 분석하고 금융회사의 건전성을 평가해주세요.
3. 주요 재무비율(자기자본비율, ROE, ROA, 부채비율 등)을 해석하여 금융회사의 안정성과 수익성을 평가해주세요.
4. 전년 대비 주요 변화점과 그 의미를 금융업 관점에서 설명해주세요.
5. 회사의 재무 상태에 대한 전반적인 평가와 간단한 요약을 제공해주세요.

형식 지침:
- **Markdown 코드 블록(\`\`\`)을 사용하지 마세요.**
- 문단은 <p> 태그로 감싸주세요. 예: <p>분석 내용입니다.</p>
- 긍정적인 내용은 <span class="positive">내용</span> 형식으로 표시해주세요.
- 부정적인 내용은 <span class="negative">내용</span> 형식으로 표시해주세요.
- 중립적인 내용은 <span class="neutral">내용</span> 형식으로 표시해주세요.
- 중요한 수치나 용어는 <strong>내용</strong> 형식으로 강조해주세요.
- 제목으로 "${companyName} ${year}년 재무 분석"을 첫 줄에 추가해주세요.
- 전체 분석은 3-4개 문단으로 간결하게 작성해주세요.
`;
  }

  // 일반 기업용 프롬프트
  return `
다음은 ${companyName}의 ${year}년 재무제표 데이터입니다. 이 데이터를 분석하여 회사의 재무 상태에 대한 간결하고 통찰력 있는 분석을 제공해주세요.

재무 데이터:
${JSON.stringify(financialData, null, 2)}

다음 지침을 따라 분석해주세요:
1. 매출, 영업이익, 당기순이익의 변화를 분석하고 의미를 설명해주세요.
2. 자산, 부채, 자본의 변화를 분석하고 회사의 재무 안정성을 평가해주세요.
3. 주요 재무비율(유동비율, 부채비율, ROE, ROA 등)을 해석하여 회사의 재무 건전성을 평가해주세요.
4. 전년 대비 주요 변화점과 그 의미를 설명해주세요.
5. 회사의 재무 상태에 대한 전반적인 평가와 간단한 요약을 제공해주세요.

형식 지침:
- **Markdown 코드 블록(\`\`\`)을 사용하지 마세요.**
- 문단은 <p> 태그로 감싸주세요. 예: <p>분석 내용입니다.</p>
- 긍정적인 내용은 <span class="positive">내용</span> 형식으로 표시해주세요.
- 부정적인 내용은 <span class="negative">내용</span> 형식으로 표시해주세요.
- 중립적인 내용은 <span class="neutral">내용</span> 형식으로 표시해주세요.
- 중요한 수치나 용어는 <strong>내용</strong> 형식으로 강조해주세요.
- 제목으로 "${companyName} ${year}년 재무 분석"을 첫 줄에 추가해주세요.
- 전체 분석은 3-4개 문단으로 간결하게 작성해주세요.
`;
}

// DART 공시목록 프록시 API
app.get('/api/disclosure-list', async (req, res) => {
  try {
    const { corp_code } = req.query;
    if (!corp_code) {
      return res.status(400).json({ status: 'error', message: 'corp_code는 필수입니다.' });
    }
    // 오늘 날짜, 5년 전 날짜 계산
    const endDate = new Date();
    const startDate = new Date();
    startDate.setFullYear(endDate.getFullYear() - 5);
    const formatDate = d => d.toISOString().slice(0,10).replace(/-/g,'');
    const bgn_de = formatDate(startDate);
    const end_de = formatDate(endDate);

    const url = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${config.OPEN_DART_API_KEY}&corp_code=${corp_code}&bgn_de=${bgn_de}&end_de=${end_de}&pblntf_ty=A&page_count=100`;
    const response = await axios.get(url);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Vercel 환경이 아닌 경우 (로컬 개발 환경 등)에만 서버를 직접 실행
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`로컬 서버가 ${PORT} 포트에서 실행 중입니다.`);
    console.log('(Vercel 배포 시 이 메시지는 보이지 않아야 정상입니다.)');
  });
}

// Vercel에서 사용할 수 있도록 Express 앱 인스턴스를 내보냅니다.
module.exports = app; 