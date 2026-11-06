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
  return{document,requests,run,change,choose};
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
