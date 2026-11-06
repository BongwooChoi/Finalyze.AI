const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');

const COMPANY={corp_code:'00126380',corp_name:'삼성전자',stock_code:'005930',modify_date:'20261106'};
function fixture(search='', company=COMPANY) {
  const nodes=new Map(),requests=[];
  function node() { return {style:{},innerHTML:'',textContent:'',children:[],classList:{add(){},remove(){},toggle(){}},
    appendChild(child){this.children.push(child);},append(){},replaceChildren(){},addEventListener(){},scrollIntoView(){},querySelectorAll(){return [];},querySelector(){return null;}}; }
  const document={body:node(),addEventListener(){},querySelectorAll(){return [];},querySelector(){return node();},createElement:node,
    getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);}};
  const context=vm.createContext({document,window:{location:{search},FinalyzeAccount:{setCompany(){}}},URLSearchParams,AbortController,
    setTimeout(){},console:{log(){},warn(){},error(){}},fetch:async url=>{
      requests.push(url);
      const data=url.startsWith('/api/disclosure-list') ? {status:'000',list:[]} : {status:company?'success':'error',data:company};
      return {ok:Boolean(company),json:async()=>data};
    }});
  vm.runInContext(fs.readFileSync(require.resolve('../public/js/main.js'),'utf8'),context);
  return {run:code=>vm.runInContext(code,context),nodes,requests};
}

test('URL restoration rejects malformed and encoded corp codes before rendering or fetching',async()=>{
  for(const corp of ['<img src=x onerror=alert(1)>','00126380&x=1','%3Csvg/onload=alert(1)%3E','１２３４５６７８']) {
    const f=fixture('?'+new URLSearchParams({corp}));await f.run('restoreStateFromUrl()');
    assert.equal(f.run('selectedCompany'),null);
    assert.equal(f.requests.length,0);
    assert.equal(f.nodes.get('companyInfo').innerHTML,'');
  }
});
test('deep links resolve the authoritative company even with a missing or hostile name and never start AI',async()=>{
  for(const name of ['', '<img src=x onerror=alert(1)>','&lt;svg/onload=alert(1)&gt;']) {
    const f=fixture('?'+new URLSearchParams({corp:COMPANY.corp_code,name}));await f.run('restoreStateFromUrl()');
    assert.equal(f.run('selectedCompany.corp_name'),'삼성전자');
    assert.equal(f.requests[0],'/api/companies/corp/00126380');
    assert.match(f.nodes.get('companyInfo').innerHTML,/삼성전자/);
    assert.doesNotMatch(f.nodes.get('companyInfo').innerHTML,/<img|<svg/);
    assert.ok(f.requests.every(url=>!url.includes('analysis')));
  }
});
test('unknown companies do not fall back to URL-supplied company information',async()=>{
  const f=fixture('?corp=99999999&name=Fake',null);await f.run('restoreStateFromUrl()');
  assert.equal(f.run('selectedCompany'),null);assert.equal(f.nodes.get('companyInfo').innerHTML,'');
});
test('company copies and loading/success/failure guides escape HTML and attribute-breaking strings',async()=>{
  for(const text of ['<img src=x onerror=alert(1)>','\"><svg/onload=alert(1)>','&lt;img&gt;']) {
    const company={...COMPANY,corp_name:text,corp_eng_name:text,modify_date:text};
    const f=fixture();await f.run(`selectCompany(${JSON.stringify(company)},{skipHistory:true})`);
    assert.doesNotMatch(f.nodes.get('companyInfo').innerHTML,/<img|<svg/);
    assert.ok(f.nodes.get('companyInfo').innerHTML.includes(f.run(`escapeHtml(${JSON.stringify(text)})`)));
    f.run(`displaySearchResults([${JSON.stringify(company)}])`);
    const html=f.nodes.get('searchResults').children.at(-1).children[0].innerHTML;
    assert.doesNotMatch(html,/<img|<svg/);
    for(const fn of ['showAnalysisGuide','updateAnalysisGuide','failAnalysisGuide']) {
      f.run(`${fn}(${JSON.stringify(text)})`);
      assert.doesNotMatch(f.nodes.get('analysisGuide').innerHTML,/<img|<svg/);
      assert.ok(f.nodes.get('analysisGuide').innerHTML.includes(f.run(`escapeHtml(${JSON.stringify(text)})`)));
    }
  }
});
