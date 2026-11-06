const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Express의 서버리스 진입점을 임시 포트에서 검사합니다. 외부 AI·DART 요청은 하지 않습니다.
process.env.NODE_ENV = 'production';
const app = require('../server');
let server;
let baseUrl;

before(async () => {
  server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); });

function mainTag(html, id) {
  return html.match(new RegExp(`<main\\b[^>]*id="${id}"[^>]*>`))[0];
}

test('홈은 분석 화면과 루트 canonical을 초기 HTML에 제공한다', async () => {
  const response = await fetch(baseUrl);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.doesNotMatch(mainTag(html, 'analysisPage'), /\bhidden\b/);
  assert.match(mainTag(html, 'aboutPage'), /\bhidden\b/);
  assert.match(html, /<link rel="canonical" href="https:\/\/finalyze-ai\.vercel\.app\/">/);
  assert.match(html, /href="\/about"/);
  assert.match(html, /id="recentDisclosuresTitle"/);
  assert.match(html, /주요 기업의 최신 실적 공시/);
  const schema = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(schema['@type'], 'WebApplication');
});

test('/about은 JS 없이 소개 본문·전용 메타데이터를 제공한다', async () => {
  const response = await fetch(`${baseUrl}/about`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotMatch(mainTag(html, 'aboutPage'), /\bhidden\b/);
  assert.match(mainTag(html, 'analysisPage'), /\bhidden\b/);
  assert.match(html, /<title>시스템 소개·사용법·분석 기준 \| Finalyze\.AI<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/finalyze-ai\.vercel\.app\/about">/);
  assert.match(html, /property="og:url" content="https:\/\/finalyze-ai\.vercel\.app\/about"/);
  assert.match(html, /id="aboutTitle">공시 속 숫자를/);
  for (const section of ['how-to-use', 'analysis-method', 'faq', 'data-sources']) {
    assert.ok(html.includes(`id="${section}"`), section);
  }
  assert.match(html, /재무비율도 AI가 계산하나요/);
  assert.match(html, /분기·반기 수치를 연환산하지 않습니다/);
  assert.match(html, /data-page="about" aria-current="page"/);
  assert.match(html, /src="\/js\/main\.js\?v=/);
  const schema = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(schema['@type'], 'AboutPage');
  assert.equal(schema.url, 'https://finalyze-ai.vercel.app/about');
});

test('기업 선택 파라미터가 있는 소개 URL도 같은 공개 canonical을 사용한다', async () => {
  const html = await (await fetch(`${baseUrl}/about?corp=00126380&name=Samsung`)).text();
  assert.doesNotMatch(mainTag(html, 'aboutPage'), /\bhidden\b/);
  assert.match(html, /rel="canonical" href="https:\/\/finalyze-ai\.vercel\.app\/about"/);
});

test('별칭 주소는 쿼리를 보존해 정규 URL로 301 이동한다', async () => {
  for (const [source, destination] of [['/index.html?corp=00126380', '/?corp=00126380'], ['/about/?corp=00126380', '/about?corp=00126380']]) {
    const response = await fetch(baseUrl + source, { redirect: 'manual' });
    assert.equal(response.status, 301);
    assert.equal(response.headers.get('location'), destination);
  }
});

test('필수 정적 자산을 제공하고 존재하지 않는 경로는 404를 유지한다', async () => {
  for (const asset of ['/js/site-pages.js', '/js/main.js', '/js/accounts.js', '/css/style.css', '/images/finalyze-mobile-qr.png']) {
    assert.equal((await fetch(baseUrl + asset)).status, 200, asset);
  }
  assert.equal((await fetch(`${baseUrl}/page-does-not-exist`)).status, 404);
});

test('개인정보 안내와 비로그인 계정 응답을 제공하고 알림 작업은 비공개로 보호한다',async()=>{
  const privacy=await fetch(`${baseUrl}/privacy`); assert.equal(privacy.status,200);
  assert.match(await privacy.text(),/이름·프로필 사진·Google 비밀번호·원본 로그인 토큰은 저장하지 않습니다/);
  const account=await fetch(`${baseUrl}/api/account`); assert.equal(account.status,200);
  assert.equal(account.headers.get('cache-control'),'no-store'); assert.match(account.headers.get('vary'),/Cookie/);
  const value=await account.json(); assert.equal(value.authenticated,false); assert.equal(value.csrfToken,undefined);
  assert.equal((await fetch(`${baseUrl}/api/jobs/disclosures`,{method:'POST'})).status,401);
});

test('운영 AI 경로는 비회원의 직접 요청을 차단하고 숫자 조회 경로는 공개한다',async t=>{
  const axios=require('axios');
  t.mock.method(axios,'post',async()=>assert.fail('비회원 요청에서 LLM을 호출했습니다.'));
  for(const [path,method] of [['/api/ai-financial-analysis','POST'],['/api/provisional-analysis?rcept_no=20261106000001','GET']]) {
    const r=await fetch(baseUrl+path,{method,headers:{'Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})});
    assert.ok([401,503].includes(r.status));
    assert.equal(r.headers.get('cache-control'),'no-store');
    assert.match((await r.json()).code,/LOGIN_REQUIRED|ANALYSIS_ACCESS_DENIED/);
  }
  assert.equal((await fetch(`${baseUrl}/api/financial-analysis`)).status,400);
});

test('잠정실적 수치 경로는 비회원에게 원문 표를 제공하고 LLM을 호출하지 않는다',async t=>{
  const fs=require('node:fs'),path=require('node:path'),Zip=require('adm-zip');
  const zip=new Zip();zip.addFile('main.xml',fs.readFileSync(path.join(__dirname,'fixtures/provisional-samsung.html')));
  let calls=0;
  t.mock.method(require('../dartClient'),'get',async()=>{calls++;return{data:zip.toBuffer()};});
  t.mock.method(require('axios'),'post',async()=>assert.fail('시각화에 LLM을 호출했습니다.'));
  assert.equal((await fetch(`${baseUrl}/api/provisional-financials?rcept_no=invalid`)).status,400);assert.equal(calls,0);
  const r=await fetch(`${baseUrl}/api/provisional-financials?rcept_no=20261029800099`);
  assert.equal(r.status,200);assert.match(r.headers.get('cache-control'),/public/);
  const data=await r.json();assert.equal(data.chartData.metrics[0].current,195.25);assert.equal(calls,1);
});

test('로고는 선택 상태를 유지하는 SPA 링크가 아닌 첫 화면 링크다',async()=>{
  const html=await(await fetch(`${baseUrl}/about?corp=00126380`)).text();
  const logo=html.match(/<a\b[^>]*class="site-brand"[^>]*>/)[0];
  assert.match(logo,/href="\/"/);assert.doesNotMatch(logo,/data-page-link/);
});

test('사이트맵의 공개 URL은 정상 HTML과 일치하는 canonical을 제공한다', async () => {
  const response = await fetch(`${baseUrl}/sitemap.xml`);
  assert.equal(response.status, 200);
  const sitemap = await response.text();
  const urls = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]);
  assert.deepEqual(urls, ['https://finalyze-ai.vercel.app/', 'https://finalyze-ai.vercel.app/about']);
  for (const url of urls) {
    const page = await fetch(baseUrl + new URL(url).pathname);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes(`<link rel="canonical" href="${url}">`));
  }
});

test('Google 소유권 확인 파일은 로그인·리디렉션 없이 원문을 제공한다', async () => {
  const response = await fetch(`${baseUrl}/google6cac55f830514a99.html`, { redirect: 'manual' });
  assert.equal(response.status, 200);
  assert.equal((await response.text()).trim(), 'google-site-verification: google6cac55f830514a99.html');
});

test('최신 공시 API는 외부 오류의 상세 내용을 공개하거나 캐시하지 않는다', async t => {
  const axios = require('axios');
  t.mock.method(axios, 'get', async () => { throw new Error('private-upstream-error'); });
  const response = await fetch(`${baseUrl}/api/recent-disclosures`);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.text();
  assert.doesNotMatch(body, /private-upstream-error/);
  assert.equal(JSON.parse(body).status, 'error');
});

test('최신 공시 API는 기업별 목록과 갱신 시각을 공유 캐시로 제공한다', async t => {
  // 직전 테스트의 공유 실패 캐시는 1분 동안 다른 서버의 재수집도 막습니다.
  const recoveredTime = Date.now() + 61000;
  t.mock.method(Date, 'now', () => recoveredTime);
  const axios = require('axios');
  const stocks = ['005930', '000660', '005380', '000270', '035420', '035720', '373220', '051910'];
  t.mock.method(axios, 'get', async (url, { params }) => ({ data: params.pblntf_ty === 'A' ? {
    status: '000', total_page: 1, list: stocks.map((stock, index) => ({
      corp_code: String(index + 1).padStart(8, '0'), corp_name: `기업${index}`, stock_code: stock,
      corp_cls: 'Y', report_nm: '분기보고서 (2026.09)', rcept_no: `20261103${String(index).padStart(6, '0')}`,
      rcept_dt: '20261103', rm: ''
    }))
  } : { status: '013' } }));
  const response = await fetch(`${baseUrl}/api/recent-disclosures`);
  assert.equal(response.status, 200);
  const cacheSeconds = Number(response.headers.get('cache-control').match(/s-maxage=(\d+)/)[1]);
  assert.ok(cacheSeconds > 0 && cacheSeconds <= 300);
  const body = await response.json();
  assert.equal(body.data.length, 5);
  assert.equal(body.companyCount, 60);
  assert.equal(body.stale, false);
  assert.ok(Number.isFinite(Date.parse(body.updatedAt)));
});
