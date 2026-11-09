const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');

function fixture(fetchImpl) {
  const nodes=new Map(),listeners=new Map(),requests=[];
  function node() {return {style:{},hidden:true,disabled:false,innerHTML:'',textContent:'',replaceChildren(){this.innerHTML='';},
    append(){},querySelector(){return node();},getContext(){return {};}};}
  const document={getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},createElement:node,
    addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(fn);}};
  let member=false;
  const context=vm.createContext({document,window:{location:{search:''},FinalyzeAccount:{analysisAccess:async()=>({authenticated:member,csrfToken:'session-csrf'})}},
    AbortController,URLSearchParams,Chart:class {destroy(){}},setTimeout:()=>{},console:{log(){},warn(){},error(){}},
    fetch:async(url,options)=>{requests.push({url,options});return fetchImpl ? fetchImpl(url,options) : response();}});
  vm.runInContext(fs.readFileSync(require.resolve('../public/js/main.js'),'utf8'),context);
  const run=source=>vm.runInContext(source,context);
  const change=value=>{member=value;for(const fn of listeners.get('account:changed')||[])fn({detail:{authenticated:value}});};
  function choose(kind='financial',name='선택한 기업') {
    const data={kind,status:'idle',financialData:{companyName:name,year:'2025',balanceSheet:{},incomeStatement:{}},
      receipt:'20261106000001',companyName:name,reportName:'영업(잠정)실적'};
    run(`activeAiAnalysis=${JSON.stringify(data)}`);
  }
  return{document,requests,run,change,choose,click:async event=>{for(const fn of listeners.get('click')||[])await fn(event);}};
}
function response(status=200,summary='확인된 분석') {return{status,ok:status===200,json:async()=>({status:status===200?'success':'error',
  result:{sections:[],rating:'mixed',summary},chartData:null})};}

test('guest previews for both report types never request an AI endpoint',async()=>{
  for(const kind of ['financial','provisional']) {
    const f=fixture();f.choose(kind);await f.run('requestAiAnalysis(activeAiAnalysis)');
    assert.equal(f.requests.length,0);
    const gate=f.document.getElementById(kind==='financial'?'aiAnalysisAccess':'provisionalAccess');
    assert.equal(gate.hidden,false);assert.match(gate.innerHTML,/Google로 로그인하고 AI 분석 보기/);
  }
});
test('login preserves the report and waits for an explicit AI start',async()=>{
  const f=fixture();f.choose();await f.run('requestAiAnalysis(activeAiAnalysis)');
  f.change(true);
  assert.equal(f.requests.length,0);
  assert.match(f.document.getElementById('aiAnalysisAccess').innerHTML,/AI 분석 시작하기/);
  await f.run('requestAiAnalysis(activeAiAnalysis)');
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].options.headers['X-CSRF-Token'],'session-csrf');
  assert.equal(JSON.parse(f.requests[0].options.body).companyName,'선택한 기업');
  assert.match(f.document.getElementById('aiAnalysisContent').innerHTML,/확인된 분석/);
});
test('member provisional requests also carry CSRF, and expired sessions return to the login gate',async()=>{
  const f=fixture(()=>response(401));f.change(true);f.choose('provisional');
  await f.run('requestAiAnalysis(activeAiAnalysis)');
  assert.equal(f.requests[0].options.method,'GET');assert.equal(f.requests[0].options.headers['X-CSRF-Token'],'session-csrf');
  assert.match(f.requests[0].url,/rcept_no=20261106000001/);
  assert.match(f.document.getElementById('provisionalAccess').innerHTML,/Google로 로그인/);
  assert.equal(f.document.getElementById('provisionalContent').innerHTML,'');
});
test('a late AI response cannot reveal content after logout',async()=>{
  let deliver,started;
  const ready=new Promise(resolve=>{started=resolve;});
  const f=fixture(()=>{started();return new Promise(resolve=>{deliver=resolve;});});
  f.change(true);f.choose();const pending=f.run('requestAiAnalysis(activeAiAnalysis)');await ready;
  f.change(false);deliver(response());await pending;
  assert.equal(f.document.getElementById('aiAnalysisContent').innerHTML,'');
  assert.equal(f.document.getElementById('aiAnalysisAccess').hidden,false);
});

test('a quota response shows the server guidance and allows a later explicit retry',async()=>{
  let calls=0;const f=fixture(()=>++calls===1 ? {status:429,ok:false,json:async()=>({status:'error',code:'AI_MEMBER_DAILY_LIMIT',message:'오늘 AI 분석 한도에 도달했습니다. 한국 시간 자정 이후 이용해주세요.'})} : response());
  f.change(true);f.choose();await f.run('requestAiAnalysis(activeAiAnalysis)');
  assert.equal(f.document.getElementById('aiAnalysisError').style.display,'none');
  assert.match(f.document.getElementById('aiAnalysisNotice').innerHTML,/자정/);
  assert.equal(f.run('activeAiAnalysis.status'),'limited');assert.equal(f.requests.length,1);
  await f.run('requestAiAnalysis(activeAiAnalysis)');
  assert.equal(f.requests.length,2);assert.equal(f.run('activeAiAnalysis.status'),'complete');
  assert.equal(f.document.getElementById('aiAnalysisNotice').hidden,true);
});

test('daily caps and planned pauses are notices for both report types, preserving charts and hiding failure guides',async()=>{
  for(const kind of ['financial','provisional']) for(const code of ['AI_MEMBER_DAILY_LIMIT','AI_GLOBAL_DAILY_LIMIT','AI_PAUSED']) {
    const f=fixture(()=>({status:code==='AI_PAUSED'?503:429,ok:false,json:async()=>({status:'error',code,message:'이용 안내 <img src=x onerror=alert(1)>'})}));
    f.change(true);f.choose(kind);f.document.getElementById('provisionalChartWrap').style.display='block';
    f.document.getElementById('chartRow').style.display='flex';await f.run('requestAiAnalysis(activeAiAnalysis)');
    const notice=f.document.getElementById(kind==='financial'?'aiAnalysisNotice':'provisionalNotice');
    assert.equal(notice.hidden,false);assert.equal(notice.className,'ai-notice');
    assert.match(notice.innerHTML,/재무제표와 차트는 계속/);assert.doesNotMatch(notice.innerHTML,/<img|분석에 실패|data-ai-action/);
    assert.equal(f.document.getElementById(kind==='financial'?'aiAnalysisError':'provisionalError').style.display,'none');
    assert.equal(f.document.getElementById('provisionalChartWrap').style.display,'block');
    assert.equal(f.document.getElementById('chartRow').style.display,'flex');
    assert.equal(f.document.getElementById('analysisGuide').style.display,'none');
    assert.equal(f.requests.length,1);f.change(false);assert.equal(notice.hidden,true);
  }
});
test('busy and interval notices offer an explicit retry without retrying automatically',async()=>{
  for(const code of ['AI_MEMBER_BUSY','AI_SERVICE_BUSY','AI_REQUEST_INTERVAL']) {
    const f=fixture(()=>({status:429,ok:false,json:async()=>({status:'error',code,message:'잠시 후 다시 요청해주세요.'})}));
    f.change(true);f.choose();await f.run('requestAiAnalysis(activeAiAnalysis)');
    const notice=f.document.getElementById('aiAnalysisNotice');assert.equal(notice.hidden,false);
    assert.match(notice.className,/ai-notice-wait/);assert.match(notice.innerHTML,/data-ai-action="analyze"/);
    assert.equal(f.run('activeAiAnalysis.status'),'waiting');assert.equal(f.requests.length,1);
  }
});
test('actual outages and unknown 429 errors retain the error presentation',async()=>{
  for(const kind of ['financial','provisional']) for(const [status,code] of [[500,'AI_UNAVAILABLE'],[503,'AI_LIMIT_UNAVAILABLE'],[429,'UPSTREAM_RATE_LIMIT'],[429,'__proto__']]) {
    const f=fixture(()=>({status,ok:false,json:async()=>({status:'error',code,message:'AI 분석을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.'})}));
    f.change(true);f.choose(kind);await f.run('requestAiAnalysis(activeAiAnalysis)');
    assert.equal(f.document.getElementById(kind==='financial'?'aiAnalysisNotice':'provisionalNotice').hidden,true);
    assert.equal(f.document.getElementById(kind==='financial'?'aiAnalysisError':'provisionalError').style.display,'block');
    assert.match(f.document.getElementById(kind==='financial'?'aiAnalysisError':'provisionalError').textContent,/불러오지 못했습니다/);
    if(kind==='provisional')assert.match(f.document.getElementById('analysisGuide').innerHTML,/analysis-guide-error/);
    assert.equal(f.run('activeAiAnalysis.status'),'error');
  }
});
test('changing the selected company discards the previous in-flight AI result',async()=>{
  let deliver,started;
  const ready=new Promise(resolve=>{started=resolve;});
  const f=fixture(()=>{started();return new Promise(resolve=>{deliver=resolve;});});
  f.change(true);f.choose();const pending=f.run('requestAiAnalysis(activeAiAnalysis)');await ready;
  f.run('resetAiAnalysis()');deliver(response());await pending;
  assert.equal(f.document.getElementById('aiAnalysisContent').innerHTML,'');
  assert.equal(f.document.getElementById('aiAnalysisAccess').hidden,true);
});

test('public provisional charts load for guests and survive login gates and logout',async()=>{
  const f=fixture(()=>({ok:true,json:async()=>({status:'success',chartData:{unit:'조원',labels:{},metrics:[{name:'매출액',current:195.25,previous:171.5,yearAgo:86.06}]}})}));
  f.choose('provisional');
  await f.run('Promise.all([loadProvisionalFinancials(activeAiAnalysis),requestAiAnalysis(activeAiAnalysis)])');
  assert.equal(f.requests.length,1);assert.match(f.requests[0].url,/^\/api\/provisional-financials\?/);
  assert.equal(f.document.getElementById('provisionalChartWrap').style.display,'block');
  assert.equal(f.document.getElementById('provisionalAccess').hidden,false);
  assert.equal(f.document.getElementById('provisionalPdfBtn').disabled,false);
  f.change(true);f.change(false);
  assert.equal(f.document.getElementById('provisionalChartWrap').style.display,'block');
  assert.equal(f.requests.length,1);
});
test('an unsupported provisional table shows source guidance without an AI fallback',async()=>{
  const f=fixture(()=>({ok:true,json:async()=>({status:'success',chartData:null,message:'원문 확인'})}));f.choose('provisional');
  await f.run('loadProvisionalFinancials(activeAiAnalysis)');
  assert.equal(f.document.getElementById('provisionalDataNotice').textContent,'원문 확인');
  assert.equal(f.requests.length,1);assert.match(f.requests[0].url,/provisional-financials/);
});

test('pending documents show guidance for guests and member AI without an automatic retry',async()=>{
  const pending=()=>({ok:false,status:503,json:async()=>({status:'pending',code:'DART_DOCUMENT_NOT_READY'})});
  const f=fixture(pending);f.choose('provisional');await f.run('loadProvisionalFinancials(activeAiAnalysis)');
  const notice=f.document.getElementById('provisionalDataNotice');assert.match(notice.innerHTML,/공시 원문 준비 중/);assert.match(notice.innerHTML,/익영업일/);assert.match(notice.innerHTML,/data-document-retry/);assert.equal(f.requests.length,1);
  f.change(true);await f.run('requestAiAnalysis(activeAiAnalysis)');
  const ai=f.document.getElementById('provisionalNotice');assert.equal(ai.hidden,false);assert.equal(ai.style.display,'');assert.match(ai.innerHTML,/공시 원문 준비 중/);
  assert.equal(f.document.getElementById('provisionalError').style.display,'none');assert.equal(f.run('activeAiAnalysis.status'),'document_waiting');assert.equal(f.requests.length,2);
  f.change(false);assert.equal(ai.hidden,true);
});

test('checking a ready document fetches public figures only and requires a separate AI start',async()=>{
  let first=true;const f=fixture(()=>first ? (first=false,{ok:false,status:503,json:async()=>({status:'pending',code:'DART_DOCUMENT_NOT_READY'})}) : {ok:true,json:async()=>({status:'success',chartData:null})});
  f.change(true);f.choose('provisional');await f.run('requestAiAnalysis(activeAiAnalysis)');
  const notice=f.document.getElementById('provisionalNotice');
  const button={disabled:false,setAttribute(){},removeAttribute(){},closest(){return notice;}};
  await f.click({target:{closest:selector=>selector==='[data-document-retry]'?button:null}});
  assert.equal(f.requests.length,2);assert.match(f.requests[1].url,/provisional-financials/);assert.equal(f.run('activeAiAnalysis.status'),'ready');
  assert.equal(notice.hidden,true);assert.match(f.document.getElementById('provisionalAccess').innerHTML,/AI 분석 시작하기/);assert.equal(button.disabled,false);
});
