const test=require('node:test'),assert=require('node:assert/strict');
const {createTrafficService}=require('../trafficService');
test('traffic proxy uses a fixed upstream and validates ranges before requests',async()=>{
 const calls=[];const service=createTrafficService({env:{TRAFFIC_REPORT_SECRET:'x'.repeat(40)},fetcher:async(...args)=>{calls.push(args);return {ok:true,json:async()=>({days:7})};}});
 assert.deepEqual(await service.report(7),{days:7});assert.equal(calls[0][0],'https://bongwoo-projects.vercel.app/api/traffic?days=7');assert.equal(calls[0][1].method,'GET');
 await assert.rejects(service.report('7&path=secret'),{status:400});assert.equal(calls.length,1);
});
test('proxy does not expose upstream secrets and reports rate limiting clearly',async()=>{
 for(const [status,expected] of [[401,503],[500,503],[429,429]]){
  const service=createTrafficService({env:{TRAFFIC_REPORT_SECRET:'x'.repeat(40)},fetcher:async()=>({ok:false,status,json:async()=>({message:'private secret'})})});
  await assert.rejects(service.sync(),error=>error.status===expected&&!error.message.includes('private'));
 }
});
