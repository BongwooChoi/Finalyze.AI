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
    
    // 전체 재무제표에서 주요 항목 추출
    const analysis = {
      balanceSheet: {}, 
      incomeStatement: {}, 
      ratio: {} 
    };
    
    // 재무상태표 데이터 추출
    const bsItems = financialStatements.filter(item => item.sj_div === 'BS');
    
    // 손익계산서 데이터 추출
    const isItems = financialStatements.filter(item => item.sj_div === 'IS');
    
    console.log(`재무분석 API - ${corp_code} 회사의 ${bsns_year}년 재무제표 데이터: BS=${bsItems.length}개, IS=${isItems.length}개`);
    
    // 주요 재무상태표 항목 추출
    const bsKeyItems = ['자산총계', '부채총계', '자본총계', '유동자산', '비유동자산', '유동부채', '비유동부채'];
    bsKeyItems.forEach(itemName => {
      const item = bsItems.find(i => i.account_nm === itemName);
      if (item) {
        analysis.balanceSheet[itemName] = {
          current: item.thstrm_amount ? parseInt(item.thstrm_amount.replace(/,/g, '')) : 0,
          previous: item.frmtrm_amount ? parseInt(item.frmtrm_amount.replace(/,/g, '')) : 0
        };
      }
    });
    
    // 주요 손익계산서 항목 추출
    const isKeyItems = ['매출액', '영업이익', '법인세비용차감전순이익', '당기순이익'];
    isKeyItems.forEach(itemName => {
      const item = isItems.find(i => i.account_nm === itemName);
      if (item) {
        analysis.incomeStatement[itemName] = {
          current: item.thstrm_amount ? parseInt(item.thstrm_amount.replace(/,/g, '')) : 0,
          previous: item.frmtrm_amount ? parseInt(item.frmtrm_amount.replace(/,/g, '')) : 0
        };
      }
    });
    
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
      // 1. 유동비율 = 유동자산 / 유동부채 * 100
      if (analysis.balanceSheet['유동자산'] && analysis.balanceSheet['유동부채'] && analysis.balanceSheet['유동부채'].current !== 0) {
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
      
      // 3. 자기자본비율 = 자본총계 / 자산총계 * 100
      if (analysis.balanceSheet['자본총계'] && analysis.balanceSheet['자산총계'] && analysis.balanceSheet['자산총계'].current !== 0) {
        analysis.ratio['자기자본비율'] = {
          current: (analysis.balanceSheet['자본총계'].current / analysis.balanceSheet['자산총계'].current * 100).toFixed(2),
          previous: analysis.balanceSheet['자산총계'].previous !== 0 ? 
            (analysis.balanceSheet['자본총계'].previous / analysis.balanceSheet['자산총계'].previous * 100).toFixed(2) : 0
        };
      }
      
      // 4. 매출액영업이익률 = 영업이익 / 매출액 * 100
      if (analysis.incomeStatement['영업이익'] && analysis.incomeStatement['매출액'] && analysis.incomeStatement['매출액'].current !== 0) {
        analysis.ratio['매출액영업이익률'] = {
          current: (analysis.incomeStatement['영업이익'].current / analysis.incomeStatement['매출액'].current * 100).toFixed(2),
          previous: analysis.incomeStatement['매출액'].previous !== 0 ? 
            (analysis.incomeStatement['영업이익'].previous / analysis.incomeStatement['매출액'].previous * 100).toFixed(2) : 0
        };
      }
      
      // 5. 매출액순이익률 = 당기순이익 / 매출액 * 100
      if (analysis.incomeStatement['당기순이익'] && analysis.incomeStatement['매출액'] && analysis.incomeStatement['매출액'].current !== 0) {
        analysis.ratio['매출액순이익률'] = {
          current: (analysis.incomeStatement['당기순이익'].current / analysis.incomeStatement['매출액'].current * 100).toFixed(2),
          previous: analysis.incomeStatement['매출액'].previous !== 0 ? 
            (analysis.incomeStatement['당기순이익'].previous / analysis.incomeStatement['매출액'].previous * 100).toFixed(2) : 0
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
      
      // 8. 당좌비율 = (유동자산 - 재고자산) / 유동부채 * 100
      if (analysis.balanceSheet['유동자산'] && analysis.balanceSheet['유동부채'] && 
          analysis.balanceSheet['유동부채'].current !== 0) {
        // 재고자산이 없는 경우 0으로 처리
        const inventoryCurrent = 0; // 항목이 없으면 0으로 간주
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
      // 재무비율 계산 오류가 전체 분석을 중단시키지는 않음
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
    const { companyName, year, previousYear, balanceSheet, incomeStatement, ratio } = req.body;
    
    if (!companyName || !year || !balanceSheet || !incomeStatement) {
      return res.status(400).json({ 
        status: 'error', 
        message: '회사명, 연도, 재무상태표, 손익계산서는 필수 입력값입니다.' 
      });
    }
    
    console.log(`AI 재무분석 요청: ${companyName} (${year}년)`);
    
    // 재무 데이터 분석 프롬프트 구성
    const prompt = createFinancialAnalysisPrompt(companyName, year, previousYear, balanceSheet, incomeStatement, ratio);
    
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
    
    // API 엔드포인트 URL 수정 (모델 이름 변경)
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
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
function createFinancialAnalysisPrompt(companyName, year, previousYear, balanceSheet, incomeStatement, ratio) {
  // 재무 데이터 정리
  const financialData = {
    company: companyName,
    year: year,
    previousYear: previousYear,
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

  // 프롬프트 구성
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

// Vercel에서 사용할 수 있도록 Express 앱 인스턴스를 내보냅니다.
module.exports = app; 