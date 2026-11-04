const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRecentDisclosureService, hasFinancialResults, reportType } = require('../recentDisclosures');
const { createMemoryStore } = require('../sharedStore');

const TODAY = Date.parse('2026-11-03T02:00:00Z');
const STOCKS = ['005930', '000660', '005380', '000270', '035420', '035720', '373220', '051910', '006400'];
function row(index, overrides = {}) {
  return { corp_code: String(index + 1).padStart(8, '0'), corp_name: `기업${index}`,
    stock_code: STOCKS[index], corp_cls: 'Y', report_nm: '분기보고서 (2026.09)',
    rcept_no: `20261103${String(index + 1).padStart(6, '0')}`, rcept_dt: '20261103', rm: '', ...overrides };
}
function listFetcher(rows, calls = []) {
  return async params => {
    calls.push(params);
    const matches = rows.filter(item => item.rcept_dt >= params.bgn_de && item.rcept_dt <= params.end_de &&
      (params.pblntf_ty === 'A' ? !item.report_nm.includes('잠정') : item.report_nm.includes('잠정')));
    if (!matches.length) return { status: '013' };
    const offset = (params.page_no - 1) * params.page_count;
    return { status: '000', total_page: Math.ceil(matches.length / params.page_count), list: matches.slice(offset, offset + params.page_count) };
  };
}
function service(rows, extras = {}) {
  return createRecentDisclosureService({ fetchList: listFetcher(rows), now: () => TODAY,
    fetchDocumentText: async () => '매출액 |\n당해실적 |\n1,234 |\n1,100 |', ...extras });
}

test('지원하는 정기보고서와 잠정실적만 분류한다', () => {
  assert.equal(reportType('[기재정정]분기보고서 (2026.09)'), '3분기보고서');
  assert.equal(reportType('반기보고서 (2026.06)'), '반기보고서');
  assert.equal(reportType('사업보고서 (2025.12)'), '사업보고서');
  assert.equal(reportType('분기보고서 (2026.03)'), '1분기보고서');
  assert.equal(reportType('분기보고서 (2026.06)'), null);
  assert.equal(reportType('주요사항보고서(유상증자결정)'), null);
});

test('빈 재무 양식 뒤 판매대수·날짜를 재무금액으로 오인하지 않는다', () => {
  assert.equal(hasFinancialResults('매출액 | 당해실적 | - | - | 영업이익 | 당해실적 | - | - | 판매대수 | 329,773 | 2026.10 |'), false);
  assert.equal(hasFinancialResults('매출액 |\n당해실적 |\n15,774 |\n16,574 |'), true);
  assert.equal(hasFinancialResults('영업이익(손실) | 당해실적 | (1,234) |'), true);
  assert.equal(hasFinancialResults('영업수익 | 당해실적 | 0 |'), true);
});

test('인지도 목록 밖·비상장·자회사·철회·정정 전 공시를 제외하고 기업별 최신 5개를 고른다', async () => {
  const rows = STOCKS.map((_, index) => row(index));
  rows.push(row(0, { rcept_no: '20261103000999', report_nm: '연결재무제표기준영업(잠정)실적(공정공시)(자회사의 주요경영사항)' }));
  rows.push(row(1, { rcept_no: '20261103000998', report_nm: '사업보고서 (2025.12)', rm: '정' }));
  rows.push(row(2, { rcept_no: '20261103000997', report_nm: '사업보고서 (2025.12)', rm: '철' }));
  rows.push(row(20, { stock_code: '999999' }));
  rows.push(row(21, { stock_code: '005930', corp_cls: 'E' }));
  const result = await service(rows).getRecentDisclosures();
  assert.equal(result.data.length, 5);
  assert.equal(new Set(result.data.map(item => item.corp_code)).size, 5);
  assert.ok(result.data.every(item => !['20261103000999', '20261103000998', '20261103000997'].includes(item.rcept_no)));
  assert.equal(result.lookbackDays, 30);
  assert.equal(result.companyCount, 60);
});

test('같은 날 연결 실적을 우선하고 정정 여부를 보존한다', async () => {
  const rows = [row(0, { report_nm: '영업(잠정)실적(공정공시)', rcept_no: '20261103000999' }),
    row(0, { report_nm: '[기재정정]연결재무제표기준영업(잠정)실적(공정공시)' })];
  const result = await service(rows).getRecentDisclosures();
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].corrected, true);
  assert.match(result.data[0].report_nm, /연결재무제표/);
});

test('월간 판매실적을 건너뛴 후에도 다른 기업의 더 최근 공시를 빠뜨리지 않는다', async () => {
  const rows = STOCKS.map((_, index) => row(index, { rcept_dt: '20261102', rcept_no: `20261102${String(index).padStart(6, '0')}` }));
  rows.push(row(0, { report_nm: '영업(잠정)실적(공정공시)' }));
  const calls = [];
  const result = await service(rows, { fetchDocumentText: async receipt => {
    calls.push(receipt); return '매출액 | 당해실적 | - | 판매대수 | 123 |';
  } }).getRecentDisclosures();
  assert.ok(calls.length > 0);
  assert.equal(result.data.length, 5);
  assert.ok(result.data.every(item => item.rcept_dt === '20261102'));
});

test('100건을 넘는 공시의 다음 페이지와 KST 날짜 범위를 확인한다', async () => {
  const calls = [];
  const rows = Array.from({ length: 101 }, (_, index) => row(20 + index, { stock_code: '999999' }));
  rows.push(row(0));
  const result = await service(rows, { fetchList: listFetcher(rows, calls), now: () => Date.parse('2026-11-02T15:05:00Z') }).getRecentDisclosures();
  assert.equal(result.data.length, 1);
  assert.ok(calls.some(params => params.page_no === 2));
  assert.equal(calls[0].end_de, '20261103');
  assert.equal(calls[0].bgn_de, '20261005');
  assert.ok(calls.every(params => params.last_reprt_at === 'Y'));
});

test('30일에 5개 미만이면 이전 60일만 추가 조회한다', async () => {
  const calls = [];
  const rows = [row(0), row(1, { rcept_dt: '20260901', rcept_no: '20260901000001' }),
    row(2, { rcept_dt: '20260801', rcept_no: '20260801000001' })];
  const result = await service(rows, { fetchList: listFetcher(rows, calls) }).getRecentDisclosures();
  assert.equal(result.lookbackDays, 90);
  assert.deepEqual(result.data.map(item => item.corp_name), ['기업0', '기업1']);
  assert.ok(calls.some(params => params.end_de === '20261004' && params.bgn_de === '20260806'));
});

test('동시 요청과 5분 이내 재조회는 같은 수집 작업을 공유한다', async () => {
  const calls = [];
  const instance = service(STOCKS.map((_, index) => row(index)), { fetchList: listFetcher(STOCKS.map((_, index) => row(index)), calls) });
  const [one, two] = await Promise.all([instance.getRecentDisclosures(), instance.getRecentDisclosures()]);
  assert.deepEqual(one, two);
  await instance.getRecentDisclosures();
  assert.equal(calls.length, 2);
});

test('갱신 실패 시 마지막 확인 시각을 유지하고 24시간이 지나면 실패를 반환한다', async () => {
  let timestamp = TODAY;
  let fail = false;
  const fetch = listFetcher(STOCKS.map((_, index) => row(index)));
  const instance = service([], { now: () => timestamp, fetchList: params => {
    if (fail) throw new Error('외부 서비스 오류');
    return fetch(params);
  } });
  const first = await instance.getRecentDisclosures();
  fail = true;
  timestamp += 301000;
  const stale = await instance.getRecentDisclosures();
  assert.equal(stale.stale, true);
  assert.equal(stale.updatedAt, first.updatedAt);
  assert.deepEqual(stale.data, first.data);
  timestamp += 24 * 3600000;
  await assert.rejects(instance.getRecentDisclosures(), /외부 서비스 오류/);
});

test('첫 수집이 실패하면 빈 정상 목록으로 캐시하지 않고 다음 요청에서 복구한다', async () => {
  let fail = true;
  const fetch = listFetcher(STOCKS.map((_, index) => row(index)));
  const instance = service([], { fetchList: params => fail ? Promise.resolve({ status: '020' }) : fetch(params) });
  await assert.rejects(instance.getRecentDisclosures());
  fail = false;
  assert.equal((await instance.getRecentDisclosures()).data.length, 5);
});

test('일시적인 공시 목록 통신 오류를 한 번 재시도한다', async () => {
  let failures = 0;
  const fetch = listFetcher(STOCKS.map((_, index) => row(index)));
  const instance = service([], { pause: async () => {}, fetchList: params => {
    if (params.pblntf_ty === 'A' && failures++ === 0) throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
    return fetch(params);
  } });
  const result = await instance.getRecentDisclosures();
  assert.equal(result.data.length, 5);
  assert.equal(failures, 2);
  assert.equal(result.partial, false);
});

test('원문 한 건이 실패해도 확인된 다른 기업을 표시하고 실패한 원문은 다시 확인한다', async () => {
  let timestamp = TODAY;
  let fail = true;
  const reports = STOCKS.map((_, index) => row(index, { report_nm: '연결재무제표기준영업(잠정)실적(공정공시)' }));
  const failedReceipt = reports[8].rcept_no;
  const events = [];
  const instance = service(reports, { now: () => timestamp, pause: async () => {},
    onDocumentError: receipt => events.push(receipt), fetchDocumentText: async receipt => {
      if (fail && receipt === failedReceipt) throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
      return '매출액 | 당해실적 | 1,234 |';
    }
  });
  const partial = await instance.getRecentDisclosures();
  assert.equal(partial.data.length, 5);
  assert.equal(partial.partial, true);
  assert.equal(partial.refreshSeconds, 60);
  assert.ok(partial.data.every(item => item.rcept_no !== failedReceipt));
  assert.deepEqual(events, [failedReceipt]);
  fail = false;
  timestamp += 61000;
  const recovered = await instance.getRecentDisclosures();
  assert.equal(recovered.partial, false);
  assert.equal(recovered.refreshSeconds, 300);
  assert.ok(recovered.data.some(item => item.rcept_no === failedReceipt));
});

test('원문을 전부 확인하지 못하면 빈 정상 목록을 반환하지 않는다', async () => {
  const reports = [row(0, { report_nm: '연결재무제표기준영업(잠정)실적(공정공시)' })];
  const instance = service(reports, { fetchDocumentText: async () => { throw new Error('Invalid ZIP'); } });
  await assert.rejects(instance.getRecentDisclosures());
});

test('최신 5개보다 오래된 나머지 페이지는 조회하지 않는다', async () => {
  const calls = [];
  const rows = [...STOCKS.slice(0, 5).map((_, index) => row(index)),
    ...Array.from({ length: 195 }, (_, index) => row(index + 20, { stock_code: '999999', rcept_dt: '20261101' }))];
  const result = await service(rows, { fetchList: listFetcher(rows, calls) }).getRecentDisclosures();
  assert.equal(result.data.length, 5);
  assert.ok(calls.every(params => params.page_no === 1));
});

test('새 서버 인스턴스도 공유 목록을 재사용한다', async () => {
  const sharedStore = createMemoryStore({ now: () => TODAY });
  await service(STOCKS.map((_, index) => row(index)), { sharedStore }).getRecentDisclosures();
  const result = await service([], { sharedStore, fetchList: async () => { throw Error('중복 수집'); } }).getRecentDisclosures();
  assert.equal(result.data.length, 5);
});

test('여러 서버가 동시에 초기 목록을 요청해도 한 서버만 수집한다', async () => {
  const sharedStore = createMemoryStore({ now: () => TODAY });
  let calls = 0;
  const fetch = listFetcher(STOCKS.map((_, index) => row(index)));
  const fetchList = async params => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return fetch(params); };
  const options = { sharedStore, fetchList, pause: () => new Promise(resolve => setTimeout(resolve, 1)) };
  const [one, two] = await Promise.all([service([], options).getRecentDisclosures(), service([], options).getRecentDisclosures()]);
  assert.deepEqual(one.data, two.data);
  assert.equal(calls, 2);
});

test('최초 수집이 실패하면 다른 서버도 1분 동안 중복 수집하지 않는다', async () => {
  const sharedStore = createMemoryStore({ now: () => TODAY });
  let calls = 0;
  const options = { sharedStore, fetchList: async () => { calls++; throw new Error('DART offline'); } };
  await assert.rejects(service([], options).getRecentDisclosures());
  await assert.rejects(service([], options).getRecentDisclosures());
  assert.equal(calls, 2);
});
