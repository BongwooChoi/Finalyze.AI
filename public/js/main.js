// 전역 변수
let selectedCompany = null;
let incomeStatementChart = null;
// let assetCompositionChart = null;
// let liabilityEquityChart = null;
let currentYear = null;
let previousYear = null;
let isFinancialCompany = false; // 금융회사 여부

// 차트 공통 색상 (계정과목별로 모든 차트에서 동일한 색 사용, CVD 검증 통과 팔레트)
const CHART_COLORS = {
  revenue:   { border: '#2563eb', bg: 'rgba(37, 99, 235, 0.65)' },   // 매출액
  opIncome:  { border: '#d97706', bg: 'rgba(217, 119, 6, 0.65)' },   // 영업이익
  netIncome: { border: '#0d9488', bg: 'rgba(13, 148, 136, 0.65)' },  // 당기순이익
  opMargin:  { border: '#7c3aed', bg: 'rgba(124, 58, 237, 0.15)' },  // 영업이익률
  netMargin: { border: '#db2777', bg: 'rgba(219, 39, 119, 0.15)' }   // 순이익률
};

// DOM 요소
const companySearchInput = document.getElementById('companySearch');
const searchBtn = document.getElementById('searchBtn');
const searchResults = document.getElementById('searchResults');
const companyInfoCard = document.getElementById('companyInfoCard');
const companyInfo = document.getElementById('companyInfo');
const yearSelect = document.getElementById('year');
const reportTypeSelect = document.getElementById('reportType');
const analysisCard = document.getElementById('analysisCard');
const analysisCardTitle = document.getElementById('analysisCardTitle');
const bsTableBody = document.getElementById('bsTableBody');
const isTableBody = document.getElementById('isTableBody');
const ratioTableBody = document.getElementById('ratioTableBody');
const incomeStatementChartCanvas = document.getElementById('incomeStatementChart');
const balanceSheetVisContainer = document.getElementById('balanceSheetVisContainer');
// const assetCompositionChartCanvas = document.getElementById('assetCompositionChart');
// const liabilityEquityChartCanvas = document.getElementById('liabilityEquityChart');
const loadingIndicator = document.getElementById('loadingIndicator');
const overviewError = document.getElementById('overviewError');
const aiAnalysisLoading = document.getElementById('aiAnalysisLoading');
const aiAnalysisError = document.getElementById('aiAnalysisError');
const aiAnalysisContent = document.getElementById('aiAnalysisContent');

// 이벤트 리스너 등록
document.addEventListener('DOMContentLoaded', () => {
  // 현재 연도 설정
  const currentYear = new Date().getFullYear();
  yearSelect.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    const year = currentYear - i;
    const option = document.createElement('option');
    option.value = year;
    option.textContent = `${year}년`;
    yearSelect.appendChild(option);
  }
  
  // 서비스 워커 등록
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then(registration => {
        console.log('Service Worker registered with scope:', registration.scope);
      }).catch(error => {
        console.error('Service Worker registration failed:', error);
      });
  }

  // PWA 설치 팝업
  initPwaInstallBanner();
  
  // 검색 버튼 클릭 이벤트
  searchBtn.addEventListener('click', () => searchCompany());

  // 엔터 키 입력 이벤트
  companySearchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      searchCompany();
    }
  });

  // 입력 중 자동완성 (300ms 디바운스)
  let searchDebounceTimer = null;
  companySearchInput.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    const keyword = companySearchInput.value.trim();
    if (keyword.length < 2) {
      searchResults.innerHTML = '';
      return;
    }
    searchDebounceTimer = setTimeout(() => searchCompany(true), 300);
  });

  // 인기 검색 칩
  document.querySelectorAll('#popularChips .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      companySearchInput.value = chip.dataset.name;
      searchCompany();
    });
  });

  // 내보내기 버튼 이벤트
  const exportPdfBtn = document.getElementById('exportPdfBtn');
  const exportImageBtn = document.getElementById('exportImageBtn');
  if (exportPdfBtn) exportPdfBtn.addEventListener('click', exportAnalysisAsPdf);
  if (exportImageBtn) exportImageBtn.addEventListener('click', exportAnalysisAsImage);

  // 잠정실적 내보내기 버튼 이벤트
  const provisionalPdfBtn = document.getElementById('provisionalPdfBtn');
  const provisionalImageBtn = document.getElementById('provisionalImageBtn');
  if (provisionalPdfBtn) provisionalPdfBtn.addEventListener('click', exportProvisionalAsPdf);
  if (provisionalImageBtn) provisionalImageBtn.addEventListener('click', exportProvisionalAsImage);

  // 연간 추이 탭: 처음 열릴 때 데이터 로드
  const trendTab = document.getElementById('trend-tab');
  if (trendTab) trendTab.addEventListener('shown.bs.tab', loadTrendChart);

  // URL 파라미터로부터 상태 복원 (딥링크)
  restoreStateFromUrl();

  // 뒤로가기/앞으로가기 시 해당 상태로 다시 로드
  window.addEventListener('popstate', () => location.reload());
});

// 토스트 메시지 표시
function showToast(message, type = 'info') {
  let stack = document.getElementById('toastStack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'toastStack';
    stack.className = 'toast-stack';
    document.body.appendChild(stack);
  }
  const toast = document.createElement('div');
  toast.className = `app-toast${type === 'error' ? ' toast-error' : ''}`;
  toast.textContent = message;
  stack.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('toast-fade');
    setTimeout(() => toast.remove(), 400);
  }, 3000);
}

// URL 파라미터로부터 회사·공시 선택 상태 복원
async function restoreStateFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const corpCode = params.get('corp');
  if (!corpCode) return;

  const name = params.get('name') || '';
  let company = null;
  if (name) {
    try {
      const response = await fetch(`/api/companies/search?keyword=${encodeURIComponent(name)}`);
      const data = await response.json();
      if (data.status === 'success') {
        company = (data.data || []).find(c => c.corp_code === corpCode) || null;
      }
    } catch (e) {
      console.warn('URL 상태 복원 중 회사 조회 실패:', e);
    }
  }
  if (!company) {
    company = { corp_code: corpCode, corp_name: name || `기업 (${corpCode})`, corp_eng_name: '', stock_code: '', modify_date: '' };
  }

  companySearchInput.value = company.corp_name;
  await selectCompany(company, { skipHistory: true });

  // 공시 항목까지 지정된 경우 해당 분석 자동 실행
  const rcept = params.get('rcept');
  if (rcept) {
    const btn = document.querySelector(`.disclosure-item[data-rcept_no="${rcept}"] .btn-analyze`);
    if (btn) btn.click();
  }
}

// 현재 선택 상태를 URL에 반영
function updateUrlState(rceptNo, { push = false } = {}) {
  if (!selectedCompany) return;
  const params = new URLSearchParams();
  params.set('corp', selectedCompany.corp_code);
  params.set('name', selectedCompany.corp_name);
  if (rceptNo) params.set('rcept', rceptNo);
  const url = `${window.location.pathname}?${params.toString()}`;
  if (push) {
    history.pushState({}, '', url);
  } else {
    history.replaceState({}, '', url);
  }
}

// 회사 검색 함수 (quiet: 자동완성 호출 — 안내 메시지·로딩 표시 없이 조용히 갱신)
let searchRequestSeq = 0;
async function searchCompany(quiet = false) {
  const keyword = companySearchInput.value.trim();

  if (keyword.length < 2) {
    if (!quiet) {
      searchResults.innerHTML = '<div class="alert alert-info">검색어는 2글자 이상 입력해주세요.</div>';
    }
    return;
  }

  if (!quiet) {
    searchResults.innerHTML = '<div class="loading">검색 중...</div>';
  }

  const requestId = ++searchRequestSeq;
  try {
    const response = await fetch(`/api/companies/search?keyword=${encodeURIComponent(keyword)}`);
    const data = await response.json();
    if (requestId !== searchRequestSeq) return; // 더 최신 요청이 있으면 무시

    if (data.status === 'success') {
      displaySearchResults(data.data);
    } else {
      searchResults.innerHTML = `<div class="alert alert-danger">${data.message}</div>`;
    }
  } catch (error) {
    if (requestId !== searchRequestSeq) return;
    console.error('회사 검색 중 오류 발생:', error);
    searchResults.innerHTML = '<div class="alert alert-danger">서버 연결 중 오류가 발생했습니다.</div>';
  }
}

// 검색 결과 표시 함수
function displaySearchResults(companies) {
  searchResults.innerHTML = '';
  
  if (companies.length === 0) {
    searchResults.innerHTML = '<div class="alert alert-info">검색 결과가 없습니다.</div>';
    return;
  }

  // 상장사(종목코드 보유) 우선 정렬
  const isListed = c => (c.stock_code && c.stock_code.trim() ? 1 : 0);
  companies = [...companies].sort((a, b) => isListed(b) - isListed(a));

  const resultDiv = document.createElement('div');
  resultDiv.className = 'list-group';

  companies.forEach(company => {
    const item = document.createElement('div');
    item.className = 'list-group-item company-item';
    
    const stockCode = company.stock_code && company.stock_code.trim() ? company.stock_code : '상장되지 않음';
    
    item.innerHTML = `
      <div class="d-flex justify-content-between align-items-center">
        <h5 class="mb-1">${company.corp_name}</h5>
        <span class="badge ${stockCode !== '상장되지 않음' ? 'bg-success' : 'bg-secondary'}">${stockCode}</span>
      </div>
      <p class="mb-1">${company.corp_eng_name || ''}</p>
      <small>고유번호: ${company.corp_code}</small>
    `;
    
    item.addEventListener('click', () => selectCompany(company));
    resultDiv.appendChild(item);
  });
  
  searchResults.appendChild(resultDiv);
}

// 회사 선택 함수
async function selectCompany(company, { skipHistory = false } = {}) {
  selectedCompany = company;

  // 앱 모드 전환 (히어로 축소, 기능소개 숨김)
  document.body.classList.add('app-mode');

  // 검색 결과 닫기
  searchResults.innerHTML = '';

  // URL에 회사 상태 반영
  if (!skipHistory) {
    updateUrlState(null, { push: true });
  }

  // 회사 정보 표시
  companyInfoCard.style.display = 'block';
  companyInfo.innerHTML = `
    <div class="row">
      <div class="col-md-6">
        <h4>${company.corp_name}</h4>
        <p>${company.corp_eng_name || ''}</p>
        <p><strong>고유번호:</strong> ${company.corp_code}</p>
      </div>
      <div class="col-md-6">
        <p><strong>종목코드:</strong> ${company.stock_code && company.stock_code.trim() ? company.stock_code : '상장되지 않음'}</p>
        <p><strong>최종변경일자:</strong> ${formatDate(company.modify_date)}</p>
      </div>
    </div>
  `;

  // 이전 회사의 분석 결과 초기화
  analysisCard.style.display = 'none';
  document.getElementById('provisionalCard').style.display = 'none';
  if (incomeStatementChart) {
    incomeStatementChart.destroy();
    incomeStatementChart = null;
  }
  if (balanceSheetVisContainer) {
    balanceSheetVisContainer.innerHTML = '';
  }
  if (analysisCard) {
    document.getElementById('chartRow').style.display = 'none';
  }
  resetTrendChart();

  // disclosure list 표시
  await fetchAndDisplayDisclosureList(company.corp_code);

  // 화면 스크롤
  document.getElementById('disclosureListContainer').scrollIntoView({ behavior: 'smooth' });
}

// 통합 재무분석 조회 함수
async function fetchFinancialAnalysis() {
  if (!selectedCompany) {
    showToast('회사를 먼저 선택해주세요.', 'error');
    return;
  }
  
  const year = yearSelect.value;
  const reportCode = reportTypeSelect.value;
  
  // 보고서 코드 -> 보고서 이름 매핑
  const reportCodeMap = {
    '11011': '사업보고서',
    '11012': '반기보고서',
    '11013': '1분기보고서',
    '11014': '3분기보고서'
  };
  const reportName = reportCodeMap[reportCode] || '보고서';
  
  // 연도 저장
  currentYear = year;
  previousYear = String(parseInt(year) - 1);
  
  // 카드 제목 업데이트
  analysisCardTitle.innerHTML = `${selectedCompany.corp_name} - ${year}년 ${reportName} 분석`;
  
  // 로딩 표시 및 초기화 (여기서 보여주기만 함)
  analysisCard.style.display = 'block';
  loadingIndicator.style.display = 'block'; // 보여주기
  overviewError.style.display = 'none';
  document.getElementById('chartRow').style.display = 'none';
  
  // 테이블 내용 초기화
  bsTableBody.innerHTML = '';
  isTableBody.innerHTML = '';
  ratioTableBody.innerHTML = '';
  
  try {
    // 요청 과정 로깅
    console.log('재무분석 API 요청:', `/api/financial-analysis?corp_code=${selectedCompany.corp_code}&bsns_year=${year}&reprt_code=${reportCode}`);
    
    const response = await fetch(`/api/financial-analysis?corp_code=${selectedCompany.corp_code}&bsns_year=${year}&reprt_code=${reportCode}`);
    
    // 응답 상태 확인
    if (!response.ok) {
      // 보고서가 없는 경우 사용자에게 친절한 안내 메시지 표시
      if (response.status === 404) {
        loadingIndicator.style.display = 'none';
        overviewError.style.display = 'block';
        overviewError.textContent = `${year}년 ${reportName}는 아직 공시되지 않았습니다.`;
        console.warn(`데이터 없음: ${year}년 ${reportName}`); // 콘솔에도 로그 추가
        failAnalysisGuide(`${year}년 ${reportName}`);
        return; // 함수 종료
      }
      // 기타 HTTP 오류 처리
      const errorText = await response.text();
      console.error('HTTP 오류 응답:', response.status, errorText);
      throw new Error(`HTTP 오류 (${response.status}): ${errorText || '응답이 없습니다'}`);
    }
    
    const data = await response.json();
    console.log('재무분석 API 응답:', data);
    
    if (data.status === 'success') {
      // 데이터 표시 함수 호출
      displayFinancialAnalysis(data.data);
    } else {
      // 오류 처리 (loadingIndicator 숨기는 로직 제거)
      loadingIndicator.style.display = 'none'; // 오류 시에는 여기서 바로 숨김
      overviewError.style.display = 'block';
      overviewError.textContent = data.message || '데이터를 불러오는 중 오류';
      console.error('재무분석 API 오류:', data.message);
      failAnalysisGuide(`${year}년 ${reportName}`);
    }
  } catch (error) {
    // 네트워크/기타 오류 처리 (loadingIndicator 숨김)
    console.error('재무분석 데이터 조회 중 오류 발생:', error);
    loadingIndicator.style.display = 'none';
    overviewError.style.display = 'block';
    overviewError.textContent = `데이터 조회 오류: ${error.message || '알 수 없는 오류'}`;
    failAnalysisGuide(`${year}년 ${reportName}`);
  }
}

// 통합 재무분석 표시 함수
function displayFinancialAnalysis(analysis) {
  console.log('--- displayFinancialAnalysis called ---', analysis);
  try {
    // !!! 여기서 메인 로딩 인디케이터 숨기기 !!!
    loadingIndicator.style.display = 'none';

    // 금융회사 여부 저장
    isFinancialCompany = analysis.isFinancialCompany || false;
    console.log('금융회사 여부:', isFinancialCompany);

    // 1. 개요 탭 내용 생성
    console.log('Calling chart/vis display functions...');
    displayIncomeStatementChart(analysis);
    displayBalanceSheetVis(analysis);
    // displayCompositionCharts(analysis);
    console.log('Calling AI analysis function...');
    fetchAIFinancialAnalysis(analysis); 

    // 2. 다른 탭 내용 생성
    displayBalanceSheetTable(analysis.balanceSheet || {});
    displayIncomeStatementTable(analysis.incomeStatement || {});
    displayRatioTable(analysis.ratio || {});

    // 3. 개요 탭 내용 (차트 영역) 표시
    document.getElementById('chartRow').style.display = 'flex'; 
    
    // 분석 가이드 업데이트
    const reportCodeMap = { '11011': '사업보고서', '11012': '반기보고서', '11013': '1분기보고서', '11014': '3분기보고서' };
    updateAnalysisGuide(`${selectedCompany.corp_name} ${currentYear}년 ${reportCodeMap[reportTypeSelect.value] || '보고서'}`);
    
    // 화면 스크롤
    analysisCard.scrollIntoView({ behavior: 'smooth' });
    
  } catch (error) {
    console.error('Error in displayFinancialAnalysis:', error);
    loadingIndicator.style.display = 'none'; // 혹시 모를 오류 시에도 숨김
    overviewError.style.display = 'block';
    overviewError.textContent = `재무분석 표시 중 오류: ${error.message}`;
    document.getElementById('chartRow').style.display = 'none';
  }
}

// AI 기반 재무분석 가져오기
async function fetchAIFinancialAnalysis(analysis) {
  console.log('--- fetchAIFinancialAnalysis called ---');
  try {
    aiAnalysisLoading.style.display = 'block';
    aiAnalysisError.style.display = 'none';
    aiAnalysisContent.style.display = 'none';
    
    const financialData = {
      companyName: selectedCompany.corp_name,
      year: currentYear,
      previousYear: previousYear,
      balanceSheet: analysis.balanceSheet,
      incomeStatement: analysis.incomeStatement,
      ratio: analysis.ratio,
      isFinancialCompany: isFinancialCompany
    };
    
    const response = await fetch('/api/ai-financial-analysis', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(financialData)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AI 분석 API 오류 (${response.status}): ${errorText || '응답이 없습니다'}`);
    }
    
    const data = await response.json();
    console.log('AI Analysis API Response Data:', data);
    
    if (data.status === 'success') {
      aiAnalysisLoading.style.display = 'none';
      aiAnalysisContent.style.display = 'block';
      
      // AI 분석 결과 표시 - 마크다운 코드 블록 제거 및 HTML 변환
      let analysisText = data.analysis;
      
      // ```html 및 ``` 제거
      analysisText = analysisText.replace(/^```html\\s*\\n?/, '').replace(/\\n?```$/, '').trim();
      
      // 제목 처리 (첫 번째 줄)
      const lines = analysisText.split('\\n');
      let title = '';
      let contentText = analysisText;
      
      if (lines.length > 0) {
        title = lines[0];
        contentText = lines.slice(1).join('\\n');
      }
      
      // 문단 나누기
      const paragraphs = contentText.split('\\n\\n').filter(p => p.trim() !== '');
      
      // 결과 HTML 생성
      let htmlContent = `<h4 class="mb-3">${title}</h4>`;
      
      paragraphs.forEach(para => {
        // HTML 태그가 포함된 문단은 그대로 사용, 아닌 경우 <p> 추가
        if (para.startsWith('<') && para.endsWith('>')) {
          htmlContent += para;
        } else {
          htmlContent += `<p>${para}</p>`;
        }
      });
      
      aiAnalysisContent.innerHTML = `<div class="ai-analysis">${htmlContent}</div>`;
      console.log('AI Analysis Content displayed.');
    } else {
      throw new Error(data.message || 'AI 분석 결과를 가져오지 못했습니다.');
    }
  } catch (error) {
    console.error('Error in fetchAIFinancialAnalysis:', error);
    aiAnalysisLoading.style.display = 'none';
    aiAnalysisError.style.display = 'block';
    aiAnalysisError.textContent = `AI 분석을 가져오는 중 오류가 발생했습니다: ${error.message}`;
  }
}

// 손익계산서 차트 표시 함수
function displayIncomeStatementChart(analysis) {
  console.log('--- displayIncomeStatementChart called ---');
  try {
    if (!incomeStatementChartCanvas) {
      console.error('Income statement canvas not found!');
      return;
    }
    if (incomeStatementChart) incomeStatementChart.destroy();

    // !!! DataLabels 플러그인 등록 !!!
    // Chart.register(ChartDataLabels); // Chart.js 3.x 이상에서는 전역 등록이 필요 없음

    const ctx = incomeStatementChartCanvas.getContext('2d');

    // 금융회사의 경우 '영업수익'을 매출액 대신 사용
    const revenueKey = isFinancialCompany ? '영업수익' : '매출액';
    const revenueLabel = isFinancialCompany ? '영업수익' : '매출액';

    // 데이터 준비
    const salesCurrent = analysis.incomeStatement?.[revenueKey]?.current || 0;
    const opIncomeCurrent = analysis.incomeStatement?.['영업이익']?.current || 0;
    const netIncomeCurrent = analysis.incomeStatement?.['당기순이익']?.current || 0;
    const salesPrevious = analysis.incomeStatement?.[revenueKey]?.previous || 0;
    const opIncomePrevious = analysis.incomeStatement?.['영업이익']?.previous || 0;
    const netIncomePrevious = analysis.incomeStatement?.['당기순이익']?.previous || 0;

    console.log(`Margin Calculation Inputs (${currentYear}): Sales=${salesCurrent}, OpIncome=${opIncomeCurrent}, NetIncome=${netIncomeCurrent}`);
    console.log(`Margin Calculation Inputs (${previousYear}): Sales=${salesPrevious}, OpIncome=${opIncomePrevious}, NetIncome=${netIncomePrevious}`);

    // 이익률 계산 (%)
    const opMarginCurrent = salesCurrent !== 0 ? ((opIncomeCurrent / salesCurrent) * 100).toFixed(2) : 0;
    const netMarginCurrent = salesCurrent !== 0 ? ((netIncomeCurrent / salesCurrent) * 100).toFixed(2) : 0;
    const opMarginPrevious = salesPrevious !== 0 ? ((opIncomePrevious / salesPrevious) * 100).toFixed(2) : 0;
    const netMarginPrevious = salesPrevious !== 0 ? ((netIncomePrevious / salesPrevious) * 100).toFixed(2) : 0;

    console.log(`Calculated Margins (${currentYear}): OpMargin=${opMarginCurrent}%, NetMargin=${netMarginCurrent}%`);
    console.log(`Calculated Margins (${previousYear}): OpMargin=${opMarginPrevious}%, NetMargin=${netMarginPrevious}%`);

    // 보고서 유형에 따른 기간 문자열 생성
    const reportType = reportTypeSelect.value;
    let currentPeriodString = `${currentYear}년`;
    let previousPeriodString = `${previousYear}년`;

    if (reportType === '11012') { // 반기보고서
      currentPeriodString = `${currentYear}년 반기`;
      previousPeriodString = `${previousYear}년 반기`;
    } else if (reportType === '11013') { // 1분기보고서
      currentPeriodString = `${currentYear}년 1분기`;
      previousPeriodString = `${previousYear}년 1분기`;
    } else if (reportType === '11014') { // 3분기보고서
      currentPeriodString = `${currentYear}년 3분기`;
      previousPeriodString = `${previousYear}년 3분기`;
    }

    const labels = [previousPeriodString, currentPeriodString];

    const chartData = {
        labels: labels,
        datasets: [
          // --- 막대 차트 그룹 ---
          {
            type: 'bar',
            label: revenueLabel,
            data: [salesPrevious, salesCurrent],
            backgroundColor: CHART_COLORS.revenue.bg,
            borderColor: CHART_COLORS.revenue.border,
            borderWidth: 1,
            borderRadius: 4,
            yAxisID: 'y-axis-amount',
            order: 2 // 막대 차트가 뒤에 오도록 order 설정
          },
          {
            type: 'bar',
            label: '영업이익', // 영업이익 막대 추가
            data: [opIncomePrevious, opIncomeCurrent],
            backgroundColor: CHART_COLORS.opIncome.bg,
            borderColor: CHART_COLORS.opIncome.border,
            borderWidth: 1,
            borderRadius: 4,
            yAxisID: 'y-axis-amount',
            order: 2 // 막대 차트가 뒤에 오도록 order 설정
          },
          {
            type: 'bar',
            label: '당기순이익', // 당기순이익 막대 추가
            data: [netIncomePrevious, netIncomeCurrent],
            backgroundColor: CHART_COLORS.netIncome.bg,
            borderColor: CHART_COLORS.netIncome.border,
            borderWidth: 1,
            borderRadius: 4,
            yAxisID: 'y-axis-amount',
            order: 2 // 막대 차트가 뒤에 오도록 order 설정
          },
          // --- 선 차트 그룹 ---
          {
            type: 'line',
            label: '영업이익률 (%)',
            data: [opMarginPrevious, opMarginCurrent],
            borderColor: CHART_COLORS.opMargin.border,
            backgroundColor: CHART_COLORS.opMargin.bg,
            borderWidth: 2,
            fill: false,
            tension: 0.1,
            yAxisID: 'y-axis-percent',
            order: 1 // 선 차트가 앞에 오도록 order 설정
          },
          {
            type: 'line',
            label: '당기순이익률 (%)',
            data: [netMarginPrevious, netMarginCurrent],
            borderColor: CHART_COLORS.netMargin.border,
            backgroundColor: CHART_COLORS.netMargin.bg,
            borderWidth: 2,
            fill: false,
            tension: 0.1,
            yAxisID: 'y-axis-percent',
            order: 1 // 선 차트가 앞에 오도록 order 설정
          }
        ]
      };

    const hasValidData = salesCurrent !== 0 || salesPrevious !== 0; // 매출액 기준으로 유효성 판단
    if (!hasValidData) {
        console.warn('No valid sales data to display chart.');
        incomeStatementChartCanvas.parentElement.innerHTML = '<p class="text-center text-muted small">손익계산서 데이터 없음</p>';
        return;
    }

    console.log('Creating Income Statement Chart...');
    incomeStatementChart = new Chart(ctx, {
      data: chartData,
      plugins: [ChartDataLabels], // DataLabels 플러그인 추가
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: {
            display: true,
            text: '주요 손익 현황 및 이익률 추이', // 제목 변경
            font: { size: 14, weight: 'bold' },
            padding: {
              bottom: 20 // 제목 아래에 20px 여백 추가
            }
          },
          tooltip: {
            callbacks: {
              label: function(context) {
                let label = context.dataset.label || '';
                if (label) {
                  label += ': ';
                }
                if (context.dataset.yAxisID === 'y-axis-percent') {
                    label += `${context.formattedValue}%`;
                } else {
                    label += formatAmountBetter(context.raw);
                }
                return label;
              }
            }
          },
          legend: { display: true, position: 'bottom' },
          datalabels: { // DataLabels 설정
            display: true,
            anchor: 'end', // 데이터 포인트 끝에 레이블 표시
            align: 'end', // 레이블 정렬
            formatter: (value, context) => {
              if (context.dataset.yAxisID === 'y-axis-percent') {
                // 비율 데이터는 소수점 둘째자리까지 %로 표시
                return `${parseFloat(value).toFixed(2)}%`;
              } else {
                // 금액 데이터는 formatAmountBetter 함수 사용 (shortFormat=true)
                return formatAmountBetter(value, true);
              }
            },
            font: {
              size: 10
            },
            color: '#666' // 레이블 색상
          }
        },
        scales: {
          'y-axis-amount': { // 왼쪽 Y축 (금액)
            type: 'linear',
            display: true,
            position: 'left',
            beginAtZero: true,
            title: {
                display: true,
                text: '금액 (원)' // 축 제목 수정
            },
            ticks: {
              callback: function(value) { return formatAmountBetter(value, true); }
            }
          },
          'y-axis-percent': { // 오른쪽 Y축 (비율)
            type: 'linear',
            display: true,
            position: 'right',
            // beginAtZero: true, // 비율은 음수일 수 있으므로 0 시작 강제 안함
            grid: {
              drawOnChartArea: false, // 오른쪽 축 그리드 라인 숨김
            },
            title: {
                display: true,
                text: '이익률 (%)'
            },
            ticks: {
              callback: function(value) { return value + '%'; }
            }
          }
        }
      }
    });
    console.log('Income Statement Chart CREATED with new datasets and labels.');
  } catch (error) {
    console.error('Error in displayIncomeStatementChart:', error);
    if(incomeStatementChartCanvas) incomeStatementChartCanvas.parentElement.innerHTML = '<p class="text-center text-danger small">손익 차트 오류</p>';
  }
}

// =============================================
// 연간 추이 차트 (최근 5개년)
// =============================================
let trendChart = null;
let trendLoadedFor = null;

function resetTrendChart() {
  trendLoadedFor = null;
  if (trendChart) {
    trendChart.destroy();
    trendChart = null;
  }
  const trendError = document.getElementById('trendError');
  if (trendError) trendError.style.display = 'none';
}

async function loadTrendChart() {
  if (!selectedCompany) return;
  if (trendLoadedFor === selectedCompany.corp_code) return;

  const loading = document.getElementById('trendLoading');
  const errorBox = document.getElementById('trendError');
  const canvas = document.getElementById('trendChart');
  if (!canvas) return;

  loading.style.display = 'block';
  errorBox.style.display = 'none';

  try {
    const response = await fetch(`/api/financial-trend?corp_code=${selectedCompany.corp_code}`);
    const data = await response.json();
    if (!response.ok || data.status !== 'success') {
      throw new Error(data.message || '추이 데이터를 불러오지 못했습니다.');
    }

    const { years, series } = data.data;
    trendLoadedFor = selectedCompany.corp_code;

    if (trendChart) trendChart.destroy();
    trendChart = new Chart(canvas.getContext('2d'), {
      data: {
        labels: years.map(y => `${y}년`),
        datasets: [
          {
            type: 'bar',
            label: '매출액',
            data: series.revenue,
            backgroundColor: CHART_COLORS.revenue.bg,
            borderColor: CHART_COLORS.revenue.border,
            borderWidth: 1,
            borderRadius: 4,
            order: 2
          },
          {
            type: 'line',
            label: '영업이익',
            data: series.operatingIncome,
            borderColor: CHART_COLORS.opIncome.border,
            backgroundColor: CHART_COLORS.opIncome.bg,
            borderWidth: 2,
            tension: 0.1,
            pointRadius: 4,
            order: 1
          },
          {
            type: 'line',
            label: '당기순이익',
            data: series.netIncome,
            borderColor: CHART_COLORS.netIncome.border,
            backgroundColor: CHART_COLORS.netIncome.bg,
            borderWidth: 2,
            tension: 0.1,
            pointRadius: 4,
            order: 1
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: {
            display: true,
            text: `${selectedCompany.corp_name} 최근 5개년 연간 실적 추이 (사업보고서 기준)`,
            font: { size: 14, weight: 'bold' },
            padding: { bottom: 20 }
          },
          legend: { position: 'bottom' },
          tooltip: {
            callbacks: {
              label: ctx => `${ctx.dataset.label}: ${formatAmountBetter(ctx.raw)}`
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            title: { display: true, text: '금액 (원)' },
            ticks: { callback: value => formatAmountBetter(value, true) }
          }
        }
      }
    });
  } catch (error) {
    console.error('추이 차트 로드 중 오류 발생:', error);
    errorBox.textContent = error.message || '추이 데이터를 불러오지 못했습니다.';
    errorBox.style.display = 'block';
  } finally {
    loading.style.display = 'none';
  }
}

// 재무상태표 시각화 표시 함수 (수정)
function displayBalanceSheetVis(analysis) {
  console.log('--- displayBalanceSheetVis called ---');
  try {
    if (!balanceSheetVisContainer) {
      console.error('Balance sheet visualization container not found!');
      return;
    }
    balanceSheetVisContainer.innerHTML = ''; // 이전 내용 지우기

    // 컨테이너 스타일 설정 (flex column으로 하여 제목과 차트가 수직으로 쌓이도록)
    balanceSheetVisContainer.style.display = 'flex';
    balanceSheetVisContainer.style.flexDirection = 'column';
    balanceSheetVisContainer.style.alignItems = 'stretch'; // 자식 요소들이 컨테이너 너비를 꽉 채우도록

    const assets = analysis.balanceSheet?.['자산총계']?.current || 0;
    const liabilities = analysis.balanceSheet?.['부채총계']?.current || 0;
    const equity = analysis.balanceSheet?.['자본총계']?.current || 0;

    // 데이터 유효성 검사
    if (assets <= 0) {
      console.warn('No valid balance sheet data for visualization.');
      balanceSheetVisContainer.innerHTML = '<p class="text-center text-muted small">재무상태표 데이터 없음</p>';
      return;
    }

    // 부채 + 자본 ~= 자산 확인
    if (Math.abs(assets - (liabilities + equity)) / assets > 0.01) { // 1% 이상 차이나면 경고
      console.warn(`Balance Sheet Equation Check Failed: A(${assets}) != L(${liabilities}) + E(${equity})`);
      // 간단히 합계로 자산을 대체하거나 오류 표시 가능
    }

    // 비율 계산
    const liabilityPercent = assets > 0 ? (liabilities / assets) * 100 : 0;
    const equityPercent = assets > 0 ? (equity / assets) * 100 : 0;

    // HTML 생성
    // h6 태그는 align-items: stretch에 의해 자동으로 width: 100%가 되므로 text-center가 잘 동작합니다.
    // div.bs-vis-box는 width: 100%와 max-width를 설정하여 반응형으로 중앙에 위치하도록 합니다.
    const visHTML = `
      <h6 class="text-center fw-bold mb-2">${currentYear}년 재무상태표 구조</h6>
      <div class="bs-vis-box d-flex mx-auto" style="width: 100%; max-width: 400px;">
        <!-- 자산 (왼쪽) -->
        <div class="bs-vis-section asset-box d-flex flex-column justify-content-center align-items-center">
          <span class="bs-vis-label">자산</span>
          <span class="bs-vis-value">${formatAmountBetter(assets, true)}</span>
        </div>
        <!-- 부채 + 자본 (오른쪽) -->
        <div class="bs-vis-section d-flex flex-column">
          <div class="liability-box flex-grow-1 d-flex flex-column justify-content-center align-items-center" style="height: ${liabilityPercent}%;">
            <span class="bs-vis-label">부채</span>
            <span class="bs-vis-value">${formatAmountBetter(liabilities, true)}</span>
          </div>
          <div class="equity-box flex-grow-1 d-flex flex-column justify-content-center align-items-center" style="height: ${equityPercent}%;">
            <span class="bs-vis-label">자본</span>
            <span class="bs-vis-value">${formatAmountBetter(equity, true)}</span>
          </div>
        </div>
      </div>
    `;

    console.log('Creating Balance Sheet Visualization...');
    balanceSheetVisContainer.innerHTML = visHTML;
    console.log('Balance Sheet Visualization CREATED.');

  } catch (error) {
    console.error('Error in displayBalanceSheetVis:', error);
    if(balanceSheetVisContainer) balanceSheetVisContainer.innerHTML = '<p class="text-center text-danger small">재무상태표 시각화 오류</p>';
  }
}

// 재무상태표 테이블 표시 함수
function displayBalanceSheetTable(balanceSheet) {
  bsTableBody.innerHTML = '';
  
  const items = Object.keys(balanceSheet);
  
  if (items.length === 0) {
    bsTableBody.innerHTML = '<tr><td colspan="5" class="text-center">재무상태표 데이터가 없습니다.</td></tr>';
    return;
  }
  
  // 보고서 유형에 따른 기간 문자열 생성
  const reportType = reportTypeSelect.value;
  let currentPeriodString = `${currentYear}년`;
  let previousPeriodString = `${previousYear}년`;

  if (reportType === '11012') { // 반기보고서
    currentPeriodString = `${currentYear}년 반기`;
    previousPeriodString = `${previousYear}년 반기`;
  } else if (reportType === '11013') { // 1분기보고서
    currentPeriodString = `${currentYear}년 1분기`;
    previousPeriodString = `${previousYear}년 1분기`;
  } else if (reportType === '11014') { // 3분기보고서
    currentPeriodString = `${currentYear}년 3분기`;
    previousPeriodString = `${previousYear}년 3분기`;
  }
  
  items.forEach(item => {
    const current = balanceSheet[item]?.current || 0;
    const previous = balanceSheet[item]?.previous || 0;
    const diff = current - previous;
    const diffRate = previous !== 0 ? (diff / previous * 100).toFixed(2) : '-';
    
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${item}</td>
      <td class="text-end" data-label="당기">${formatAmountBetter(current)} <small class="text-muted">(${currentPeriodString})</small></td>
      <td class="text-end" data-label="전기">${formatAmountBetter(previous)} <small class="text-muted">(${previousPeriodString})</small></td>
      <td class="text-end ${diff >= 0 ? 'text-success' : 'text-danger'}" data-label="증감">${formatAmountBetter(diff)}</td>
      <td class="text-end ${diff >= 0 ? 'text-success' : 'text-danger'}" data-label="증감율">${diffRate !== '-' ? diffRate + '%' : '-'}</td>
    `;

    bsTableBody.appendChild(row);
  });
}

// 손익계산서 테이블 표시 함수
function displayIncomeStatementTable(incomeStatement) {
  isTableBody.innerHTML = '';
  
  const items = Object.keys(incomeStatement);
  
  if (items.length === 0) {
    isTableBody.innerHTML = '<tr><td colspan="5" class="text-center">손익계산서 데이터가 없습니다.</td></tr>';
    return;
  }
  
  // 보고서 유형에 따른 기간 문자열 생성
  const reportType = reportTypeSelect.value;
  let currentPeriodString = `${currentYear}년`;
  let previousPeriodString = `${previousYear}년`;

  if (reportType === '11012') { // 반기보고서
    currentPeriodString = `${currentYear}년 반기`;
    previousPeriodString = `${previousYear}년 반기`;
  } else if (reportType === '11013') { // 1분기보고서
    currentPeriodString = `${currentYear}년 1분기`;
    previousPeriodString = `${previousYear}년 1분기`;
  } else if (reportType === '11014') { // 3분기보고서
    currentPeriodString = `${currentYear}년 3분기`;
    previousPeriodString = `${previousYear}년 3분기`;
  }
  
  items.forEach(item => {
    const current = incomeStatement[item]?.current || 0;
    const previous = incomeStatement[item]?.previous || 0;
    const diff = current - previous;
    const diffRate = previous !== 0 ? (diff / previous * 100).toFixed(2) : '-';
    
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${item}</td>
      <td class="text-end" data-label="당기">${formatAmountBetter(current)} <small class="text-muted">(${currentPeriodString})</small></td>
      <td class="text-end" data-label="전기">${formatAmountBetter(previous)} <small class="text-muted">(${previousPeriodString})</small></td>
      <td class="text-end ${diff >= 0 ? 'text-success' : 'text-danger'}" data-label="증감">${formatAmountBetter(diff)}</td>
      <td class="text-end ${diff >= 0 ? 'text-success' : 'text-danger'}" data-label="증감율">${diffRate !== '-' ? diffRate + '%' : '-'}</td>
    `;

    isTableBody.appendChild(row);
  });
}

// 재무비율 테이블 표시 함수
function displayRatioTable(ratio) {
  ratioTableBody.innerHTML = '';

  // 테이블에 표시할 비율 항목 (금융회사/일반기업 구분)
  const generalItems = [
    '유동비율', '당좌비율', '부채비율', '자기자본비율',
    '매출액영업이익률', '매출액순이익률', 'ROE', 'ROA'
  ];
  const financialItems = [
    '부채비율', '자기자본비율', '영업이익률', '순이익률', 'ROE', 'ROA'
  ];
  const items = isFinancialCompany ? financialItems : generalItems;
  
  // 테이블 생성
  if (Object.keys(ratio).length === 0) {
    ratioTableBody.innerHTML = '<tr><td colspan="4" class="text-center">재무비율 데이터가 없습니다.</td></tr>';
    return;
  }

  // 보고서 유형에 따른 기간 문자열 생성
  const reportType = reportTypeSelect.value;
  let currentPeriodString = `${currentYear}년`;
  let previousPeriodString = `${previousYear}년`;

  if (reportType === '11012') { // 반기보고서
    currentPeriodString = `${currentYear}년 반기`;
    previousPeriodString = `${previousYear}년 반기`;
  } else if (reportType === '11013') { // 1분기보고서
    currentPeriodString = `${currentYear}년 1분기`;
    previousPeriodString = `${previousYear}년 1분기`;
  } else if (reportType === '11014') { // 3분기보고서
    currentPeriodString = `${currentYear}년 3분기`;
    previousPeriodString = `${previousYear}년 3분기`;
  }
  
  // 실제 존재하는 항목만 표시
  items.forEach(item => {
    if (ratio[item]) {
      const current = parseFloat(ratio[item]?.current || 0);
      const previous = parseFloat(ratio[item]?.previous || 0);
      const diff = (current - previous).toFixed(2);
      
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${item}</td>
        <td class="text-end" data-label="당기">${current}% <small class="text-muted">(${currentPeriodString})</small></td>
        <td class="text-end" data-label="전기">${previous}% <small class="text-muted">(${previousPeriodString})</small></td>
        <td class="text-end ${diff >= 0 ? 'text-success' : 'text-danger'}" data-label="증감">${diff}%p</td>
      `;

      ratioTableBody.appendChild(row);
    }
  });
}

// 날짜 포맷 함수 (YYYYMMDD -> YYYY-MM-DD)
function formatDate(dateString) {
  if (!dateString || dateString.length !== 8) return dateString;
  return `${dateString.substring(0, 4)}-${dateString.substring(4, 6)}-${dateString.substring(6, 8)}`;
}

// 금액 포맷 함수 (숫자 형식 추가) - 기존 함수
function formatAmount(amount) {
  if (!amount) return '-';
  return amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// 개선된 금액 단위 표시 함수 (자동 단위 변환)
function formatAmountBetter(amount, shortFormat = false) {
  if (amount === null || amount === undefined || isNaN(amount)) return '-';
  
  // 부호 처리
  const isNegative = amount < 0;
  const absAmount = Math.abs(amount);
  
  // 단위별 변환
  let formattedAmount = '';
  let unit = '';
  
  if (absAmount >= 1000000000000) { // 1조 이상
    formattedAmount = (absAmount / 1000000000000).toFixed(1);
    unit = '조';
  } else if (absAmount >= 100000000) { // 1억 이상
    formattedAmount = (absAmount / 100000000).toFixed(1);
    unit = '억';
  } else if (absAmount >= 10000) { // 1만 이상
    formattedAmount = (absAmount / 10000).toFixed(1);
    unit = '만';
  } else {
    formattedAmount = absAmount.toString();
    unit = '';
  }
  
  // 소수점 뒤가 .0인 경우 제거
  if (formattedAmount.endsWith('.0')) {
    formattedAmount = formattedAmount.slice(0, -2);
  }
  
  // 천 단위 콤마 적용
  formattedAmount = formattedAmount.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  
  // 부호와 단위 결합
  const signPrefix = isNegative ? '-' : '';
  
  // 차트 축에 표시할 경우 짧은 포맷 사용
  if (shortFormat) {
    return `${signPrefix}${formattedAmount}${unit}`;
  } else {
    const wonSuffix = unit ? '원' : '원';
    return `${signPrefix}${formattedAmount}${unit}${wonSuffix}`;
  }
}

// 잠정실적(공정공시) 공시 여부 판별
function isProvisionalDisclosure(reportNm) {
  return reportNm.includes('잠정') && reportNm.includes('실적');
}

// disclosure list 표시 함수 추가
async function fetchAndDisplayDisclosureList(corpCode) {
  const container = document.getElementById('disclosureListContainer');
  container.style.display = 'block';
  container.innerHTML = '<div class="loading">공시 목록을 불러오는 중...</div>';
  try {
    const response = await fetch(`/api/disclosure-list?corp_code=${corpCode}`);
    const data = await response.json();
    if (data.status !== '000' || !data.list || data.list.length === 0) {
      container.innerHTML = '<div class="alert alert-warning">최근 3년간 공시가 없습니다.</div>';
      return;
    }
    // 최근 3년치만 필터링
    const nowYear = new Date().getFullYear();
    const minYear = nowYear - 2;
    // 명확한 보고서만 추림 (1분기/반기/3분기/사업보고서 + 분기보고서(03,09) + 잠정실적)
    const filtered = data.list.filter(item => {
      // 연도 추출 (보고서명에 연도가 없으면 접수일 기준)
      const yearMatch = item.report_nm.match(/(\d{4})/);
      const year = yearMatch ? parseInt(yearMatch[1]) : parseInt(item.rcept_dt.slice(0, 4));
      if (!year || year < minYear) return false;
      if (isProvisionalDisclosure(item.report_nm)) return true;
      if (item.report_nm.includes('사업보고서')) return true;
      if (item.report_nm.includes('반기보고서')) return true;
      if (item.report_nm.includes('1분기보고서')) return true;
      if (item.report_nm.includes('3분기보고서')) return true;
      // 분기보고서(1/3분기 명시 없는 경우) 월로 판별
      if (item.report_nm.includes('분기보고서')) {
        const monthMatch = item.report_nm.match(/\((\d{4})\.(\d{2})/);
        if (monthMatch) {
          const mm = monthMatch[2];
          if (mm === '03' || mm === '09') return true;
        }
      }
      return false;
    });
    if (filtered.length === 0) {
      container.innerHTML = '<div class="alert alert-warning">최근 3년간 사업/반기/분기보고서 및 잠정실적 공시가 없습니다.</div>';
      return;
    }
    // 최신순 정렬
    filtered.sort((a, b) => b.rcept_dt.localeCompare(a.rcept_dt));
    // 리스트 표시
    let html = '<div class="card disclosure-card"><div class="card-header"><h3><i class="bi bi-journal-text me-2"></i>최근 3년 정기공시·잠정실적 공시</h3></div><ul class="list-group list-group-flush">';
    filtered.forEach(item => {
      const badge = isProvisionalDisclosure(item.report_nm)
        ? '<span class="badge disclosure-badge badge-provisional">잠정실적</span>'
        : '<span class="badge disclosure-badge badge-periodic">정기공시</span>';
      html += `<li class="list-group-item disclosure-item" data-rcept_no="${item.rcept_no}" data-report_nm="${item.report_nm}">
        <div class="disclosure-info">
          <span class="disclosure-title">${badge}${item.report_nm}</span>
          <span class="disclosure-date">${item.rcept_dt}</span>
        </div>
        <div class="disclosure-actions">
          <button class="btn btn-sm btn-analyze" data-rcept_no="${item.rcept_no}" data-report_nm="${item.report_nm}">
            <i class="bi bi-bar-chart-line me-1"></i>분석하기
          </button>
          <a href="https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${item.rcept_no}" target="_blank" class="btn btn-sm btn-outline-secondary" onclick="event.stopPropagation()">
            <i class="bi bi-box-arrow-up-right me-1"></i>원문
          </a>
        </div>
      </li>`;
    });
    html += '</ul></div>';
    container.innerHTML = html;
    // 분석하기 버튼 이벤트 리스너
    document.querySelectorAll('.btn-analyze').forEach(btn => {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        const rceptNo = this.getAttribute('data-rcept_no');
        const reportNm = this.getAttribute('data-report_nm');
        handleDisclosureSelect(rceptNo, reportNm, this);
      });
    });
  } catch (e) {
    container.innerHTML = '<div class="alert alert-danger">공시 목록 조회 실패</div>';
  }
}

// 보고서 선택 시 분석 함수
function handleDisclosureSelect(rceptNo, reportNm, btnElement) {
  // 잠정실적 공시는 원문 기반 AI 분석으로 처리
  if (isProvisionalDisclosure(reportNm)) {
    handleProvisionalSelect(rceptNo, reportNm, btnElement);
    return;
  }
  let year = '';
  let reprtCode = '';
  const yearMatch = reportNm.match(/(\d{4})/);
  if (yearMatch) year = yearMatch[1];
  if (reportNm.includes('사업보고서')) reprtCode = '11011';
  else if (reportNm.includes('반기보고서')) reprtCode = '11012';
  else if (reportNm.includes('1분기보고서')) reprtCode = '11013';
  else if (reportNm.includes('3분기보고서')) reprtCode = '11014';
  else if (reportNm.includes('분기보고서')) {
    const monthMatch = reportNm.match(/\((\d{4})\.(\d{2})/);
    if (monthMatch) {
      const mm = monthMatch[2];
      if (mm === '03') reprtCode = '11013';
      else if (mm === '09') reprtCode = '11014';
      else {
        showToast('1분기/3분기 분기보고서만 지원합니다.', 'error');
        return;
      }
    } else {
      showToast('분기보고서의 월 정보를 인식할 수 없습니다.', 'error');
      return;
    }
  } else {
    showToast('1분기/반기/3분기/사업보고서만 지원합니다.', 'error');
    return;
  }
  if (!year || !reprtCode) {
    showToast('연도 또는 보고서 유형을 인식할 수 없습니다.', 'error');
    return;
  }

  // URL에 선택한 공시 반영
  updateUrlState(rceptNo);

  // 선택된 항목 하이라이트
  document.querySelectorAll('.disclosure-item').forEach(el => {
    el.classList.remove('disclosure-active');
  });
  if (btnElement) {
    const parentItem = btnElement.closest('.disclosure-item');
    if (parentItem) parentItem.classList.add('disclosure-active');
  }

  // 버튼 로딩 상태
  if (btnElement) {
    document.querySelectorAll('.btn-analyze').forEach(b => {
      b.disabled = false;
      b.innerHTML = '<i class="bi bi-bar-chart-line me-1"></i>분석하기';
    });
    btnElement.disabled = true;
    btnElement.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>분석 중...';
  }

  yearSelect.value = year;
  reportTypeSelect.value = reprtCode;

  // 결과 안내 배너 표시
  showAnalysisGuide(reportNm);

  fetchFinancialAnalysis().finally(() => {
    if (btnElement) {
      btnElement.disabled = false;
      btnElement.innerHTML = '<i class="bi bi-check-circle me-1"></i>분석 완료';
      btnElement.classList.add('btn-analyze-done');
      setTimeout(() => {
        btnElement.innerHTML = '<i class="bi bi-bar-chart-line me-1"></i>재분석';
        btnElement.classList.remove('btn-analyze-done');
      }, 3000);
    }
  });
}

// 잠정실적 공시 선택 시 분석 함수
async function handleProvisionalSelect(rceptNo, reportNm, btnElement) {
  // URL에 선택한 공시 반영
  updateUrlState(rceptNo);

  // 선택된 항목 하이라이트
  document.querySelectorAll('.disclosure-item').forEach(el => {
    el.classList.remove('disclosure-active');
  });
  if (btnElement) {
    const parentItem = btnElement.closest('.disclosure-item');
    if (parentItem) parentItem.classList.add('disclosure-active');
  }

  // 버튼 로딩 상태
  if (btnElement) {
    document.querySelectorAll('.btn-analyze').forEach(b => {
      b.disabled = false;
      b.innerHTML = '<i class="bi bi-bar-chart-line me-1"></i>분석하기';
    });
    btnElement.disabled = true;
    btnElement.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>분석 중...';
  }

  // 결과 안내 배너 표시
  showAnalysisGuide(reportNm, 'provisionalCard');

  const card = document.getElementById('provisionalCard');
  const title = document.getElementById('provisionalCardTitle');
  const loading = document.getElementById('provisionalLoading');
  const errorBox = document.getElementById('provisionalError');
  const content = document.getElementById('provisionalContent');
  const chartWrap = document.getElementById('provisionalChartWrap');
  const corpName = selectedCompany ? selectedCompany.corp_name : '';

  title.textContent = `${corpName} - ${reportNm} 분석`;
  card.style.display = 'block';
  loading.style.display = 'block';
  errorBox.style.display = 'none';
  content.style.display = 'none';
  content.innerHTML = '';
  chartWrap.style.display = 'none';

  try {
    const params = new URLSearchParams({ rcept_no: rceptNo, corp_name: corpName, report_nm: reportNm });
    const response = await fetch(`/api/provisional-analysis?${params.toString()}`);
    const data = await response.json();
    if (!response.ok || data.status !== 'success') {
      throw new Error(data.message || '잠정실적 분석에 실패했습니다.');
    }

    // 마크다운 코드 블록 제거 및 제목/문단 처리
    let analysisText = data.analysis.replace(/^```html\s*\n?/, '').replace(/\n?```$/, '').trim();
    const lines = analysisText.split('\n');
    const analysisTitle = lines.length > 0 ? lines[0] : '';
    const contentText = lines.slice(1).join('\n');
    let htmlContent = `<h4 class="mb-3">${analysisTitle}</h4>`;
    contentText.split('\n\n').filter(p => p.trim() !== '').forEach(para => {
      if (para.startsWith('<') && para.endsWith('>')) {
        htmlContent += para;
      } else {
        htmlContent += `<p>${para}</p>`;
      }
    });

    content.innerHTML = `<div class="ai-analysis">${htmlContent}</div>`;
    content.style.display = 'block';
    renderProvisionalChart(data.chartData);
    updateAnalysisGuide(reportNm, 'provisionalCard');
    card.scrollIntoView({ behavior: 'smooth' });
    if (btnElement) {
      btnElement.disabled = false;
      btnElement.innerHTML = '<i class="bi bi-check-circle me-1"></i>분석 완료';
      btnElement.classList.add('btn-analyze-done');
      setTimeout(() => {
        btnElement.innerHTML = '<i class="bi bi-bar-chart-line me-1"></i>재분석';
        btnElement.classList.remove('btn-analyze-done');
      }, 3000);
    }
  } catch (error) {
    console.error('잠정실적 분석 중 오류 발생:', error);
    errorBox.textContent = error.message || '잠정실적 분석 중 오류가 발생했습니다.';
    errorBox.style.display = 'block';
    failAnalysisGuide(reportNm);
    card.scrollIntoView({ behavior: 'smooth' });
    if (btnElement) {
      btnElement.disabled = false;
      btnElement.innerHTML = '<i class="bi bi-bar-chart-line me-1"></i>분석하기';
    }
  } finally {
    loading.style.display = 'none';
  }
}

// 잠정실적 비교 차트 렌더링 (당기 vs 전기 vs 전년동기)
let provisionalChart = null;
function renderProvisionalChart(chartData) {
  const wrap = document.getElementById('provisionalChartWrap');
  const canvas = document.getElementById('provisionalChart');
  if (!wrap || !canvas) return;

  const metrics = (chartData && Array.isArray(chartData.metrics) ? chartData.metrics : [])
    .filter(m => m && m.name && (m.current != null || m.previous != null || m.yearAgo != null));
  if (metrics.length === 0) {
    wrap.style.display = 'none';
    return;
  }

  const periodLabels = chartData.labels || {};
  const labels = [
    periodLabels.yearAgo ? `전년동기 (${periodLabels.yearAgo})` : '전년동기',
    periodLabels.previous ? `전기 (${periodLabels.previous})` : '전기',
    periodLabels.current ? `당기 (${periodLabels.current})` : '당기'
  ];
  // 계정과목별 고정 색 (다른 차트와 동일한 팔레트)
  const fallbackColors = [CHART_COLORS.revenue, CHART_COLORS.opIncome, CHART_COLORS.netIncome];
  const colorForMetric = (name, i) => {
    if (name.includes('매출') || name.includes('영업수익')) return CHART_COLORS.revenue;
    if (name.includes('영업이익')) return CHART_COLORS.opIncome;
    if (name.includes('순이익')) return CHART_COLORS.netIncome;
    return fallbackColors[i % fallbackColors.length];
  };
  const datasets = metrics.slice(0, 3).map((m, i) => {
    const color = colorForMetric(m.name, i);
    return {
      label: m.name,
      data: [m.yearAgo, m.previous, m.current],
      backgroundColor: color.bg,
      borderColor: color.border,
      borderWidth: 1,
      borderRadius: 4
    };
  });

  if (provisionalChart) provisionalChart.destroy();
  wrap.style.display = 'block';
  provisionalChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: {
          display: true,
          text: `잠정실적 비교${chartData.unit ? ` (단위: ${chartData.unit})` : ''}`
        },
        legend: { position: 'bottom' }
      },
      scales: {
        y: { beginAtZero: true }
      }
    }
  });
}

// 분석 결과 안내 배너
function showAnalysisGuide(reportNm, targetId = 'analysisCard') {
  let guide = document.getElementById('analysisGuide');
  if (!guide) {
    guide = document.createElement('div');
    guide.id = 'analysisGuide';
    const container = document.querySelector('.main-content') || document.querySelector('.container.mt-4');
    if (container) container.insertBefore(guide, container.firstChild);
  }
  guide.className = 'analysis-guide';
  guide.innerHTML = `
    <div class="analysis-guide-content">
      <div class="analysis-guide-icon">
        <span class="spinner-border spinner-border-sm"></span>
      </div>
      <div class="analysis-guide-text">
        <strong>${reportNm}</strong> 분석 중입니다...
      </div>
      <button class="btn btn-sm btn-analysis-guide-scroll" onclick="document.getElementById('${targetId}').scrollIntoView({behavior:'smooth'})">
        <i class="bi bi-arrow-down-circle me-1"></i>결과 보기
      </button>
    </div>
  `;
  guide.style.display = 'block';
}

// 분석 완료 시 가이드 업데이트
function updateAnalysisGuide(reportNm, targetId = 'analysisCard') {
  const guide = document.getElementById('analysisGuide');
  if (!guide) return;
  guide.innerHTML = `
    <div class="analysis-guide-content analysis-guide-done">
      <div class="analysis-guide-icon">
        <i class="bi bi-check-circle-fill"></i>
      </div>
      <div class="analysis-guide-text">
        <strong>${reportNm}</strong> 분석이 완료되었습니다
      </div>
      <button class="btn btn-sm btn-analysis-guide-scroll" onclick="document.getElementById('${targetId}').scrollIntoView({behavior:'smooth'})">
        <i class="bi bi-arrow-down-circle me-1"></i>결과 보기
      </button>
    </div>
  `;
  setTimeout(() => {
    guide.classList.add('analysis-guide-fade');
    setTimeout(() => { guide.style.display = 'none'; guide.classList.remove('analysis-guide-fade'); }, 500);
  }, 5000);
}

// 분석 실패 시 가이드 업데이트 (스피너가 계속 돌지 않도록)
function failAnalysisGuide(reportNm) {
  const guide = document.getElementById('analysisGuide');
  if (!guide || guide.style.display === 'none') return;
  guide.innerHTML = `
    <div class="analysis-guide-content analysis-guide-done">
      <div class="analysis-guide-icon">
        <i class="bi bi-x-circle-fill"></i>
      </div>
      <div class="analysis-guide-text">
        <strong>${reportNm}</strong> 분석에 실패했습니다
      </div>
    </div>
  `;
  setTimeout(() => {
    guide.classList.add('analysis-guide-fade');
    setTimeout(() => { guide.style.display = 'none'; guide.classList.remove('analysis-guide-fade'); }, 500);
  }, 5000);
}

// PWA 설치 팝업
function initPwaInstallBanner() {
  const banner = document.getElementById('pwaInstallBanner');
  const installBtn = document.getElementById('pwaInstallBtn');
  const dismissBtn = document.getElementById('pwaDismissBtn');

  if (!banner || !installBtn || !dismissBtn) return;

  // 이미 앱으로 실행 중이면 표시 안 함
  if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) {
    return;
  }

  let deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;

    // 이번 세션에서 이미 거절했으면 표시 안 함
    if (sessionStorage.getItem('pwaInstallDismissed')) return;

    // 3초 후 팝업 표시
    setTimeout(() => {
      if (deferredPrompt) {
        banner.style.display = 'block';
      }
    }, 3000);
  });

  installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      banner.style.display = 'none';
    }
    deferredPrompt = null;
  });

  dismissBtn.addEventListener('click', () => {
    banner.style.display = 'none';
    sessionStorage.setItem('pwaInstallDismissed', '1');
  });

  // 설치 완료 시 팝업 숨김
  window.addEventListener('appinstalled', () => {
    banner.style.display = 'none';
    deferredPrompt = null;
  });
}

// =============================================
// 분석 결과 내보내기
// =============================================

let cachedKoreanFontBase64 = null;
const KOREAN_FONT_NAME = 'NanumGothic';
const KOREAN_FONT_URL = 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/nanumgothic/NanumGothic-Regular.ttf';
const KOREAN_FONT_BOLD_URL = 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/nanumgothic/NanumGothic-Bold.ttf';
let cachedKoreanFontBoldBase64 = null;

async function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function loadKoreanFont() {
  if (!cachedKoreanFontBase64) {
    const resp = await fetch(KOREAN_FONT_URL);
    if (!resp.ok) throw new Error('한글 폰트 로드 실패');
    const buffer = await resp.arrayBuffer();
    cachedKoreanFontBase64 = await arrayBufferToBase64(buffer);
  }
  if (!cachedKoreanFontBoldBase64) {
    try {
      const resp = await fetch(KOREAN_FONT_BOLD_URL);
      if (resp.ok) {
        const buffer = await resp.arrayBuffer();
        cachedKoreanFontBoldBase64 = await arrayBufferToBase64(buffer);
      }
    } catch (e) {
      console.warn('한글 Bold 폰트 로드 실패, Regular로 대체:', e);
    }
  }
  return { regular: cachedKoreanFontBase64, bold: cachedKoreanFontBoldBase64 };
}

function getExportFileName(ext, label = null) {
  const company = selectedCompany?.corp_name || 'Finalyze';
  const date = new Date().toISOString().slice(0, 10);
  if (label) {
    return `Finalyze_${company}_${label}_${date}.${ext}`;
  }
  const year = currentYear || '';
  const reportCodeMap = { '11011': '사업', '11012': '반기', '11013': '1분기', '11014': '3분기' };
  const reportName = reportCodeMap[reportTypeSelect?.value] || '';
  return `Finalyze_${company}_${year}${reportName}_${date}.${ext}`;
}

function showExportLoading(btn, loadingText) {
  if (!btn) return null;
  const origHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>${loadingText}`;
  return () => {
    btn.disabled = false;
    btn.innerHTML = origHtml;
  };
}

// 캔버스 차트를 PNG dataURL로 변환
function getChartImage() {
  const canvas = document.getElementById('incomeStatementChart');
  if (!canvas) return null;
  try {
    return canvas.toDataURL('image/png');
  } catch (e) {
    return null;
  }
}

// 재무상태표 시각화 영역을 이미지로 변환 (HTML 기반이므로 html2canvas 사용)
async function getBalanceSheetVisImage() {
  const container = document.getElementById('balanceSheetVisContainer');
  if (!container || !window.html2canvas) return null;
  try {
    const canvas = await html2canvas(container, {
      scale: 2,
      backgroundColor: '#ffffff',
      logging: false
    });
    return canvas.toDataURL('image/png');
  } catch (e) {
    console.warn('재무상태표 시각화 캡쳐 실패:', e);
    return null;
  }
}

// 테이블 데이터를 행렬로 추출
function extractTableData(tbody) {
  if (!tbody) return [];
  const rows = [];
  tbody.querySelectorAll('tr').forEach(tr => {
    const row = [];
    tr.querySelectorAll('td').forEach(td => {
      row.push(td.innerText.replace(/\s+/g, ' ').trim());
    });
    if (row.length > 0) rows.push(row);
  });
  return rows;
}

// AI 분석 텍스트 추출 (HTML 태그 제거하되 구조는 유지)
function extractAiAnalysisText(containerId = 'aiAnalysisContent') {
  const aiContent = document.getElementById(containerId);
  if (!aiContent || aiContent.style.display === 'none') return null;
  const aiAnalysis = aiContent.querySelector('.ai-analysis');
  if (!aiAnalysis) return null;

  const blocks = [];
  aiAnalysis.childNodes.forEach(node => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const text = node.innerText.replace(/\s+/g, ' ').trim();
      if (text) {
        blocks.push({
          tag: node.tagName.toLowerCase(),
          text: text
        });
      }
    } else if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent.trim();
      if (text) blocks.push({ tag: 'p', text });
    }
  });
  return blocks;
}

// 분석 결과를 PDF로 내보내기 (텍스트/표 selectable)
async function exportAnalysisAsPdf() {
  const btn = document.getElementById('exportPdfBtn');
  const restore = showExportLoading(btn, '폰트 로드 중...');

  try {
    if (!window.jspdf) {
      showToast('PDF 라이브러리를 불러오는 중입니다. 잠시 후 다시 시도해주세요.');
      return;
    }

    // 1. 한글 폰트 로드 (캐싱)
    const fonts = await loadKoreanFont();

    if (restore) {
      const newRestore = showExportLoading(btn, 'PDF 생성 중...');
      restore.replaced = true;
    }

    // 2. jsPDF 초기화
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 15;
    const contentWidth = pageWidth - margin * 2;

    // 한글 폰트 등록
    pdf.addFileToVFS('NanumGothic-Regular.ttf', fonts.regular);
    pdf.addFont('NanumGothic-Regular.ttf', KOREAN_FONT_NAME, 'normal');
    if (fonts.bold) {
      pdf.addFileToVFS('NanumGothic-Bold.ttf', fonts.bold);
      pdf.addFont('NanumGothic-Bold.ttf', KOREAN_FONT_NAME, 'bold');
    }
    pdf.setFont(KOREAN_FONT_NAME, 'normal');

    let y = margin;

    // 페이지 넘김 헬퍼
    const ensureSpace = (needed) => {
      if (y + needed > pageHeight - margin) {
        pdf.addPage();
        y = margin;
      }
    };

    // 3. 제목
    const titleText = document.getElementById('analysisCardTitle')?.textContent || '재무분석 결과';
    pdf.setFont(KOREAN_FONT_NAME, fonts.bold ? 'bold' : 'normal');
    pdf.setFontSize(16);
    pdf.setTextColor(37, 99, 235);
    pdf.text(titleText, pageWidth / 2, y, { align: 'center' });
    y += 8;

    // 부제 (생성일)
    pdf.setFont(KOREAN_FONT_NAME, 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(120, 120, 120);
    const now = new Date();
    const dateStr = `생성일: ${now.toISOString().slice(0, 10)} ${now.toTimeString().slice(0, 5)} | Finalyze.AI`;
    pdf.text(dateStr, pageWidth / 2, y, { align: 'center' });
    y += 8;

    // 가로선
    pdf.setDrawColor(37, 99, 235);
    pdf.setLineWidth(0.5);
    pdf.line(margin, y, pageWidth - margin, y);
    y += 8;

    // 4. 손익 차트 (이미지)
    const chartImg = getChartImage();
    if (chartImg) {
      pdf.setFont(KOREAN_FONT_NAME, fonts.bold ? 'bold' : 'normal');
      pdf.setFontSize(12);
      pdf.setTextColor(37, 99, 235);
      ensureSpace(8);
      pdf.text('1. 주요 재무 시각화', margin, y);
      y += 6;

      const chartHeight = 80;
      ensureSpace(chartHeight + 5);
      pdf.addImage(chartImg, 'PNG', margin, y, contentWidth, chartHeight);
      y += chartHeight + 5;
    }

    // 5. 재무상태표 시각화 (이미지)
    const bsImg = await getBalanceSheetVisImage();
    if (bsImg) {
      const bsHeight = 60;
      ensureSpace(bsHeight + 5);
      pdf.addImage(bsImg, 'PNG', margin + 30, y, contentWidth - 60, bsHeight);
      y += bsHeight + 8;
    }

    // 6. AI 재무분석 (텍스트, 복사 가능)
    const aiBlocks = extractAiAnalysisText();
    if (aiBlocks && aiBlocks.length > 0) {
      ensureSpace(15);
      pdf.setFont(KOREAN_FONT_NAME, fonts.bold ? 'bold' : 'normal');
      pdf.setFontSize(12);
      pdf.setTextColor(37, 99, 235);
      pdf.text('2. AI 재무분석', margin, y);
      y += 7;

      pdf.setFont(KOREAN_FONT_NAME, 'normal');
      pdf.setTextColor(40, 40, 40);

      aiBlocks.forEach(block => {
        const isHeading = ['h1', 'h2', 'h3', 'h4', 'h5'].includes(block.tag);
        const isList = block.tag === 'ul' || block.tag === 'ol' || block.tag === 'li';
        pdf.setFontSize(isHeading ? 11 : 10);
        if (isHeading && fonts.bold) {
          pdf.setFont(KOREAN_FONT_NAME, 'bold');
        } else {
          pdf.setFont(KOREAN_FONT_NAME, 'normal');
        }
        const lines = pdf.splitTextToSize(block.text, contentWidth);
        const lineHeight = isHeading ? 6 : 5;
        lines.forEach(line => {
          ensureSpace(lineHeight);
          pdf.text(line, margin, y);
          y += lineHeight;
        });
        y += isHeading ? 2 : 1;
      });
      y += 4;
    }

    // 7. 테이블 (autoTable, 텍스트 selectable)
    const tableSets = [
      { title: '3. 재무상태표', tbody: document.getElementById('bsTableBody'),
        head: ['항목', '당기', '전기', '증감', '증감율'] },
      { title: '4. 손익계산서', tbody: document.getElementById('isTableBody'),
        head: ['항목', '당기', '전기', '증감', '증감율'] },
      { title: '5. 재무비율', tbody: document.getElementById('ratioTableBody'),
        head: ['비율', '당기', '전기', '증감(%p)'] }
    ];

    for (const set of tableSets) {
      const rows = extractTableData(set.tbody);
      if (rows.length === 0) continue;

      ensureSpace(15);
      pdf.setFont(KOREAN_FONT_NAME, fonts.bold ? 'bold' : 'normal');
      pdf.setFontSize(12);
      pdf.setTextColor(37, 99, 235);
      pdf.text(set.title, margin, y);
      y += 5;

      pdf.autoTable({
        startY: y,
        head: [set.head],
        body: rows,
        margin: { left: margin, right: margin },
        styles: {
          font: KOREAN_FONT_NAME,
          fontStyle: 'normal',
          fontSize: 9,
          cellPadding: 2.5,
          textColor: [40, 40, 40],
          lineColor: [220, 220, 220],
          lineWidth: 0.2
        },
        headStyles: {
          font: KOREAN_FONT_NAME,
          fontStyle: fonts.bold ? 'bold' : 'normal',
          fillColor: [239, 246, 255],
          textColor: [37, 99, 235],
          halign: 'center'
        },
        bodyStyles: {
          halign: 'right'
        },
        columnStyles: {
          0: { halign: 'left', fontStyle: fonts.bold ? 'bold' : 'normal' }
        },
        alternateRowStyles: {
          fillColor: [249, 250, 251]
        }
      });

      y = pdf.lastAutoTable.finalY + 7;
    }

    // 8. 푸터 (각 페이지에)
    const totalPages = pdf.internal.getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
      pdf.setPage(i);
      pdf.setFont(KOREAN_FONT_NAME, 'normal');
      pdf.setFontSize(8);
      pdf.setTextColor(150, 150, 150);
      pdf.text(`Finalyze.AI | ${i} / ${totalPages}`, pageWidth / 2, pageHeight - 8, { align: 'center' });
    }

    pdf.save(getExportFileName('pdf'));
  } catch (error) {
    console.error('PDF 내보내기 오류:', error);
    showToast('PDF 내보내기 중 오류가 발생했습니다: ' + error.message, 'error');
  } finally {
    if (restore && !restore.replaced) restore();
    const newBtn = document.getElementById('exportPdfBtn');
    if (newBtn && newBtn.disabled) {
      newBtn.disabled = false;
      newBtn.innerHTML = '<i class="bi bi-file-earmark-pdf me-1"></i>PDF 내보내기';
    }
  }
}

// 분석 결과를 PNG 이미지로 내보내기 (html2canvas 기반)
async function exportAnalysisAsImage() {
  const btn = document.getElementById('exportImageBtn');
  const restore = showExportLoading(btn, '이미지 생성 중...');

  try {
    if (!window.html2canvas) {
      showToast('이미지 라이브러리를 불러오는 중입니다. 잠시 후 다시 시도해주세요.');
      return;
    }

    const card = document.getElementById('analysisCard');
    if (!card) {
      showToast('내보낼 분석 결과가 없습니다.', 'error');
      return;
    }

    // 클론하여 모든 탭이 보이도록
    const clone = card.cloneNode(true);
    const exportActions = clone.querySelector('.export-actions');
    if (exportActions) exportActions.remove();
    const tabs = clone.querySelector('.nav-tabs');
    if (tabs) tabs.remove();
    clone.querySelectorAll('.tab-pane').forEach(pane => {
      pane.classList.add('show', 'active');
      pane.style.display = 'block';
      let title = '';
      if (pane.id === 'bs') title = '재무상태표';
      else if (pane.id === 'is') title = '손익계산서';
      else if (pane.id === 'ratio') title = '재무비율';
      if (title) {
        const h = document.createElement('h4');
        h.textContent = title;
        h.style.cssText = 'margin-top:1.5rem;padding:0.5rem 0;border-bottom:2px solid #2563eb;color:#2563eb;font-weight:700;';
        pane.insertBefore(h, pane.firstChild);
      }
    });

    // 차트 캔버스를 이미지로 교체
    const originalCanvas = document.getElementById('incomeStatementChart');
    const cloneCanvas = clone.querySelector('#incomeStatementChart');
    if (originalCanvas && cloneCanvas) {
      try {
        const dataUrl = originalCanvas.toDataURL('image/png');
        const img = document.createElement('img');
        img.src = dataUrl;
        img.style.cssText = 'max-width:100%;height:auto;';
        cloneCanvas.parentNode.replaceChild(img, cloneCanvas);
      } catch (e) {}
    }

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:fixed;left:-9999px;top:0;width:1100px;background:#fff;padding:20px;z-index:-1;';
    wrapper.appendChild(clone);
    document.body.appendChild(wrapper);

    await new Promise(resolve => setTimeout(resolve, 200));

    const canvas = await html2canvas(clone, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff',
      logging: false
    });

    wrapper.remove();

    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = getExportFileName('png');
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 'image/png');
  } catch (error) {
    console.error('이미지 내보내기 오류:', error);
    showToast('이미지 내보내기 중 오류가 발생했습니다: ' + error.message, 'error');
  } finally {
    if (restore) restore();
  }
}

// =============================================
// 잠정실적 분석 내보내기
// =============================================

// 잠정실적 분석을 PDF로 내보내기
async function exportProvisionalAsPdf() {
  const btn = document.getElementById('provisionalPdfBtn');

  const content = document.getElementById('provisionalContent');
  if (!content || content.style.display === 'none' || !content.innerHTML.trim()) {
    showToast('내보낼 분석 결과가 없습니다. 먼저 잠정실적을 분석해주세요.', 'error');
    return;
  }
  if (!window.jspdf) {
    showToast('PDF 라이브러리를 불러오는 중입니다. 잠시 후 다시 시도해주세요.');
    return;
  }

  const restore = showExportLoading(btn, 'PDF 생성 중...');
  try {
    const fonts = await loadKoreanFont();

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 15;
    const contentWidth = pageWidth - margin * 2;

    pdf.addFileToVFS('NanumGothic-Regular.ttf', fonts.regular);
    pdf.addFont('NanumGothic-Regular.ttf', KOREAN_FONT_NAME, 'normal');
    if (fonts.bold) {
      pdf.addFileToVFS('NanumGothic-Bold.ttf', fonts.bold);
      pdf.addFont('NanumGothic-Bold.ttf', KOREAN_FONT_NAME, 'bold');
    }
    pdf.setFont(KOREAN_FONT_NAME, 'normal');

    let y = margin;
    const ensureSpace = (needed) => {
      if (y + needed > pageHeight - margin) {
        pdf.addPage();
        y = margin;
      }
    };

    // 제목
    const titleText = document.getElementById('provisionalCardTitle')?.textContent || '잠정실적 분석';
    pdf.setFont(KOREAN_FONT_NAME, fonts.bold ? 'bold' : 'normal');
    pdf.setFontSize(16);
    pdf.setTextColor(37, 99, 235);
    pdf.text(titleText, pageWidth / 2, y, { align: 'center', maxWidth: contentWidth });
    y += 10;

    pdf.setFont(KOREAN_FONT_NAME, 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(120, 120, 120);
    const now = new Date();
    pdf.text(`생성일: ${now.toISOString().slice(0, 10)} ${now.toTimeString().slice(0, 5)} | Finalyze.AI`, pageWidth / 2, y, { align: 'center' });
    y += 8;

    pdf.setDrawColor(37, 99, 235);
    pdf.setLineWidth(0.5);
    pdf.line(margin, y, pageWidth - margin, y);
    y += 8;

    // 잠정실적 비교 차트 (이미지)
    const chartCanvas = document.getElementById('provisionalChart');
    const chartWrap = document.getElementById('provisionalChartWrap');
    if (chartCanvas && chartWrap && chartWrap.style.display !== 'none') {
      try {
        const chartImg = chartCanvas.toDataURL('image/png');
        const chartHeight = 80;
        ensureSpace(chartHeight + 5);
        pdf.addImage(chartImg, 'PNG', margin, y, contentWidth, chartHeight);
        y += chartHeight + 8;
      } catch (e) {
        console.warn('잠정실적 차트 캡쳐 실패:', e);
      }
    }

    // AI 분석 텍스트
    const blocks = extractAiAnalysisText('provisionalContent');
    if (blocks && blocks.length > 0) {
      pdf.setTextColor(40, 40, 40);
      blocks.forEach(block => {
        const isHeading = ['h1', 'h2', 'h3', 'h4', 'h5'].includes(block.tag);
        pdf.setFontSize(isHeading ? 11 : 10);
        pdf.setFont(KOREAN_FONT_NAME, isHeading && fonts.bold ? 'bold' : 'normal');
        const lines = pdf.splitTextToSize(block.text, contentWidth);
        const lineHeight = isHeading ? 6 : 5;
        lines.forEach(line => {
          ensureSpace(lineHeight);
          pdf.text(line, margin, y);
          y += lineHeight;
        });
        y += isHeading ? 2 : 1;
      });
    }

    // 푸터
    const totalPages = pdf.internal.getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
      pdf.setPage(i);
      pdf.setFont(KOREAN_FONT_NAME, 'normal');
      pdf.setFontSize(8);
      pdf.setTextColor(150, 150, 150);
      pdf.text(`Finalyze.AI | ${i} / ${totalPages}`, pageWidth / 2, pageHeight - 8, { align: 'center' });
    }

    pdf.save(getExportFileName('pdf', '잠정실적'));
  } catch (error) {
    console.error('잠정실적 PDF 내보내기 오류:', error);
    showToast('PDF 내보내기 중 오류가 발생했습니다: ' + error.message, 'error');
  } finally {
    if (restore) restore();
  }
}

// 잠정실적 분석을 PNG 이미지로 내보내기
async function exportProvisionalAsImage() {
  const btn = document.getElementById('provisionalImageBtn');

  const content = document.getElementById('provisionalContent');
  if (!content || content.style.display === 'none' || !content.innerHTML.trim()) {
    showToast('내보낼 분석 결과가 없습니다. 먼저 잠정실적을 분석해주세요.', 'error');
    return;
  }
  if (!window.html2canvas) {
    showToast('이미지 라이브러리를 불러오는 중입니다. 잠시 후 다시 시도해주세요.');
    return;
  }

  const restore = showExportLoading(btn, '이미지 생성 중...');
  try {
    const card = document.getElementById('provisionalCard');
    const clone = card.cloneNode(true);
    const exportActions = clone.querySelector('.export-actions');
    if (exportActions) exportActions.remove();

    // 차트 캔버스를 이미지로 교체
    const originalCanvas = document.getElementById('provisionalChart');
    const cloneCanvas = clone.querySelector('#provisionalChart');
    if (originalCanvas && cloneCanvas) {
      try {
        const img = document.createElement('img');
        img.src = originalCanvas.toDataURL('image/png');
        img.style.cssText = 'max-width:100%;height:auto;';
        cloneCanvas.parentNode.replaceChild(img, cloneCanvas);
      } catch (e) {}
    }

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:fixed;left:-9999px;top:0;width:1100px;background:#fff;padding:20px;z-index:-1;';
    wrapper.appendChild(clone);
    document.body.appendChild(wrapper);

    await new Promise(resolve => setTimeout(resolve, 200));

    const canvas = await html2canvas(clone, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff',
      logging: false
    });

    wrapper.remove();

    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = getExportFileName('png', '잠정실적');
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 'image/png');
  } catch (error) {
    console.error('잠정실적 이미지 내보내기 오류:', error);
    showToast('이미지 내보내기 중 오류가 발생했습니다: ' + error.message, 'error');
  } finally {
    if (restore) restore();
  }
}