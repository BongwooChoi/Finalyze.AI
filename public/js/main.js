// 전역 변수
let selectedCompany = null;
let overviewChart = null;
let assetCompositionChart = null;
let liabilityEquityChart = null;
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
const overviewChartCanvas = document.getElementById('overviewChart');
const assetCompositionChartCanvas = document.getElementById('assetCompositionChart');
const liabilityEquityChartCanvas = document.getElementById('liabilityEquityChart');
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
  if (overviewChart) {
    overviewChart.destroy();
    overviewChart = null;
  }
  if (assetCompositionChart) {
    assetCompositionChart.destroy();
    assetCompositionChart = null;
  }
  if (liabilityEquityChart) {
    liabilityEquityChart.destroy();
    liabilityEquityChart = null;
  }
  
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
  
  // 로딩 표시 및 초기화
  analysisCard.style.display = 'block';
  loadingIndicator.style.display = 'block';
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
      // 로딩 메시지 숨기기
      loadingIndicator.style.display = 'none';
      
      // 데이터 표시
      displayFinancialAnalysis(data.data);
    } else {
      // 오류 메시지 표시
      loadingIndicator.style.display = 'none';
      overviewError.style.display = 'block';
      overviewError.textContent = data.message || '데이터를 불러오는 중 오류가 발생했습니다';
      console.error('재무분석 API 오류:', data.message);
    }
  } catch (error) {
    console.error('재무분석 데이터 조회 중 오류 발생:', error);
    loadingIndicator.style.display = 'none';
    overviewError.style.display = 'block';
    overviewError.textContent = `데이터를 불러오는 중 오류가 발생했습니다: ${error.message || '알 수 없는 오류'}`;
  }
}

// 통합 재무분석 표시 함수
function displayFinancialAnalysis(analysis) {
  try {
    // 1. 개요 차트 및 AI 분석
    displayOverviewCharts(analysis);
    displayCompositionCharts(analysis);
    fetchAIFinancialAnalysis(analysis);
    
    // 2. 재무상태표 탭
    displayBalanceSheetTable(analysis.balanceSheet || {});
    
    // 3. 손익계산서 탭
    displayIncomeStatementTable(analysis.incomeStatement || {});
    
    // 4. 재무비율 탭
    displayRatioTable(analysis.ratio || {});
    
    // 화면 스크롤
    analysisCard.scrollIntoView({ behavior: 'smooth' });
  } catch (error) {
    console.error('재무분석 표시 중 오류 발생:', error);
    loadingIndicator.style.display = 'none';
    overviewError.style.display = 'block';
    overviewError.textContent = `재무분석 표시 중 오류가 발생했습니다: ${error.message}`;
    document.getElementById('chartRow').style.display = 'none';
  }
}

// AI 기반 재무분석 가져오기
async function fetchAIFinancialAnalysis(analysis) {
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
    } else {
      throw new Error(data.message || 'AI 분석 결과를 가져오지 못했습니다.');
    }
  } catch (error) {
    console.error('AI 재무분석 가져오기 오류:', error);
    aiAnalysisLoading.style.display = 'none';
    aiAnalysisError.style.display = 'block';
    aiAnalysisError.textContent = `AI 분석을 가져오는 중 오류가 발생했습니다: ${error.message}`;
  }
}

// 개요 차트 표시 함수
function displayOverviewCharts(analysis) {
  try {
    // 차트 요소 확인
    if (!overviewChartCanvas) {
      console.error('차트 캔버스 요소를 찾을 수 없습니다.');
      throw new Error('차트를 표시할 수 없습니다. 페이지를 새로고침해주세요.');
    }
    
    // 기존 차트 정리
    if (overviewChart) {
      overviewChart.destroy();
      overviewChart = null;
    }
    
    const overviewCtx = overviewChartCanvas.getContext('2d');
    
    // 주요 재무 지표 데이터 준비
    const labels = [
      '매출액', '영업이익', '당기순이익', 
      '자산총계', '부채총계', '자본총계', 
      '유동자산', '유동부채' // 유동자산, 유동부채 추가
    ];
    const currentData = [
      analysis.incomeStatement?.['매출액']?.current || 0,
      analysis.incomeStatement?.['영업이익']?.current || 0,
      analysis.incomeStatement?.['당기순이익']?.current || 0,
      analysis.balanceSheet?.['자산총계']?.current || 0,
      analysis.balanceSheet?.['부채총계']?.current || 0,
      analysis.balanceSheet?.['자본총계']?.current || 0,
      analysis.balanceSheet?.['유동자산']?.current || 0, // 유동자산 데이터 추가
      analysis.balanceSheet?.['유동부채']?.current || 0  // 유동부채 데이터 추가
    ];
    const previousData = [
      analysis.incomeStatement?.['매출액']?.previous || 0,
      analysis.incomeStatement?.['영업이익']?.previous || 0,
      analysis.incomeStatement?.['당기순이익']?.previous || 0,
      analysis.balanceSheet?.['자산총계']?.previous || 0,
      analysis.balanceSheet?.['부채총계']?.previous || 0,
      analysis.balanceSheet?.['자본총계']?.previous || 0,
      analysis.balanceSheet?.['유동자산']?.previous || 0, // 유동자산 데이터 추가
      analysis.balanceSheet?.['유동부채']?.previous || 0  // 유동부채 데이터 추가
    ];
    
    // 데이터에 유효값이 하나도 없는지 확인
    const hasValidOverviewData = currentData.some(val => val > 0) || previousData.some(val => val > 0);
    
    if (!hasValidOverviewData) {
      console.warn('유효한 재무 지표 데이터가 없습니다.');
      loadingIndicator.style.display = 'none';
      overviewError.style.display = 'block';
      overviewError.textContent = '유효한 재무 지표 데이터가 없습니다.';
      document.getElementById('chartRow').style.display = 'none';
      return;
    }
    
    // 주요 재무 지표 차트 (막대 그래프)
    const overviewData = {
      labels: labels,
      datasets: [
        {
          label: `${currentYear}년`,
          data: currentData,
          backgroundColor: 'rgba(54, 162, 235, 0.6)',
          borderColor: 'rgb(54, 162, 235)',
          borderWidth: 1
        },
        {
          label: `${previousYear}년`,
          data: previousData,
          backgroundColor: 'rgba(255, 159, 64, 0.6)',
          borderColor: 'rgb(255, 159, 64)',
          borderWidth: 1
        }
      ]
    };
    
    // 주요 재무 지표 차트 생성
    overviewChart = new Chart(overviewCtx, {
      type: 'bar',
      data: overviewData,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: {
            display: true,
            text: `${selectedCompany.corp_name} - 주요 재무 지표`,
            font: {
              size: 16,
              weight: 'bold'
            }
          },
          tooltip: {
            callbacks: {
              label: function(context) {
                return `${context.dataset.label}: ${formatAmountBetter(context.raw)}`;
              }
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback: function(value) {
                return formatAmountBetter(value, true);
              }
            }
          }
        }
      }
    });
    
    // 차트 행 표시
    document.getElementById('chartRow').style.display = 'flex';
  } catch (error) {
    console.error('차트 표시 중 오류 발생:', error);
    loadingIndicator.style.display = 'none';
    overviewError.style.display = 'block';
    overviewError.textContent = `차트 표시 중 오류가 발생했습니다: ${error.message}`;
    document.getElementById('chartRow').style.display = 'none';
  }
}

// 구성 비율 차트 표시 함수 (신규)
function displayCompositionCharts(analysis) {
  try {
    // 캔버스 요소 확인
    if (!assetCompositionChartCanvas || !liabilityEquityChartCanvas) {
      console.error('구성 비율 차트 캔버스 요소를 찾을 수 없습니다.');
      return; // 오류 발생 시 함수 종료
    }

    // 기존 차트 정리
    if (assetCompositionChart) assetCompositionChart.destroy();
    if (liabilityEquityChart) liabilityEquityChart.destroy();

    const assetCtx = assetCompositionChartCanvas.getContext('2d');
    const liabilityEquityCtx = liabilityEquityChartCanvas.getContext('2d');

    // 데이터 준비
    const currentAssets = analysis.balanceSheet?.['유동자산']?.current || 0;
    const nonCurrentAssets = analysis.balanceSheet?.['비유동자산']?.current || 0;
    const totalLiabilities = analysis.balanceSheet?.['부채총계']?.current || 0;
    const totalEquity = analysis.balanceSheet?.['자본총계']?.current || 0;
    const totalAssets = analysis.balanceSheet?.['자산총계']?.current || (currentAssets + nonCurrentAssets);
    const totalLiabilityEquity = totalLiabilities + totalEquity;

    // 보고서 이름 가져오기 (여기서도 필요)
    const reportCode = reportTypeSelect.value;
    const reportCodeMap = {
      '11011': '사업보고서',
      '11012': '반기보고서',
      '11013': '1분기보고서',
      '11014': '3분기보고서'
    };
    const reportName = reportCodeMap[reportCode] || '보고서';

    // 데이터 유효성 검사 (자산)
    if (totalAssets <= 0) {
      console.warn('유효한 자산 데이터가 없어 자산 구성 차트를 생성할 수 없습니다.');
      assetCompositionChartCanvas.parentElement.innerHTML = '<p class="text-center text-muted small">자산 데이터 없음</p>';
    } else {
      // 자산 구성 차트 데이터
      const assetData = {
        labels: ['유동자산', '비유동자산'],
        datasets: [{
          data: [currentAssets, nonCurrentAssets],
          backgroundColor: ['rgba(54, 162, 235, 0.8)', 'rgba(75, 192, 192, 0.8)'],
          borderColor: ['#ffffff'],
          borderWidth: 2
        }]
      };
      // 자산 구성 차트 생성
      assetCompositionChart = new Chart(assetCtx, {
        type: 'doughnut',
        data: assetData,
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            title: {
              display: true,
              text: `${currentYear}년 ${reportName} 자산 구성`,
              font: { size: 14 }
            },
            tooltip: {
              callbacks: {
                label: function(context) {
                  const label = context.label || '';
                  const value = context.raw || 0;
                  const percentage = totalAssets > 0 ? ((value / totalAssets) * 100).toFixed(1) : 0;
                  return `${label}: ${formatAmountBetter(value)} (${percentage}%)`;
                }
              }
            },
            legend: {
              position: 'bottom',
              labels: { boxWidth: 12 }
            }
          }
        }
      });
    }

    // 데이터 유효성 검사 (부채/자본)
    if (totalLiabilityEquity <= 0) {
      console.warn('유효한 부채/자본 데이터가 없어 부채/자본 구성 차트를 생성할 수 없습니다.');
      liabilityEquityChartCanvas.parentElement.innerHTML = '<p class="text-center text-muted small">부채/자본 데이터 없음</p>';
    } else {
      // 부채/자본 구성 차트 데이터
      const liabilityEquityData = {
        labels: ['부채총계', '자본총계'],
        datasets: [{
          data: [totalLiabilities, totalEquity],
          backgroundColor: ['rgba(255, 99, 132, 0.8)', 'rgba(255, 206, 86, 0.8)'],
          borderColor: ['#ffffff'],
          borderWidth: 2
        }]
      };
      // 부채/자본 구성 차트 생성
      liabilityEquityChart = new Chart(liabilityEquityCtx, {
        type: 'doughnut',
        data: liabilityEquityData,
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            title: {
              display: true,
              text: `${currentYear}년 ${reportName} 부채/자본 구성`,
              font: { size: 14 }
            },
            tooltip: {
              callbacks: {
                label: function(context) {
                  const label = context.label || '';
                  const value = context.raw || 0;
                  const percentage = totalLiabilityEquity > 0 ? ((value / totalLiabilityEquity) * 100).toFixed(1) : 0;
                  return `${label}: ${formatAmountBetter(value)} (${percentage}%)`;
                }
              }
            },
            legend: {
              position: 'bottom',
              labels: { boxWidth: 12 }
            }
          }
        }
      });
    }

  } catch (error) {
    console.error('구성 비율 차트 표시 중 오류 발생:', error);
    // 오류 발생 시 해당 차트 영역에 메시지 표시
    if (assetCompositionChartCanvas) assetCompositionChartCanvas.parentElement.innerHTML = '<p class="text-center text-danger small">차트 오류</p>';
    if (liabilityEquityChartCanvas) liabilityEquityChartCanvas.parentElement.innerHTML = '<p class="text-center text-danger small">차트 오류</p>';
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