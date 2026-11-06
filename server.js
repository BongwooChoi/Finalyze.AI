const express = require('express');
const path = require('path');
const financialService = require('./financialService');
const axios = require('axios');
const AdmZip = require('adm-zip');
const dotenv = require('dotenv');
const config = require('./config');
const { renderPage } = require('./sitePages');
const { createRecentDisclosureService,getFeaturedStockCodes } = require('./recentDisclosures');
const dartClient = require('./dartClient');
const { getSharedStore } = require('./sharedStore');
const { getAccountStore } = require('./accountStore');
const { createAccountRouter } = require('./accountRoutes');
const { createDisclosureFeed,createSenders,createNotificationJob,cronAuthorized } = require('./disclosureNotifications');
const { sign } = require('./accountSecurity');
const { readDisclosureXml,parseProvisionalFinancials } = require('./provisionalFinancials');
const {createTelegramBroadcast,telegramConfig}=require('./telegramDisclosures');
const {createAnalysisLimiter,OPENAI_DEADLINE_MS,analysisFailure}=require('./analysisLimits');
const {createSettingsService}=require('./serviceSettings');
const {createAdminRouter}=require('./adminRoutes');

// 환경변수 로드
dotenv.config();

const app = express();
if(process.env.VERCEL) app.set('trust proxy',1);
const PORT = process.env.PORT || 3000;
const serviceSettings=createSettingsService({store:getAccountStore});
const runAnalysis = createAnalysisLimiter({getSettings:serviceSettings.values});

// 공개 페이지는 JavaScript 실행 전에도 본문과 고유 메타데이터를 제공합니다.
app.get('/', (req, res) => res.type('html').send(renderPage('analysis')));
app.get('/about', (req, res) => {
  if (req.path.endsWith('/')) {
    return res.redirect(301, `/about${req.originalUrl.slice(req.path.length)}`);
  }
  res.type('html').send(renderPage('about'));
});
app.get('/index.html', (req, res) => res.redirect(301, `/${req.originalUrl.slice(req.path.length)}`));
app.get('/admin', (req,res)=>res.set({'Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow'}).sendFile(path.join(__dirname,'public','admin.html')));
app.get('/admin.html', (req,res)=>res.redirect(301,'/admin'));

// 정적 파일 제공
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// 데이터베이스 연결
const db = financialService.connectDB();
const findCompany = corp => new Promise((resolve,reject) => db.get('SELECT * FROM companies WHERE corp_code=? LIMIT 1',[corp],(error,row) => error ? reject(error) : resolve(row)));

const accounts = createAccountRouter({
  store:getAccountStore,
  getSettings:serviceSettings.values,
  findCompany,
  rateLimit:async (req,stage) => {
    const key = `finalyze:login:${stage}:${sign(req.ip || 'unknown',process.env.SESSION_SECRET)}`;
    const time = Date.now();
    const [delay] = await getSharedStore().reserve(key,new Date(time).toISOString().slice(0,10),time,1000,600,0);
    return delay>=0;
  }
});
app.use('/api',accounts.router);
app.use('/api/admin',createAdminRouter({accounts,settings:serviceSettings,sharedStore:getSharedStore}));
app.get('/privacy',(req,res) => res.sendFile(path.join(__dirname,'public','privacy.html')));

const notificationFeed = createDisclosureFeed({
  fetchList:async params => (await dartClient.get('https://opendart.fss.or.kr/api/list.json',{ params,timeout:12000 })).data,
  fetchDocumentText:async receipt => extractDocumentText((await dartClient.get('https://opendart.fss.or.kr/api/document.xml',{
    params:{rcept_no:receipt},responseType:'arraybuffer',timeout:12000
  })).data)
});
const telegram=createTelegramBroadcast({config:telegramConfig(),store:getAccountStore,
  companies:()=>new Promise((resolve,reject)=>{
    const stocks=getFeaturedStockCodes();
    db.all(`SELECT corp_code,corp_name,stock_code FROM companies WHERE stock_code IN (${stocks.map(()=>'?').join(',')})`,stocks,(error,rows)=>error?reject(error):resolve(rows));
  }),
  fetchDocument:async receipt=>(await dartClient.get('https://opendart.fss.or.kr/api/document.xml',{
    params:{rcept_no:receipt},responseType:'arraybuffer',timeout:12000
  })).data
});
const notify = createNotificationJob({ store:getAccountStore,collect:notificationFeed,broadcast:telegram,
  senders:createSenders({ config:accounts.config,unsubscribeToken:accounts.unsubscribeToken }) });
app.post('/api/jobs/disclosures',async (req,res) => {
  res.set('Cache-Control','no-store');
  if(!cronAuthorized(req,process.env.CRON_SECRET)) return res.status(401).json({ status:'error' });
  if(!accounts.config.enabled && !telegram.enabled) return res.status(503).json({ status:'error',message:'Notification configuration unavailable' });
  try { res.json({ status:'success',...await notify() }); }
  catch { console.warn('공시 알림 작업 실패:',{ code:'NOTIFICATION_JOB_UNAVAILABLE' }); res.status(503).json({ status:'error' }); }
});

const recentDisclosures = createRecentDisclosureService({
  sharedStore: getSharedStore,
  namespace: `${dartClient.namespace}:recent:v3:5`,
  fetchList: async params => {
    const { data } = await dartClient.get('https://opendart.fss.or.kr/api/list.json', {
      params: { ...params, crtfc_key: config.OPEN_DART_API_KEY }, timeout: 12000
    });
    return data;
  },
  fetchDocumentText: async rceptNo => {
    const { data } = await dartClient.get('https://opendart.fss.or.kr/api/document.xml', {
      params: { crtfc_key: config.OPEN_DART_API_KEY, rcept_no: rceptNo },
      responseType: 'arraybuffer', timeout: 12000
    });
    return extractDocumentText(data);
  },
  onDocumentError: (rceptNo, error) => console.warn('최신 공시 원문 확인 실패:', {
    rceptNo, code: error.code || 'DOCUMENT_UNAVAILABLE', httpStatus: error.response?.status, message: error.message
  })
});

app.get('/api/recent-disclosures', async (req, res) => {
  try {
    if (!config.OPEN_DART_API_KEY) throw new Error('DART 인증키가 설정되지 않았습니다.');
    const result = await recentDisclosures.getRecentDisclosures();
    // CDN과 실행 중인 서버가 같은 목록을 공유합니다. 오래된 응답은 정상 갱신으로 캐시하지 않습니다.
    const cacheSeconds = Math.max(0, Math.ceil((Date.parse(result.updatedAt) + result.refreshSeconds * 1000 - Date.now()) / 1000));
    res.set('Cache-Control', result.stale ? 'no-store' : `public, max-age=0, s-maxage=${cacheSeconds}`);
    res.json(result);
  } catch (error) {
    console.warn('최신 공시 조회 실패:', {
      stage: error.stage, code: error.code, httpStatus: error.response?.status, dartStatus: error.dartStatus, message: error.message
    });
    res.set('Cache-Control', 'no-store').status(503).json({
      status: 'error', message: '최신 공시를 불러오지 못했습니다. 잠시 후 다시 확인해주세요.'
    });
  }
});

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
const GENERAL_IS_ITEMS = [
  { name: '매출액', aliases: ['매출액', '수익(매출액)', '매출'] },
  { name: '영업이익', aliases: ['영업이익', '영업이익(손실)'] },
  { name: '법인세비용차감전순이익', aliases: ['법인세비용차감전순이익', '법인세차감전 순이익', '법인세비용차감전순손익', '법인세비용차감전계속사업이익'] },
  { name: '당기순이익', aliases: ['당기순이익', '당기순이익(손실)', '당기순손익', '분기순이익', '반기순이익'] }
];

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

// 공유 링크도 URL의 표시 이름 대신 회사 DB의 확인된 정보를 사용합니다.
app.get('/api/companies/corp/:corpCode', async (req,res) => {
  if (!/^\d{8}$/.test(req.params.corpCode)) return res.status(400).json({status:'error',message:'기업 고유번호를 확인해주세요.'});
  try {
    const company = await findCompany(req.params.corpCode);
    if (!company) return res.status(404).json({status:'error',message:'기업 정보를 찾지 못했습니다.'});
    res.json({status:'success',data:company});
  } catch {
    res.status(503).json({status:'error',message:'기업 정보를 불러오지 못했습니다.'});
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

// 최근 5개년 주요 손익 추이 (DART 단일회사 주요계정 API를 연도별 병렬 조회)
app.get('/api/financial-trend', async (req, res) => {
  try {
    const { corp_code } = req.query;
    if (!corp_code) {
      return res.status(400).json({
        status: 'error',
        message: '회사 고유번호는 필수 입력값입니다.'
      });
    }

    // 사업보고서(연간) 기준 최근 5개년
    const latestYear = new Date().getFullYear() - 1;
    const years = Array.from({ length: 5 }, (_, i) => String(latestYear - 4 + i));

    const responses = await Promise.all(years.map(year => {
      const url = `https://opendart.fss.or.kr/api/fnlttSinglAcnt.json?crtfc_key=${config.OPEN_DART_API_KEY}&corp_code=${corp_code}&bsns_year=${year}&reprt_code=11011`;
      return dartClient.get(url).then(r => r.data).catch(() => null);
    }));

    // 계정명이 회사마다 조금씩 다름 (예: 당기순이익(손실), 영업이익(손실))
    const ACCOUNTS = [
      { key: 'revenue', match: nm => nm === '매출액' || nm === '영업수익' },
      { key: 'operatingIncome', match: nm => nm.startsWith('영업이익') },
      { key: 'netIncome', match: nm => nm.startsWith('당기순이익') }
    ];
    const series = { revenue: [], operatingIncome: [], netIncome: [] };

    responses.forEach(data => {
      const list = data && data.status === '000' && Array.isArray(data.list) ? data.list : [];
      // 연결(CFS) 우선, 없으면 개별(OFS)
      const cfs = list.filter(r => r.fs_div === 'CFS');
      const rows = cfs.length > 0 ? cfs : list.filter(r => r.fs_div === 'OFS');
      ACCOUNTS.forEach(({ key, match }) => {
        const row = rows.find(r => r.account_nm && match(r.account_nm));
        const amount = row && row.thstrm_amount
          ? parseInt(String(row.thstrm_amount).replace(/,/g, ''), 10)
          : NaN;
        series[key].push(Number.isFinite(amount) ? amount : null);
      });
    });

    const hasValidData = Object.values(series).some(arr => arr.some(v => v !== null));
    if (!hasValidData) {
      return res.status(404).json({
        status: 'error',
        message: '최근 5개년 연간 실적 데이터가 없습니다.'
      });
    }

    res.json({ status: 'success', data: { years, series } });
  } catch (error) {
    console.error('재무 추이 조회 중 오류 발생:', error);
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

    // 손익계산서 데이터 추출 (IS: 손익계산서, CIS: 포괄손익계산서)
    const isItems = financialStatements.filter(item => item.sj_div === 'IS' || item.sj_div === 'CIS');

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
      // 일반 기업용 손익계산서 항목 (alias 포함 검색)
      GENERAL_IS_ITEMS.forEach(itemConfig => {
        let foundItem = null;
        for (const alias of itemConfig.aliases) {
          foundItem = isItems.find(i => i.account_nm === alias || i.account_nm.includes(alias));
          if (foundItem) break;
        }
        if (foundItem) {
          analysis.incomeStatement[itemConfig.name] = {
            current: foundItem.thstrm_amount ? parseInt(foundItem.thstrm_amount.replace(/,/g, '')) : 0,
            previous: foundItem.frmtrm_amount ? parseInt(foundItem.frmtrm_amount.replace(/,/g, '')) : 0,
            originalName: foundItem.account_nm
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

      // 당좌비율은 계산하지 않는다: (유동자산 - 재고자산) / 유동부채인데,
      // fnlttSinglAcnt(주요계정) 응답에는 재고자산이 없어 유동비율과 같은 값이 나오기 때문
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
app.post('/api/ai-financial-analysis', accounts.requireAnalysis, async (req, res) => {
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
    
    // OpenAI API 호출 (structured outputs)
    const result = await runAnalysis(req.analysisUserId,async()=>parseAnalysisJson(await callOpenAIAPI(prompt, FINANCIAL_ANALYSIS_SCHEMA)));
    result.title = `${companyName} ${year}년 재무 분석`;

    res.json({
      status: 'success',
      result
    });
  } catch (error) {
    const failure=analysisFailure(error);
    if(failure.notice) console.info('AI 분석 이용 안내:',{code:failure.body.code});
    else console.error('AI 재무분석 중 오류 발생:', error.message);
    if(failure.retryAfter) res.set('Retry-After',String(failure.retryAfter));
    res.status(failure.status).json(failure.body);
  }
});

// OpenAI 모델
const OPENAI_MODEL = 'gpt-6-luna';

// AI 분석 응답 공통 스키마 조각 (structured outputs, strict 모드)
// 프런트(renderAiAnalysisHtml)가 rating 배지 + 섹션 카드 + 항목별 ▲▼ 표시로 렌더링한다
function buildAnalysisSectionSchema(categories) {
  return {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['category', 'title', 'points'],
      properties: {
        category: { type: 'string', enum: categories },
        title: { type: 'string' },
        points: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['tone', 'text'],
            properties: {
              tone: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
              text: { type: 'string' }
            }
          }
        }
      }
    }
  };
}

const RATING_SCHEMA = { type: 'string', enum: ['positive', 'mixed', 'negative'] };

// 정기공시 재무분석 응답 스키마 (섹션을 먼저 쓰고 결론을 나중에 쓰도록 속성 순서를 둔다)
const FINANCIAL_ANALYSIS_SCHEMA = {
  name: 'financial_analysis',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['sections', 'rating', 'summary'],
    properties: {
      sections: buildAnalysisSectionSchema(['profitability', 'growth', 'stability', 'liquidity', 'efficiency']),
      rating: RATING_SCHEMA,
      summary: { type: 'string' }
    }
  }
};

// 잠정실적 분석 응답 스키마 (정기공시보다 항목이 적으므로 섹션 종류도 적다)
const PROVISIONAL_ANALYSIS_SCHEMA = {
  name: 'provisional_analysis',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['sections', 'rating', 'summary'],
    properties: {
      sections: buildAnalysisSectionSchema(['results', 'comparison', 'drivers']),
      rating: RATING_SCHEMA,
      summary: { type: 'string' }
    }
  }
};

// structured outputs 응답(JSON 문자열)을 파싱하고 최소 형식을 검증
function parseAnalysisJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error('AI 응답 JSON 파싱 실패:', e.message, raw.slice(0, 500));
    throw new Error('AI 응답(JSON)을 해석하지 못했습니다.');
  }
  if (!parsed || !Array.isArray(parsed.sections) || typeof parsed.summary !== 'string') {
    throw new Error('AI 응답 형식이 올바르지 않습니다.');
  }
  return parsed;
}

// OpenAI API 호출 함수 (429 Rate Limit 대응을 위한 자동 재시도 로직 포함)
// jsonSchema({ name, schema })를 넘기면 structured outputs로 JSON 문자열을 받는다
async function callOpenAIAPI(prompt, jsonSchema) {
  const apiKey = config.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error('OpenAI API 키가 설정되지 않았습니다. .env 파일에 OPENAI_API_KEY를 설정해주세요.');
  }

  const maxRetries = 3;
  const signal = AbortSignal.timeout(OPENAI_DEADLINE_MS);
  let delay = 1000; // 초기 대기 시간 1초

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: OPENAI_MODEL,
          messages: [
            {
              role: 'user',
              content: prompt
            }
          ],
          reasoning_effort: 'none', // 리즈닝 비활성화
          max_completion_tokens: 8192,
          ...(jsonSchema && {
            response_format: {
              type: 'json_schema',
              json_schema: { name: jsonSchema.name, strict: true, schema: jsonSchema.schema }
            }
          })
        },
        {
          signal, timeout:45000,
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      // 응답에서 텍스트 추출
      const choice = response.data.choices && response.data.choices[0];
      const content = choice && choice.message && choice.message.content;
      if (choice && choice.message && choice.message.refusal) {
        throw new Error(`AI가 응답을 거부했습니다: ${choice.message.refusal}`);
      }
      if (content) {
        return content;
      } else {
        console.error('유효하지 않은 OpenAI API 응답:', JSON.stringify(response.data));
        throw new Error('AI 응답 형식이 유효하지 않습니다.');
      }
    } catch (error) {
      if(signal.aborted) throw new Error('AI 분석 시간이 초과되었습니다. 잠시 후 다시 시도해주세요.');
      const isRateLimit = error.response && error.response.status === 429;

      if (isRateLimit && attempt < maxRetries) {
        console.warn(`OpenAI API 429 (Rate Limit) 감지. ${delay}ms 후 재시도합니다... (시도 ${attempt}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2; // 지수 백오프
        continue;
      }

      // error 객체 전체를 로그로 남기면 요청 헤더의 API 키까지 출력되므로 message만 기록
      console.error(`OpenAI API 호출 중 오류 발생 (시도 ${attempt}/${maxRetries}):`, error.message);
      if (attempt === maxRetries) {
        if (error.response) {
          console.error('API 오류 응답:', JSON.stringify(error.response.data));
        }
        throw new Error(`OpenAI API 호출 실패: ${error.message}`);
      }
    }
  }
}

// 정기공시 재무분석 출력 지침 (FINANCIAL_ANALYSIS_SCHEMA와 짝을 이룬다)
function buildFinancialOutputGuide(isFinancial) {
  const categoryGuide = isFinancial
    ? 'profitability(수익성), stability(건전성·자본적정성), growth(성장성), efficiency(효율성)'
    : 'profitability(수익성), growth(성장성), stability(안정성), liquidity(유동성), efficiency(효율성)';
  return `
출력 형식 (지정된 JSON 스키마를 따르세요):
- sections: 3~4개. category는 ${categoryGuide} 중에서 서로 겹치지 않게 고르고, title에는 섹션 이름(예: "수익성")을 한국어로 적으세요.
- 각 섹션의 points: 2~3개. 각 point는 수치 근거를 담은 한두 문장으로 쓰고, 전년 대비 변화와 그 의미를 포함하세요.
- 각 point의 tone: 회사에 긍정적인 내용이면 "positive", 부정적이면 "negative", 어느 쪽도 아니면 "neutral".
- rating: 전반적인 재무 상태가 양호하면 "positive", 긍정과 우려가 섞여 있으면 "mixed", 위험 신호가 뚜렷하면 "negative".
- summary: 전체 분석의 핵심 결론을 1~2문장으로 쓰세요.
- 제공된 데이터로 판단할 수 없는 부분은 꼭 필요할 때 한 번만 언급하고, 자료가 없다는 말을 반복하지 마세요.
- 중요한 수치나 용어는 **별표 두 개**로 감싸 강조하세요. 그 외 HTML 태그나 Markdown 문법은 쓰지 마세요.
`;
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

${buildFinancialOutputGuide(isFinancialCompany)}`;
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

${buildFinancialOutputGuide(isFinancialCompany)}`;
}

// DART 공시목록 프록시 API
app.get('/api/disclosure-list', async (req, res) => {
  try {
    const { corp_code } = req.query;
    if (!corp_code) {
      return res.status(400).json({ status: 'error', message: 'corp_code는 필수입니다.' });
    }
    // 오늘 날짜, 5년 전 날짜 계산
    // DART 공시는 한국 시간 기준이므로 KST(UTC+9)로 계산해야
    // 서버가 UTC로 도는 환경(Vercel)에서도 당일 공시가 잘리지 않음
    const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
    const endDate = new Date(Date.now() + KST_OFFSET_MS);
    const startDate = new Date(endDate);
    startDate.setUTCFullYear(endDate.getUTCFullYear() - 5);
    const formatDate = d => d.toISOString().slice(0, 10).replace(/-/g, '');
    const bgn_de = formatDate(startDate);
    const end_de = formatDate(endDate);

    // 정기공시(A)와 거래소공시(I, 잠정실적 등 공정공시 포함)를 함께 조회
    const baseUrl = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${config.OPEN_DART_API_KEY}&corp_code=${corp_code}&bgn_de=${bgn_de}&end_de=${end_de}&page_count=100`;
    const [periodicRes, exchangeRes] = await Promise.all([
      dartClient.get(`${baseUrl}&pblntf_ty=A`),
      dartClient.get(`${baseUrl}&pblntf_ty=I`)
    ]);

    const merged = [];
    let errorData = null;
    for (const { data } of [periodicRes, exchangeRes]) {
      if (data.status === '000' && Array.isArray(data.list)) {
        merged.push(...data.list);
      } else {
        errorData = data;
      }
    }
    if (merged.length === 0) {
      return res.json(errorData || { status: '013', message: '조회된 데이터가 없습니다.' });
    }
    res.json({ status: '000', message: '정상', list: merged });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// DART 공시서류 원본(zip) 버퍼에서 본문 텍스트 추출
function extractDocumentText(zipBuffer) {
  const zip = new AdmZip(zipBuffer);
  const xmlEntries = zip.getEntries().filter(entry => entry.entryName.toLowerCase().endsWith('.xml'));
  if (xmlEntries.length === 0) {
    throw new Error('공시 원본에서 XML 파일을 찾을 수 없습니다.');
  }
  // 본문(가장 큰 파일) 우선
  xmlEntries.sort((a, b) => b.header.size - a.header.size);
  const buffer = xmlEntries[0].getData();

  // XML 선언부에서 인코딩 감지 (DART 원본은 utf-8 또는 euc-kr)
  const head = buffer.slice(0, 200).toString('ascii');
  const encMatch = head.match(/encoding=["']([\w-]+)["']/i);
  const encoding = encMatch ? encMatch[1].toLowerCase() : 'utf-8';
  let xml;
  try {
    xml = new TextDecoder(encoding).decode(buffer);
  } catch (e) {
    xml = buffer.toString('utf8');
  }

  // 표 구조(셀 구분/행 바꿈)를 유지하면서 태그 제거
  return xml
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(TD|TE|TH|TU)>/gi, ' | ')
    .replace(/<\/TR>/gi, '\n')
    .replace(/<\/(P|TABLE|TITLE)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 잠정실적 공시 분석 프롬프트 생성 함수
function createProvisionalAnalysisPrompt(companyName, reportNm, documentText) {
  return `
당신은 재무 분석 전문가입니다. 다음은 ${companyName}의 "${reportNm}" 공시(잠정실적) 원문에서 추출한 내용입니다:

${documentText}

다음 지침을 따라 분석해주세요:
1. 매출액, 영업이익, 당기순이익 등 잠정실적 수치를 정리하고 의미를 설명해주세요.
2. 전년 동기 대비, 직전 분기 대비 증감률이 있다면 해석해주세요.
3. 공시에 포함된 실적 변동 요인이나 회사 측 설명이 있다면 요약해주세요.
4. 공시 원문에 있는 정보만 사용하고, 원문에 없는 내용을 추측해 채우지 마세요. 잠정실적 공시는 항목이 적으므로 짧게 작성해도 됩니다.

출력 형식 (지정된 JSON 스키마를 따르세요):
- sections: 1~3개. category는 results(잠정실적 수치), comparison(전년 동기·직전 분기 대비 증감), drivers(실적 변동 요인·회사 측 설명) 중에서 서로 겹치지 않게 고르고, title에는 섹션 이름(예: "실적 요약")을 한국어로 적으세요.
- drivers 섹션은 공시 원문에 회사가 밝힌 실적 변동 요인이 실제로 있을 때만 만드세요. "설명이 없다"는 내용만 담긴 섹션이나 point는 만들지 마세요.
- "잠정치이므로 확정 실적과 다를 수 있다"는 안내는 화면에 따로 표시되므로 summary와 points에 쓰지 마세요.
- 각 섹션의 points: 1~2개. 각 point는 수치 근거를 담은 한두 문장으로 쓰세요.
- 각 point의 tone: 회사에 긍정적인 내용이면 "positive", 부정적이면 "negative", 어느 쪽도 아니면 "neutral".
- rating: 실적이 전반적으로 개선됐으면 "positive", 개선과 악화가 섞여 있으면 "mixed", 악화됐으면 "negative".
- summary: 실적의 핵심 결론을 1~2문장으로 쓰세요.
- 중요한 수치나 용어는 **별표 두 개**로 감싸 강조하세요. 그 외 HTML 태그나 Markdown 문법은 쓰지 마세요.
`;
}

// 공시 원문의 숫자는 로그인과 AI 호출 없이 제공합니다.
app.get('/api/provisional-financials',async (req,res) => {
  if(typeof req.query.rcept_no!=='string' || !/^\d{14}$/.test(req.query.rcept_no)) return res.status(400).json({status:'error',message:'공시 접수번호를 확인해주세요.'});
  try {
    const response=await dartClient.get('https://opendart.fss.or.kr/api/document.xml',{
      params:{rcept_no:req.query.rcept_no},responseType:'arraybuffer',timeout:12000
    });
    const chartData=parseProvisionalFinancials(readDisclosureXml(Buffer.from(response.data)));
    res.set('Cache-Control','public, max-age=300, s-maxage=3600').json({status:'success',chartData,
      ...(chartData ? {} : {message:'이 공시의 표 형식에서는 실적 수치를 자동으로 읽지 못했습니다. DART 원문에서 확인해주세요.'})});
  } catch(error) {
    console.warn('잠정실적 수치 조회 실패:',{code:error.code || 'PROVISIONAL_DATA_UNAVAILABLE',receipt:req.query.rcept_no});
    res.set('Cache-Control','no-store').status(503).json({status:'error',message:'잠정실적 수치를 불러오지 못했습니다. 잠시 후 다시 시도하거나 DART 원문을 확인해주세요.'});
  }
});

// 잠정실적 공시 AI 분석 API
app.get('/api/provisional-analysis', accounts.requireAnalysis, async (req, res) => {
  try {
    const { rcept_no, corp_name, report_nm } = req.query;
    if (!rcept_no) {
      return res.status(400).json({ status: 'error', message: 'rcept_no는 필수입니다.' });
    }

    // 공시서류 원본파일 다운로드
    const url = `https://opendart.fss.or.kr/api/document.xml?crtfc_key=${config.OPEN_DART_API_KEY}&rcept_no=${rcept_no}`;
    const response = await dartClient.get(url, { responseType: 'arraybuffer' });

    // 오류 시 zip 대신 XML 오류 메시지가 반환됨
    const contentType = response.headers['content-type'] || '';
    if (contentType.includes('xml') || contentType.includes('json')) {
      const errText = Buffer.from(response.data).toString('utf8');
      const msgMatch = errText.match(/<message>([^<]+)<\/message>/);
      throw new Error(msgMatch ? msgMatch[1] : '공시 원본을 내려받지 못했습니다.');
    }

    let documentText = extractDocumentText(Buffer.from(response.data));
    const MAX_DOC_LENGTH = 20000;
    if (documentText.length > MAX_DOC_LENGTH) {
      documentText = documentText.slice(0, MAX_DOC_LENGTH);
    }

    console.log(`잠정실적 분석 요청: ${corp_name || ''} ${report_nm || ''} (rcept_no: ${rcept_no}, 본문 ${documentText.length}자)`);

    const prompt = createProvisionalAnalysisPrompt(corp_name || '해당 회사', report_nm || '잠정실적 공시', documentText);
    // 숫자 시각화는 원문 파서가 담당하고, 모델은 해석만 작성합니다.
    let chartData = null;
    try { chartData = parseProvisionalFinancials(readDisclosureXml(Buffer.from(response.data))); } catch {}
    const result = await runAnalysis(req.analysisUserId,async()=>parseAnalysisJson(await callOpenAIAPI(prompt, PROVISIONAL_ANALYSIS_SCHEMA)));
    result.title = `${corp_name || '해당 회사'} 잠정실적 분석`;

    res.json({ status: 'success', result, chartData: chartData || null });
  } catch (error) {
    const failure=analysisFailure(error);
    if(failure.notice) console.info('AI 분석 이용 안내:',{code:failure.body.code});
    else console.error('잠정실적 분석 중 오류 발생:', error.message);
    if(failure.retryAfter) res.set('Retry-After',String(failure.retryAfter));
    res.status(failure.status).json(failure.body);
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
