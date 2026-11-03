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
  for (const asset of ['/js/site-pages.js', '/js/main.js', '/css/style.css', '/images/finalyze-mobile-qr.png']) {
    assert.equal((await fetch(baseUrl + asset)).status, 200, asset);
  }
  assert.equal((await fetch(`${baseUrl}/page-does-not-exist`)).status, 404);
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
