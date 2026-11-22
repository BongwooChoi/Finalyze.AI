const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createAccountStore,sqliteDatabase} = require('../accountStore');
const {reuseAnalysis,issueFinancialProof,verifiedFinancialId} = require('../analysisResults');

test('two requests share one generation, completed reads survive restart, failures can retry', async t => {
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'finalyze-result-'));
  const file = require('node:path').join(dir,'accounts.sqlite');
  const a = createAccountStore(sqliteDatabase(file));
  const b = createAccountStore(sqliteDatabase(file));
  t.after(async () => {await a.close(); await b.close(); require('node:fs').rmSync(dir,{recursive:true,force:true});});
  await a.initialize(); await b.initialize();
  let started,finish,calls=0;
  const began = new Promise(resolve=>{started=resolve;});
  const result = {summary:'first analysis'};
  const first = reuseAnalysis(a,'report-A',async()=>{
    calls++;started();await new Promise(resolve=>{finish=resolve;});return result;
  });
  await began;
  await assert.rejects(reuseAnalysis(b,'report-A',()=>++calls),{code:'AI_REPORT_BUSY'});
  finish();assert.deepEqual(await first,{cached:false,payload:result});
  const reopened=createAccountStore(sqliteDatabase(file));
  try { assert.deepEqual(await reuseAnalysis(reopened,'report-A',()=>++calls),{cached:true,payload:result}); }
  finally { await reopened.close(); }
  assert.equal(calls,1);
  await assert.rejects(reuseAnalysis(b,'report-B',async()=>{throw Error('upstream unavailable');}));
  assert.equal((await reuseAnalysis(a,'report-B',async()=>result)).cached,false);
});

test('financial proof binds official values, company, reporting period and DART receipts',()=>{
  const data={companyName:'기업',year:'2026',previousYear:'2025',isFinancialCompany:false,
    balanceSheet:{assets:{current:100}},incomeStatement:{},ratio:{}};
  const secret='fixture-only',source='corp : 2026 : 11012 : receipt';
  const proof=issueFinancialProof(source,data,secret);
  const key=verifiedFinancialId(proof,JSON.parse(JSON.stringify(data)),secret);
  assert.ok(key);
  for(const patch of [{year:'2025'},{companyName:'다른 기업'},{balanceSheet:{assets:{current:200}}}])
    assert.equal(verifiedFinancialId(proof,{...data,...patch},secret),null);
  const revised=issueFinancialProof(source+'-revision',data,secret);
  assert.notEqual(verifiedFinancialId(revised,data,secret),key);
  assert.equal(verifiedFinancialId({...proof,source:revised.source},data,secret),null);
});
