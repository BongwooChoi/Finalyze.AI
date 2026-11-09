const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryStore } = require('../sharedStore');
const { createDartClient, kstDay } = require('../dartClient');
const BASE = 'https://opendart.fss.or.kr/api/list.json';
const NOW = Date.parse('2026-11-04T01:00:00Z');
const success = () => ({ data: { status: '000', list: [] }, headers: { 'content-type': 'application/json' } });
function client(store, transport, extra = {}) {
  return createDartClient({ apiKey: 'test-dart-key', store, transport, now: () => NOW, pause: async () => {}, ...extra });
}

test('다른 서버 인스턴스에서도 같은 DART 응답을 재사용한다', async () => {
  const store = createMemoryStore();
  let calls = 0;
  const transport = async () => { calls++; return success(); };
  const first = client(store, transport);
  const second = client(store, transport);
  await first.get(BASE, { params: { bgn_de: '20261104' } });
  await second.get(`${BASE}?bgn_de=20261104`);
  assert.equal(calls, 1);
});

test('같은 공시의 동시 요청은 한 번만 DART로 전송한다', async () => {
  const store = createMemoryStore();
  let calls = 0;
  const transport = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return success(); };
  const pause = () => new Promise(resolve => setTimeout(resolve, 1));
  await Promise.all([client(store, transport, { pause }).get(BASE), client(store, transport, { pause }).get(BASE)]);
  assert.equal(calls, 1);
});

test('전역 호출 슬롯은 1초 간격으로 예약되고 대기열과 하루 한도를 제한한다', async () => {
  const store = createMemoryStore({ now: () => NOW });
  const slots = await Promise.all(Array.from({ length: 3 }, () => store.reserve('test', '2026-11-04', NOW, 1000, 3, 12000)));
  assert.deepEqual(slots.map(value => value[0]), [0, 1000, 2000]);
  assert.equal((await store.reserve('test', '2026-11-04', NOW, 1000, 3, 12000))[0], -3);
  assert.equal((await store.reserve('queue', '2026-11-04', NOW, 1000, 100, 0))[0], 0);
  assert.equal((await store.reserve('queue', '2026-11-04', NOW, 1000, 100, 0))[0], -2);
});

test('하루 호출 한도는 서로 다른 서버와 API가 공유한다', async () => {
  const store = createMemoryStore({ now: () => NOW });
  let calls = 0;
  const transport = async () => { calls++; return success(); };
  await client(store, transport, { dailyLimit: 1 }).get(`${BASE}?page_no=1`);
  await assert.rejects(client(store, transport, { dailyLimit: 1 }).get(`${BASE}?page_no=2`), { code: 'DART_RATE_LIMITED' });
  assert.equal(calls, 1);
});

test('DART 020 응답을 받으면 한국 시간 다음 날까지 추가 호출을 중단한다', async () => {
  let timestamp = NOW;
  const store = createMemoryStore({ now: () => timestamp });
  let calls = 0;
  const transport = async () => { calls++; return { data: { status: calls === 1 ? '020' : '000' }, headers: {} }; };
  const instance = client(store, transport, { now: () => timestamp });
  await assert.rejects(instance.get(BASE), { code: 'DART_RATE_LIMITED', dartStatus: '020' });
  await assert.rejects(instance.get(`${BASE}?page_no=2`), { code: 'DART_RATE_LIMITED' });
  assert.equal(calls, 1);
  timestamp = Date.parse('2026-11-04T15:00:01Z');
  assert.equal(kstDay(timestamp), '2026-11-05');
  await instance.get(BASE);
  assert.equal(calls, 2);
});

test('원문 다운로드의 XML 요청 제한 응답도 감지한다', async () => {
  const store = createMemoryStore({ now: () => NOW });
  const instance = client(store, async () => ({ data: Buffer.from('<?xml version="1.0"?><result><status>020</status></result>'), headers: {} }));
  await assert.rejects(instance.get('https://opendart.fss.or.kr/api/document.xml', { responseType: 'arraybuffer' }),
    { code: 'DART_RATE_LIMITED', dartStatus: '020' });
});

test('원문 014는 준비 대기로 구분하며 실패 응답을 캐시하지 않는다',async()=>{
  const store=createMemoryStore({now:()=>NOW});let calls=0;
  const zip=Buffer.from('PK fake successful ZIP');
  const instance=client(store,async()=>({data:++calls===1 ? Buffer.from('<result><status>014</status><message>파일이 존재하지 않습니다.</message></result>') : zip,headers:{'content-type':'application/octet-stream'}}));
  const url='https://opendart.fss.or.kr/api/document.xml';
  await assert.rejects(instance.get(url,{responseType:'arraybuffer'}),{code:'DART_DOCUMENT_NOT_READY',dartStatus:'014'});
  assert.deepEqual((await instance.get(url,{responseType:'arraybuffer'})).data,zip);
  assert.equal(calls,2);
});

test('HTTP 429를 받으면 다른 API도 추가 전송하지 않는다', async () => {
  const store = createMemoryStore({ now: () => NOW });
  let calls = 0;
  const instance = client(store, async () => { calls++; throw { response: { status: 429 } }; });
  await assert.rejects(instance.get(BASE), { code: 'DART_RATE_LIMITED' });
  await assert.rejects(instance.get('https://opendart.fss.or.kr/api/fnlttSinglAcnt.json'), { code: 'DART_RATE_LIMITED' });
  assert.equal(calls, 1);
});

test('공유 캐시 장애에서는 제한 장치를 우회해 DART를 호출하지 않는다', async () => {
  let calls = 0;
  const instance = client({ get: async () => { throw new Error('cache offline'); } }, async () => { calls++; return success(); });
  await assert.rejects(instance.get(BASE), /cache offline/);
  assert.equal(calls, 0);
});

test('원문 ZIP을 공유 캐시에서 읽어도 Buffer와 Content-Type을 보존한다', async () => {
  const store = createMemoryStore();
  let calls = 0;
  const bytes = Buffer.from('PK-example');
  const transport = async () => { calls++; return { data: bytes, headers: { 'content-type': 'application/zip' } }; };
  const url = 'https://opendart.fss.or.kr/api/document.xml?rcept_no=20261104000001';
  await client(store, transport).get(url, { responseType: 'arraybuffer' });
  const cached = await client(store, transport).get(url, { responseType: 'arraybuffer' });
  assert.deepEqual(cached.data, bytes);
  assert.equal(cached.headers['content-type'], 'application/zip');
  assert.equal(calls, 1);
});

test('오류에 인증키와 axios 요청 헤더를 포함하지 않는다', async () => {
  const instance = client(createMemoryStore(), async () => {
    throw Object.assign(new Error('failed test-dart-key'), { code: 'ECONNRESET', config: { params: { crtfc_key: 'test-dart-key' } } });
  });
  await assert.rejects(instance.get(BASE), error => !error.message.includes('test-dart-key') && !error.config && error.code === 'ECONNRESET');
});
