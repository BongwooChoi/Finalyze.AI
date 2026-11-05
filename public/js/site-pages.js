// 서버 렌더링과 브라우저 화면 전환에서 같은 메타데이터를 사용합니다.
const SITE_PAGES = {
  analysis: {
    path: '/',
    title: 'Finalyze.AI - AI 기반 재무제표 분석 플랫폼 | DART 공시 데이터',
    description: 'Finalyze.AI는 DART 공시 데이터를 기반으로 한국 상장기업의 재무제표를 시각화하고 AI로 분석하는 무료 플랫폼입니다. 정기보고서 4종과 잠정실적 공시를 분석할 수 있습니다.',
    url: 'https://finalyze-ai.vercel.app/'
  },
  about: {
    path: '/about',
    title: '시스템 소개·사용법·분석 기준 | Finalyze.AI',
    description: 'Finalyze.AI의 정기보고서·잠정실적 분석 사용법, 재무비율 계산 기준, 자주 묻는 질문과 DART 데이터 출처를 확인하세요. 시스템 구성도와 모바일 접속 QR코드도 제공합니다.',
    url: 'https://finalyze-ai.vercel.app/about'
  }
};

function getPageStructuredData(pageName) {
  const application = {
    '@type': 'WebApplication',
    '@id': `${SITE_PAGES.analysis.url}#application`,
    name: 'Finalyze.AI',
    url: SITE_PAGES.analysis.url,
    description: SITE_PAGES.analysis.description,
    applicationCategory: 'FinanceApplication',
    operatingSystem: 'Web',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'KRW' },
    featureList: ['재무제표 시각화', 'AI 재무분석', '정기보고서 4종 분석', '잠정실적 공시 분석', '최근 5개년 실적 추이', 'PDF·이미지 저장'],
    inLanguage: 'ko',
    isAccessibleForFree: true
  };
  if (pageName === 'analysis') return { '@context': 'https://schema.org', ...application };
  return {
    '@context': 'https://schema.org',
    '@type': 'AboutPage',
    '@id': SITE_PAGES.about.url,
    url: SITE_PAGES.about.url,
    name: SITE_PAGES.about.title,
    description: SITE_PAGES.about.description,
    inLanguage: 'ko',
    dateModified: '2026-11-06',
    isPartOf: { '@type': 'WebSite', name: 'Finalyze.AI', url: SITE_PAGES.analysis.url },
    hasPart: [
      { '@type': 'WebPageElement', '@id': `${SITE_PAGES.about.url}#how-to-use`, name: 'Finalyze.AI 사용법' },
      { '@type': 'WebPageElement', '@id': `${SITE_PAGES.about.url}#analysis-method`, name: '데이터와 분석 기준' },
      { '@type': 'WebPageElement', '@id': `${SITE_PAGES.about.url}#faq`, name: '자주 묻는 질문' }
    ],
    about: application
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { pages: SITE_PAGES, getPageStructuredData };
}
