// 전역 변수
let selectedCompany = null;
let incomeStatementChart = null;
// let assetCompositionChart = null;
// let liabilityEquityChart = null;
let currentYear = null;
let previousYear = null;

// DOM 요소
const companySearchInput = document.getElementById('companySearch');
const searchBtn = document.getElementById('searchBtn');
const searchResults = document.getElementById('searchResults');
const companyInfoCard = document.getElementById('companyInfoCard');
const companyInfo = document.getElementById('companyInfo');
const financialOptionsCard = document.getElementById('financialOptionsCard');
const yearSelect = document.getElementById('year');
const reportTypeSelect = document.getElementById('reportType');
const fetchAnalysisBtn = document.getElementById('fetchAnalysisBtn');
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
  
  // 검색 버튼 클릭 이벤트
  searchBtn.addEventListener('click', searchCompany);
  
  // 엔터 키 입력 이벤트
  companySearchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      searchCompany();
    }
  });
  
  // 통합 재무분석 버튼 클릭 이벤트
  fetchAnalysisBtn.addEventListener('click', fetchFinancialAnalysis);
});

// 회사 검색 함수
async function searchCompany() {
  const keyword = companySearchInput.value.trim();
  
  if (keyword.length < 2) {
    alert('검색어는 2글자 이상 입력해주세요.');
    return;
  }
  
  searchResults.innerHTML = '<div class="loading">검색 중...</div>';
  
  try {
    const response = await fetch(`/api/companies/search?keyword=${encodeURIComponent(keyword)}`);
    const data = await response.json();
    
    if (data.status === 'success') {
      displaySearchResults(data.data);
    } else {
      searchResults.innerHTML = `<div class="alert alert-danger">${data.message}</div>`;
    }
  } catch (error) {
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
function selectCompany(company) {
  selectedCompany = company;
  
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
  
  // 재무제표 조회 옵션 표시
  financialOptionsCard.style.display = 'block';
  
  // 초기화
  analysisCard.style.display = 'none';
  
  // 차트 초기화
  if (incomeStatementChart) {
    incomeStatementChart.destroy();
    incomeStatementChart = null;
  }
  if (balanceSheetVisContainer) {
    balanceSheetVisContainer.innerHTML = '';
  }
  // if (assetCompositionChart) {
  //   assetCompositionChart.destroy();
  //   assetCompositionChart = null;
  // }
  // if (liabilityEquityChart) {
  //   liabilityEquityChart.destroy();
  //   liabilityEquityChart = null;
  // }
  
  // 화면 스크롤
  financialOptionsCard.scrollIntoView({ behavior: 'smooth' });
}

// 통합 재무분석 조회 함수
async function fetchFinancialAnalysis() {
  if (!selectedCompany) {
    alert('회사를 먼저 선택해주세요.');
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
    }
  } catch (error) {
    // 네트워크/기타 오류 처리 (loadingIndicator 숨김)
    console.error('재무분석 데이터 조회 중 오류 발생:', error);
    loadingIndicator.style.display = 'none'; 
    overviewError.style.display = 'block';
    overviewError.textContent = `데이터 조회 오류: ${error.message || '알 수 없는 오류'}`;
  }
}

// 통합 재무분석 표시 함수
function displayFinancialAnalysis(analysis) {
  console.log('--- displayFinancialAnalysis called ---', analysis); 
  try {
    // !!! 여기서 메인 로딩 인디케이터 숨기기 !!!
    loadingIndicator.style.display = 'none';
    
    // 1. 개요 탭 내용 생성
    console.log('Calling chart/vis display functions...');
    // displayIncomeStatementChart(analysis); // 주석 처리
    // displayBalanceSheetVis(analysis); // 주석 처리
    // displayCompositionCharts(analysis);
    console.log('Calling AI analysis function...');
    fetchAIFinancialAnalysis(analysis); 

    // 2. 다른 탭 내용 생성
    displayBalanceSheetTable(analysis.balanceSheet || {});
    displayIncomeStatementTable(analysis.incomeStatement || {});
    displayRatioTable(analysis.ratio || {});

    // 3. 개요 탭 내용 (차트 영역) 표시
    document.getElementById('chartRow').style.display = 'flex'; 
    
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
      ratio: analysis.ratio
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
      analysisText = analysisText.replace(/^```html\s*\n?/, '').replace(/\n?```$/, '').trim();
      
      // 제목 처리 (첫 번째 줄)
      const lines = analysisText.split('\n');
      let title = '';
      let contentText = analysisText;
      
      if (lines.length > 0) {
        title = lines[0];
        contentText = lines.slice(1).join('\n');
      }
      
      // 문단 나누기
      const paragraphs = contentText.split('\n\n').filter(p => p.trim() !== '');
      
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

    const ctx = incomeStatementChartCanvas.getContext('2d');
    
    // 데이터 준비
    const salesCurrent = analysis.incomeStatement?.['매출액']?.current || 0;
    const opIncomeCurrent = analysis.incomeStatement?.['영업이익']?.current || 0;
    const netIncomeCurrent = analysis.incomeStatement?.['당기순이익']?.current || 0;
    const salesPrevious = analysis.incomeStatement?.['매출액']?.previous || 0;
    const opIncomePrevious = analysis.incomeStatement?.['영업이익']?.previous || 0;
    const netIncomePrevious = analysis.incomeStatement?.['당기순이익']?.previous || 0;

    // !!! 디버깅 로그 추가 !!!
    console.log(`Margin Calculation Inputs (${currentYear}): Sales=${salesCurrent}, OpIncome=${opIncomeCurrent}, NetIncome=${netIncomeCurrent}`);
    console.log(`Margin Calculation Inputs (${previousYear}): Sales=${salesPrevious}, OpIncome=${opIncomePrevious}, NetIncome=${netIncomePrevious}`);

    // 이익률 계산 (%)
    const opMarginCurrent = salesCurrent !== 0 ? ((opIncomeCurrent / salesCurrent) * 100).toFixed(2) : 0;
    const netMarginCurrent = salesCurrent !== 0 ? ((netIncomeCurrent / salesCurrent) * 100).toFixed(2) : 0;
    const opMarginPrevious = salesPrevious !== 0 ? ((opIncomePrevious / salesPrevious) * 100).toFixed(2) : 0;
    const netMarginPrevious = salesPrevious !== 0 ? ((netIncomePrevious / salesPrevious) * 100).toFixed(2) : 0;
    
    // !!! 계산된 이익률 로그 추가 !!!
    console.log(`Calculated Margins (${currentYear}): OpMargin=${opMarginCurrent}%, NetMargin=${netMarginCurrent}%`);
    console.log(`Calculated Margins (${previousYear}): OpMargin=${opMarginPrevious}%, NetMargin=${netMarginPrevious}%`);

    const labels = [ `${previousYear}년`, `${currentYear}년`];
    
    const chartData = {
        labels: labels,
        datasets: [
          {
            type: 'bar', // 매출액은 막대
            label: '매출액',
            data: [salesPrevious, salesCurrent],
            backgroundColor: 'rgba(54, 162, 235, 0.6)',
            borderColor: 'rgb(54, 162, 235)',
            borderWidth: 1,
            yAxisID: 'y-axis-amount' // 왼쪽 Y축 사용
          },
          {
            type: 'line', // 영업이익률은 선
            label: '영업이익률 (%)',
            data: [opMarginPrevious, opMarginCurrent],
            borderColor: 'rgb(255, 99, 132)',
            backgroundColor: 'rgba(255, 99, 132, 0.2)',
            borderWidth: 2,
            fill: false,
            tension: 0.1,
            yAxisID: 'y-axis-percent' // 오른쪽 Y축 사용
          },
          {
            type: 'line', // 당기순이익률은 선
            label: '당기순이익률 (%)',
            data: [netMarginPrevious, netMarginCurrent],
            borderColor: 'rgb(75, 192, 75)', // 초록색 계열
            backgroundColor: 'rgba(75, 192, 75, 0.2)',
            borderWidth: 2,
            fill: false,
            tension: 0.1,
            yAxisID: 'y-axis-percent' // 오른쪽 Y축 사용
          }
        ]
      };
    // console.log('Income Statement Chart Data:', JSON.stringify(chartData)); // 이전 로그는 주석 처리 또는 유지

    const hasValidData = salesCurrent !== 0 || salesPrevious !== 0; // 매출액 기준으로 유효성 판단
    if (!hasValidData) {
        console.warn('No valid sales data to display chart.');
        incomeStatementChartCanvas.parentElement.innerHTML = '<p class="text-center text-muted small">손익계산서 데이터 없음</p>';
        return;
    }

    console.log('Creating Income Statement Chart...');
    incomeStatementChart = new Chart(ctx, {
      // type: 'bar', // 타입을 datasets에서 개별 지정
      data: chartData,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: {
            display: true,
            text: '매출 및 주요 이익률 추이', // 제목 변경
            font: { size: 14, weight: 'bold' }
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
          legend: { display: true, position: 'bottom' }
        },
        scales: {
          'y-axis-amount': { // 왼쪽 Y축 (금액)
            type: 'linear',
            display: true,
            position: 'left',
            beginAtZero: true,
            title: {
                display: true,
                text: '매출액 (원)'
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
    console.log('Income Statement Chart CREATED.');
  } catch (error) {
    console.error('Error in displayIncomeStatementChart:', error);
    if(incomeStatementChartCanvas) incomeStatementChartCanvas.parentElement.innerHTML = '<p class="text-center text-danger small">손익 차트 오류</p>';
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
    const visHTML = `
      <h6 class="text-center fw-bold mb-2">${currentYear}년 재무상태표 구조</h6>
      <div class="bs-vis-box d-flex mx-auto">
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
  
  items.forEach(item => {
    const current = balanceSheet[item]?.current || 0;
    const previous = balanceSheet[item]?.previous || 0;
    const diff = current - previous;
    const diffRate = previous !== 0 ? (diff / previous * 100).toFixed(2) : '-';
    
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${item}</td>
      <td class="text-end">${formatAmountBetter(current)} <small class="text-muted">(${currentYear}년)</small></td>
      <td class="text-end">${formatAmountBetter(previous)} <small class="text-muted">(${previousYear}년)</small></td>
      <td class="text-end ${diff >= 0 ? 'text-success' : 'text-danger'}">${formatAmountBetter(diff)}</td>
      <td class="text-end ${diff >= 0 ? 'text-success' : 'text-danger'}">${diffRate !== '-' ? diffRate + '%' : '-'}</td>
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
  
  items.forEach(item => {
    const current = incomeStatement[item]?.current || 0;
    const previous = incomeStatement[item]?.previous || 0;
    const diff = current - previous;
    const diffRate = previous !== 0 ? (diff / previous * 100).toFixed(2) : '-';
    
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${item}</td>
      <td class="text-end">${formatAmountBetter(current)} <small class="text-muted">(${currentYear}년)</small></td>
      <td class="text-end">${formatAmountBetter(previous)} <small class="text-muted">(${previousYear}년)</small></td>
      <td class="text-end ${diff >= 0 ? 'text-success' : 'text-danger'}">${formatAmountBetter(diff)}</td>
      <td class="text-end ${diff >= 0 ? 'text-success' : 'text-danger'}">${diffRate !== '-' ? diffRate + '%' : '-'}</td>
    `;
    
    isTableBody.appendChild(row);
  });
}

// 재무비율 테이블 표시 함수
function displayRatioTable(ratio) {
  ratioTableBody.innerHTML = '';
  
  // 테이블에 표시할 비율 항목 (순서대로)
  const items = [
    '유동비율', '당좌비율', '부채비율', '자기자본비율', 
    '매출액영업이익률', '매출액순이익률', 'ROE', 'ROA'
  ];
  
  // 테이블 생성
  if (Object.keys(ratio).length === 0) {
    ratioTableBody.innerHTML = '<tr><td colspan="4" class="text-center">재무비율 데이터가 없습니다.</td></tr>';
    return;
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
        <td class="text-end">${current}% <small class="text-muted">(${currentYear}년)</small></td>
        <td class="text-end">${previous}% <small class="text-muted">(${previousYear}년)</small></td>
        <td class="text-end ${diff >= 0 ? 'text-success' : 'text-danger'}">${diff}%p</td>
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