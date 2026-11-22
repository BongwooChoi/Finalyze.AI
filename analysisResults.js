const {randomUUID, createHash} = require('node:crypto');
const {sign, equal} = require('./accountSecurity');

// Bind the report identity and every input to data issued by the public DART route.
// Older clients without this proof can still analyze, but cannot publish shared results.
function financialIdentity(source, data) {
  const {companyName,year,previousYear,isFinancialCompany,balanceSheet,incomeStatement,ratio} = data;
  return createHash('sha256').update(JSON.stringify([
    source,companyName,year,previousYear,isFinancialCompany,balanceSheet,incomeStatement,ratio
  ])).digest('hex');
}
function issueFinancialProof(source, data, secret) {
  const id = financialIdentity(source,data);
  return {source, signature:sign('financial-report:'+id,secret)};
}
function verifiedFinancialId(proof, data, secret) {
  if (!proof || typeof proof.source !== 'string' || !secret) return null;
  const id = financialIdentity(proof.source,data);
  return equal(proof.signature,sign('financial-report:'+id,secret)) ? id : null;
}

async function reuseAnalysis(store, key, generate) {
  const read = async () => (await store.query(
    'SELECT result_json FROM app_analysis_results WHERE report_key=$1',[key]))[0];
  const cached = row => ({payload:JSON.parse(row.result_json),cached:true});
  const existing = await read();
  if (existing?.result_json) return cached(existing);

  const token = randomUUID(), time = Date.now();
  const claim = await store.query(`INSERT INTO app_analysis_results(report_key,owner,lease_until)
    VALUES($1,$2,$3) ON CONFLICT(report_key) DO UPDATE SET owner=excluded.owner,lease_until=excluded.lease_until
    WHERE app_analysis_results.result_json IS NULL AND app_analysis_results.lease_until<=$4 RETURNING owner`,
    [key,token,time+240000,time]);
  if (!claim.length) {
    const row = await read();
    if (row?.result_json) return cached(row);
    throw Object.assign(new Error('같은 공시의 분석을 작성 중입니다. 잠시 후 다시 누르면 저장된 결과를 확인할 수 있습니다.'),{code:'AI_REPORT_BUSY',retryAfter:5});
  }
  try {
    const payload = await generate();
    const saved = await store.query(`UPDATE app_analysis_results SET result_json=$3,owner='',lease_until=0
      WHERE report_key=$1 AND owner=$2 RETURNING report_key`,[key,token,JSON.stringify(payload)]);
    if (!saved.length) throw new Error('AI_RESULT_LEASE_LOST');
    return {payload,cached:false};
  } catch (error) {
    await store.query('DELETE FROM app_analysis_results WHERE report_key=$1 AND owner=$2 AND result_json IS NULL',[key,token]);
    throw error;
  }
}
module.exports={reuseAnalysis,issueFinancialProof,verifiedFinancialId};
