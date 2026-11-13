const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createAccountStore,sqliteDatabase}=require('../accountStore');
const {createTelegramBroadcast,createTelegramApi,telegramConfig,formatTelegramDisclosure,change}=require('../telegramDisclosures');
const {getIndexStockCodes}=require('../recentDisclosures');
const {createNotificationJob}=require('../disclosureNotifications');
const COMPANY={corp_code:'00126380',corp_name:'삼성전자',stock_code:'005930'};
const SECOND={corp_code:'00164779',corp_name:'현대자동차',stock_code:'005380'};
const OTHER={corp_code:'99999999',corp_name:'대상 외 기업',stock_code:'999999'};
const config={enabled:true,chat:'-1001234567890',token:'123456:'+ 'a'.repeat(35),origin:'https://finalyze-ai.vercel.app'};
const event=(id,company=COMPANY)=>({...company,rcept_no:`20261106${String(id).padStart(6,'0')}`,rcept_dt:'20261106',report_nm:'분기보고서 (2026.09)'});
async function fixture(t,options={}) {
  let time=Date.parse('2026-11-06T01:00:00Z'),calls=[];
  const now=()=>time,store=createAccountStore(sqliteDatabase(),now);
  t.after(()=>store.close());
  const broadcast=createTelegramBroadcast({config,store,now,companies:async()=>[COMPANY,SECOND,OTHER],pause:async()=>{},
    fetchDocument:async()=>{throw Error('unavailable');},api:async(method,payload)=>{calls.push({method,payload});return {message_id:100+calls.length};},...options});
  return {store,now,broadcast,calls,advance:ms=>{time+=ms;},capture:async(rows,incomplete=[])=>broadcast.capture(await broadcast.companies(),rows,now(),incomplete)};
}
test('explicit configuration is required and the shared featured list is copied',()=>{
  assert.equal(telegramConfig({}).enabled,false);
  assert.equal(telegramConfig({TELEGRAM_ENABLED:'true',TELEGRAM_BOT_TOKEN:config.token,TELEGRAM_CHAT_ID:config.chat}).enabled,true);
  assert.equal(telegramConfig({TELEGRAM_ENABLED:'true',TELEGRAM_BOT_TOKEN:config.token,TELEGRAM_CHAT_ID:'123'}).enabled,false);
  const stocks=getIndexStockCodes();assert.equal(stocks.length,require('../indexUniverse').getIndexUniverseSummary().companyCount);stocks.pop();assert.equal(getIndexStockCodes().length,require('../indexUniverse').getIndexUniverseSummary().companyCount);
});
test('initial history is skipped; all new receipts send once and only featured companies are captured',async t=>{
  const f=await fixture(t);await f.capture([event(1),event(8,OTHER)]);
  assert.equal((await f.broadcast.deliver()).sent,0);
  f.advance(1000);await f.capture([event(1),...Array.from({length:6},(_,i)=>event(i+2)),event(9,OTHER)]);
  assert.equal((await f.broadcast.deliver()).sent,6);
  await f.capture([event(7)]);assert.equal((await f.broadcast.deliver()).sent,0);
  assert.equal(f.calls.length,6);assert.equal((await f.store.query('SELECT * FROM app_telegram_deliveries')).length,7);
});
test('a failed first document delays only its company baseline',async t=>{
  const f=await fixture(t);await f.capture([event(1,SECOND)],[COMPANY.corp_code]);f.advance(1000);
  await f.capture([event(2),event(3,SECOND)]);assert.equal((await f.broadcast.deliver()).sent,1);
  assert.match(f.calls[0].payload.text,/현대자동차/);
  f.advance(1000);await f.capture([event(4)]);assert.equal((await f.broadcast.deliver()).sent,1);
});

test('new index constituents establish their own baseline without replaying history or resetting existing companies',async t=>{
  const universe=require('../public/data/disclosure-universe.json');
  const added={corp_code:'88888888',corp_name:'신규 지수 기업',stock_code:universe.indices[1].constituents[0].stockCode};
  let companies=[COMPANY];
  const f=await fixture(t,{companies:async()=>companies});
  await f.capture([event(1)]);
  companies=[COMPANY,added];f.advance(1000);
  await f.capture([event(2),event(3,added)]);
  assert.equal((await f.broadcast.deliver()).sent,1);
  assert.match(f.calls[0].payload.text,/삼성전자/);
  f.advance(1000);await f.capture([event(2),event(3,added),event(4,added)]);
  assert.equal((await f.broadcast.deliver()).sent,1);
  assert.match(f.calls[1].payload.text,/신규 지수 기업/);
});
test('a company removed from scope is skipped even when its event is already queued',async t=>{
  let companies=[COMPANY];const f=await fixture(t,{companies:async()=>companies});
  await f.capture([]);f.advance(1000);await f.capture([event(1)]);companies=[];
  assert.equal((await f.broadcast.deliver()).skipped,1);assert.equal(f.calls.length,0);
});
test('429 pauses the whole channel; a due retry succeeds once',async t=>{
  let attempts=0;const f=await fixture(t,{api:async()=>{if(++attempts===1)throw {statusCode:429,retryAfter:60};return {message_id:1};}});
  await f.capture([]);f.advance(1000);await f.capture([event(1),event(2)]);
  assert.equal((await f.broadcast.deliver()).failed,1);await f.broadcast.deliver();assert.equal(attempts,1);
  f.advance(60001);assert.equal((await f.broadcast.deliver()).sent,2);assert.equal(attempts,3);
  await f.broadcast.deliver();assert.equal(attempts,3);
});
test('timeouts and abandoned sends are held as uncertain rather than duplicated',async t=>{
  const f=await fixture(t,{api:async()=>{throw {uncertain:true};}});
  await f.capture([]);f.advance(1000);await f.capture([event(1),event(2)]);
  assert.equal((await f.broadcast.deliver()).uncertain,1);
  assert.ok(await f.store.claimTelegram(config.chat,event(2).rcept_no));f.advance(31000);
  assert.equal((await f.store.telegramPending(config.chat)).length,0);
  assert.deepEqual((await f.store.query('SELECT status FROM app_telegram_deliveries')).map(r=>r.status),['uncertain','uncertain']);
});
test('a provider success followed by database failure cannot automatically resend',async t=>{
  const f=await fixture(t);await f.capture([]);f.advance(1000);await f.capture([event(1)]);
  const original=f.store.finishTelegram;f.store.finishTelegram=async()=>{throw Error('database offline');};
  await assert.rejects(f.broadcast.deliver(),/database offline/);assert.equal(f.calls.length,1);
  f.store.finishTelegram=original;f.advance(31000);await f.broadcast.deliver();assert.equal(f.calls.length,1);
});
test('formatting escapes HTML, preserves source units, and links without requesting AI',()=>{
  const message=formatTelegramDisclosure({...event(1),corp_name:'<회사 & 이름>',report_nm:'영업(잠정)실적(공정공시)'},{unit:'억원',labels:{current:'26.3Q'},metrics:[
    {name:'매출액',current:100,previous:80,yearAgo:50},{name:'영업이익',current:10,previous:-10,yearAgo:0},
    {name:'당기순이익',current:null,previous:10,yearAgo:10}]});
  assert.match(message.text,/&lt;회사 &amp; 이름&gt;/);assert.match(message.text,/100억원/);assert.match(message.text,/전기\(직전 기간\) 대비: \+25.0%/);
  assert.match(message.text,/흑자전환/);assert.match(message.text,/비교 기준 수치 0 · 증감률 계산 불가/);assert.doesNotMatch(message.text,/당기순이익/);
  assert.equal(message.allow_paid_broadcast,false);assert.equal(message.link_preview_options.is_disabled,true);
  assert.ok(message.text.length<4096);assert.match(message.reply_markup.inline_keyboard[0][1].url,/rcept=20261106000001/);
  assert.doesNotMatch(message.reply_markup.inline_keyboard[0][1].url,/auto|analysis/);
  assert.equal(change(-10,-20),'적자축소');assert.equal(change(-30,-20),'적자확대');assert.equal(change(-10,10),'적자전환');
  assert.equal(change(0,0),'변동 없음');assert.equal(change(null,10),'');
});
test('year-over-year leads in bold; opposite sequential changes are separate references with source periods',()=>{
  const message=formatTelegramDisclosure(event(1),{unit:'억원',labels:{current:'26.3Q',yearAgo:'25.3Q',previous:'26.2Q'},
    metrics:[{name:'매출액',current:100,yearAgo:50,previous:125}]});
  const yoy='<b>전년동기 대비 (25.3Q): +100.0%</b>';
  const prior='참고 · 전기(직전 기간) 대비 (26.2Q): -20.0%';
  assert.ok(message.text.includes(yoy));assert.ok(message.text.includes(prior));
  assert.ok(message.text.indexOf(yoy)<message.text.indexOf(prior));
  assert.doesNotMatch(message.text,/<b>[^<]*참고/);
  assert.match(message.text,/<\/b>\n  참고/);
});

test('missing or zero year-ago figures never turn sequential performance into the primary comparison',()=>{
  const message=formatTelegramDisclosure(event(1),{unit:'억원',labels:{previous:'<직전 & 기간>'},metrics:[
    {name:'매출액',current:100,yearAgo:null,previous:80},
    {name:'영업이익',current:10,yearAgo:0,previous:-10},
    {name:'당기순이익',current:-10,yearAgo:-20,previous:null}]});
  assert.match(message.text,/<b>전년동기 대비: 비교 수치 확인 불가<\/b>/);
  assert.match(message.text,/참고 · 전기\(직전 기간\) 대비 \(&lt;직전 &amp; 기간&gt;\): \+25.0%/);
  assert.match(message.text,/<b>전년동기 대비: 비교 기준 수치 0 · 증감률 계산 불가<\/b>/);
  assert.match(message.text,/<b>전년동기 대비: 적자축소<\/b>/);
  assert.equal((message.text.match(/참고 · 전기/g)||[]).length,2);
  assert.doesNotMatch(message.text,/직전분기|Infinity|NaN/);
});

test('provisional enrichment failure still sends the verified title and source link',async t=>{
  const f=await fixture(t);await f.capture([]);f.advance(1000);await f.capture([{...event(1),report_nm:'영업(잠정)실적(공정공시)'}]);
  assert.equal((await f.broadcast.deliver()).sent,1);assert.match(f.calls[0].payload.text,/잠정실적/);assert.doesNotMatch(f.calls[0].payload.text,/매출액/);
});
test('API failures never expose token-bearing request URLs or provider bodies',async()=>{
  const offline=createTelegramApi({token:config.token,fetchImpl:async()=>{throw Error('https://api.telegram.org/bot'+config.token);}});
  await assert.rejects(offline('sendMessage',{}),error=>error.uncertain&&!error.message.includes(config.token));
  const limited=createTelegramApi({token:config.token,fetchImpl:async()=>({ok:false,status:429,json:async()=>({ok:false,error_code:429,description:config.token,parameters:{retry_after:30}})})});
  await assert.rejects(limited('sendMessage',{}),error=>error.retryAfter===30&&!error.message.includes(config.token));
  const malformed=createTelegramApi({token:config.token,fetchImpl:async()=>({ok:true,json:async()=>({ok:true,result:{}})})});
  await assert.rejects(malformed('sendMessage',{}),error=>error.uncertain);
});
test('shared job collects watched and featured companies once; private-only favorites stay outside Telegram',async t=>{
  const f=await fixture(t);await f.store.ensureUser('private-user');await f.store.addFavorite('private-user',OTHER);await f.store.setEmail('private-user','encrypted');
  let observed;const job=createNotificationJob({store:f.store,now:f.now,broadcast:f.broadcast,senders:{email:async()=>{}},collect:async companies=>{observed=companies;return [event(1),event(2,OTHER)];}});
  const result=await job();assert.equal(result.telegram.sent,0);assert.equal(new Set(observed.map(c=>c.corp_code)).size,3);
  assert.equal((await f.store.query('SELECT * FROM app_telegram_deliveries')).length,1);
  assert.doesNotMatch(JSON.stringify(await f.store.query('SELECT * FROM app_telegram_deliveries')),/private-user|encrypted/);
});
