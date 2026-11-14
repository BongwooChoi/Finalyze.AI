const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
function fixture() {
  const nodes=new Map(),timers=new Map();let id=0,response;
  function element(){const classes=new Set();return {textContent:'',hidden:false,disabled:false,children:[],attrs:{},
    get childElementCount(){return this.children.length;},
    classList:{add:v=>classes.add(v),remove:v=>classes.delete(v),toggle:(v,on)=>on?classes.add(v):classes.delete(v),contains:v=>classes.has(v)},
    append(...children){this.children.push(...children);},replaceChildren(fragment){this.children=fragment.children;},
    setAttribute(k,v){this.attrs[k]=v;},addEventListener(){},querySelector(){return {textContent:''};}};}
  const document={hidden:false,getElementById(id){if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);},
    createElement:element,createDocumentFragment:element};
  const context=vm.createContext({document,location:{search:''},URLSearchParams,Intl,Date,AbortSignal,
    setTimeout(fn,delay){timers.set(++id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),
    fetch:async()=>{if(response instanceof Error)throw response;return {ok:true,json:async()=>response};},
    activePage:'analysis',selectedCompany:null,openRecentDisclosure(){}});
  const source=fs.readFileSync(require.resolve('../public/js/main.js'),'utf8');
  vm.runInContext(source.slice(source.indexOf('let recentDisclosuresLoading'),source.indexOf('async function openRecentDisclosure')),context);
  const result=(refreshing=false)=>({status:'success',data:[{corp_code:'00126380',corp_name:'삼성전자',rcept_no:'20261113000001',rcept_dt:'20261113',type:'3분기보고서',report_nm:'분기보고서'}],updatedAt:new Date().toISOString(),lookbackDays:30,stale:refreshing,refreshing});
  return {nodes,timers,result,context,document,setResponse:r=>{response=r;},load:()=>vm.runInContext('loadRecentDisclosures(true)',context),
    async tick(){const [key,timer]=timers.entries().next().value;timers.delete(key);await timer.fn();}};
}
test('저장 목록은 클릭 가능하게 표시하고 자동 확인 후 최신 목록으로 전환한다',async()=>{
  const f=fixture();f.setResponse(f.result(true));await f.load();
  assert.equal(f.nodes.get('recentDisclosuresList').childElementCount,1);
  assert.equal(f.nodes.get('recentDisclosuresList').attrs['aria-busy'],'false');
  assert.match(f.nodes.get('recentDisclosuresStatus').textContent,/최신 공시를 확인 중/);
  assert.ok(f.nodes.get('recentDisclosuresStatus').classList.contains('is-loading'));
  assert.equal(f.timers.size,1);assert.equal([...f.timers.values()][0].delay,3000);
  f.setResponse(f.result(false));await f.tick();
  assert.equal(f.timers.size,0);assert.ok(!f.nodes.get('recentDisclosuresStatus').classList.contains('is-loading'));
  assert.match(f.nodes.get('recentDisclosuresStatus').textContent,/^마지막 확인/);
});
test('실패·페이지 이탈·반복 상한은 자동 확인을 중지하고 기존 목록을 보존한다',async()=>{
  const f=fixture();f.setResponse(f.result(true));await f.load();f.setResponse(Error('network'));await f.tick();
  assert.equal(f.timers.size,0);assert.equal(f.nodes.get('recentDisclosuresList').childElementCount,1);
  assert.equal(f.nodes.get('recentDisclosuresRetry').hidden,false);
  f.setResponse(f.result(true));await f.load();f.document.hidden=true;await f.tick();assert.equal(f.timers.size,0);
  f.document.hidden=false;await f.load();
  for(let i=0;i<15;i++)await f.tick();
  assert.equal(f.timers.size,0);assert.equal(f.nodes.get('recentDisclosuresRetry').hidden,false);
  assert.match(f.nodes.get('recentDisclosuresStatus').textContent,/갱신이 지연/);
});
