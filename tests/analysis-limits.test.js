const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createMemoryStore,createRedisStore}=require('../sharedStore');
const {createAnalysisLimiter,OPENAI_DEADLINE_MS,analysisFailure}=require('../analysisLimits');
function fixture(env={}) {
  let time=Date.parse('2026-11-06T01:00:00Z');const now=()=>time,store=createMemoryStore({now});
  return {store,now,advance:ms=>{time+=ms;},run:createAnalysisLimiter({store,now,env})};
}
test('AI quota follows the member across instances and both analysis operations, resetting at KST midnight',async()=>{
  const f=fixture({AI_MEMBER_DAILY_LIMIT:'2'});let calls=0;
  const second=createAnalysisLimiter({store:f.store,now:f.now,env:{AI_MEMBER_DAILY_LIMIT:'2'}});
  await f.run('member',async()=>++calls);f.advance(10000);
  await second('member',async()=>++calls);f.advance(10000);
  await assert.rejects(f.run('member',async()=>++calls),{status:429});assert.equal(calls,2);
  f.advance(Date.parse('2026-11-06T15:00:00Z')-f.now());
  assert.equal(await second('member',async()=>++calls),3);
});
test('same-member and global concurrency are reserved atomically; rejected work never starts',async()=>{
  const f=fixture();const releases=[];let calls=0;
  const pending=Array.from({length:4},(_,i)=>f.run('user'+i,()=>{calls++;return new Promise(r=>releases.push(r));}));
  await new Promise(setImmediate);
  await assert.rejects(f.run('user0',()=>assert.fail('same member ran')),{status:429});
  await assert.rejects(f.run('fifth',()=>assert.fail('global concurrency ran')),{status:429});
  assert.equal(calls,4);releases.forEach(r=>r());await Promise.all(pending);
  await f.run('fifth',async()=>++calls);assert.equal(calls,5);
});
test('burst and global daily caps apply across users without charging rejected requests',async()=>{
  const f=fixture({AI_GLOBAL_DAILY_LIMIT:'2'});await f.run('a',async()=>{});
  await assert.rejects(f.run('a',()=>assert.fail('burst ran')),{status:429,retryAfter:10});
  await f.run('b',async()=>{});
  await assert.rejects(f.run('c',()=>assert.fail('global cap ran')),{status:429});
});
test('upstream failure releases concurrency but still consumes the attempt; disconnect cannot release it early',async()=>{
  const f=fixture({AI_MEMBER_DAILY_LIMIT:'2'});let finish;
  const pending=f.run('member',()=>new Promise(resolve=>{finish=resolve;}));await new Promise(setImmediate);
  f.advance(10000);await assert.rejects(f.run('member',()=>assert.fail('unfinished work bypassed')),{status:429});
  finish();await pending;
  await assert.rejects(f.run('member',async()=>{throw new Error('upstream');}),/upstream/);
  f.advance(10000);await assert.rejects(f.run('member',()=>assert.fail('failure refunded quota')),{status:429});
});
test('store failure is fail-closed, and lock leases outlive the complete upstream deadline',async()=>{
  let calls=0;
  const run=createAnalysisLimiter({store:{acquireAnalysis:async()=>{throw Error('private-secret');}},env:{}});
  await assert.rejects(run('member',async()=>calls++),error=>error.status===503 && !error.message.includes('private-secret'));
  assert.equal(calls,0);
  const f=fixture();let complete;const pending=f.run('member',()=>new Promise(r=>{complete=r;}));await new Promise(setImmediate);
  f.advance(OPENAI_DEADLINE_MS+1000);await assert.rejects(f.run('member',()=>assert.fail('lease too short')),{status:429});
  complete();await pending;
});
test('zero disables analysis and malformed limit settings fail closed',async()=>{
  const f=fixture({AI_GLOBAL_DAILY_LIMIT:'0'});await assert.rejects(f.run('member',()=>assert.fail('disabled')),{status:503,code:'AI_PAUSED'});
  for(const value of ['-1','NaN','Infinity','1.2']) assert.throws(()=>createAnalysisLimiter({env:{AI_MEMBER_DAILY_LIMIT:value}}));
});
test('quota reasons survive the HTTP response without an outage prefix',async()=>{
  for(const [result,code] of [[-1,'AI_MEMBER_DAILY_LIMIT'],[-2,'AI_GLOBAL_DAILY_LIMIT'],[-3,'AI_MEMBER_BUSY'],[-4,'AI_SERVICE_BUSY'],[-5,'AI_REQUEST_INTERVAL']]) {
    const run=createAnalysisLimiter({store:{acquireAnalysis:async()=>[result,10]},env:{}});
    await assert.rejects(run('member',()=>assert.fail('rejected operation ran')),error=>{
      const response=analysisFailure(error);assert.equal(error.code,code);assert.equal(response.status,429);
      assert.equal(response.body.code,code);assert.equal(response.body.retryAfter,10);assert.equal(response.retryAfter,10);
      assert.doesNotMatch(response.body.message,/오류|실패/);
      if(result===-1 || result===-2)assert.match(response.body.message,/한국 시간 자정\(00:00\)/);
      return true;
    });
  }
});
test('actual failures stay distinct from business notices and never expose provider details',()=>{
  for(const code of ['AI_LIMIT_UNAVAILABLE','UPSTREAM_RATE_LIMIT',undefined]){
    const response=analysisFailure(Object.assign(new Error('private-provider-details'),{status:429,code}));
    assert.equal(response.status,code==='AI_LIMIT_UNAVAILABLE'?503:500);
    assert.equal(response.body.code,code==='AI_LIMIT_UNAVAILABLE'?code:'AI_UNAVAILABLE');
    assert.doesNotMatch(response.body.message,/private-provider-details/);assert.equal(response.retryAfter,undefined);
  }
  const pause=analysisFailure({code:'AI_PAUSED',message:'AI 분석 제공을 잠시 중지했습니다.'});
  assert.equal(pause.status,503);assert.equal(pause.body.code,'AI_PAUSED');
});

// Opt-in real Redis transport; the test CLI targets only an isolated loopback container.
test('Redis Lua enforces concurrent reservations across separate store clients', {skip:!process.env.TEST_REDIS_CONTAINER},async()=>{
  const {execFile}=require('node:child_process');const {promisify}=require('node:util');const exec=promisify(execFile);
  const fetchImpl=async(_url,options)=>{
    const args=JSON.parse(options.body).map(String);
    const {stdout}=await exec('docker',['exec',process.env.TEST_REDIS_CONTAINER,'redis-cli','--json',...args],{maxBuffer:1024*1024});
    return {ok:true,json:async()=>({result:JSON.parse(stdout)})};
  };
  const make=()=>createRedisStore({url:'http://isolated-redis',token:'test-only',fetchImpl});
  const time=Date.now(),user='test-'+time,day='test-'+time;
  const limits={memberDaily:2,globalDaily:3,globalConcurrent:2,intervalMs:10000,leaseMs:180000,retrySeconds:3600};
  const results=await Promise.all(Array.from({length:8},(_,i)=>make().acquireAnalysis(user,day,'token'+i,time,limits)));
  assert.equal(results.filter(r=>r[0]===1).length,1);
  const winner=results.findIndex(r=>r[0]===1);
  await make().releaseAnalysis(user,'not-the-owner');
  assert.equal((await make().acquireAnalysis(user,day,'blocked',time+11000,limits))[0],-3);
  await make().releaseAnalysis(user,'token'+winner);
  assert.equal((await make().acquireAnalysis(user,day,'second',time+11000,limits))[0],1);
  await make().releaseAnalysis(user,'second');
  assert.equal((await make().acquireAnalysis(user,day,'third',time+22000,limits))[0],-1);
});
