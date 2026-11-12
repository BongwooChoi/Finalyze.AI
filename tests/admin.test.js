const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomBytes,randomUUID}=require('node:crypto');
const express=require('express');
const {accountConfig,createAccountRouter}=require('../accountRoutes');
const {createAccountStore,sqliteDatabase}=require('../accountStore');
const {createAdminRouter}=require('../adminRoutes');
const {defaultSettings,createSettingsService}=require('../serviceSettings');
const {createMemoryStore}=require('../sharedStore');
const {createAnalysisLimiter}=require('../analysisLimits');
const OWNER='owner@example.com';
async function fixture(t){
  let time=Date.parse('2026-11-06T01:00:00Z');const now=()=>time;
  const store=createAccountStore(sqliteDatabase(),now),shared=createMemoryStore({now});
  const settings=createSettingsService({store,now,env:{}});
  const config=accountConfig({APP_ORIGIN:'http://localhost:3000',GOOGLE_CLIENT_ID:'test-client',SESSION_SECRET:'s'.repeat(40),USER_ID_SECRET:'i'.repeat(40),USER_DATA_KEY:randomBytes(32).toString('base64'),ADMIN_EMAILS:OWNER});
  const identities=new Map();
  const accounts=createAccountRouter({store,config,now,securityStore:shared,getSettings:settings.values,
    findCompany:async corp=>({corp_code:corp,corp_name:'테스트',stock_code:'005930'}),verifyIdentity:async credential=>{
      if(!identities.has(credential))throw Error('invalid');return identities.get(credential);
    }});
  const trafficCalls=[];
  const traffic={report:async days=>{trafficCalls.push('read');return {days:Number(days),projects:[],daily:[],clicks:[]};},sync:async()=>{trafficCalls.push('sync');return {status:'ok',success:5};}};
  const app=express();app.use(express.json());app.use('/api',accounts.router);app.use('/api/admin',createAdminRouter({accounts,settings,sharedStore:shared,traffic,now}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await store.close();});
  function client(){
    const jar={};let csrf;
    async function request(path,method='GET',body,headers={}){
      const response=await fetch(`http://127.0.0.1:${server.address().port}/api`+path,{method,headers:{Origin:config.origin,'Content-Type':'application/json',Cookie:Object.entries(jar).map(([k,v])=>k+'='+v).join('; '),...(csrf?{'X-CSRF-Token':csrf}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
      for(const cookie of response.headers.getSetCookie()){const [key,value]=cookie.split(';')[0].split('=');jar[key]=value;}
      return response;
    }
    async function status(){const response=await request('/account');const data=await response.json();csrf=data.csrfToken;return data;}
    async function login(sub,email=OWNER,verified=true,extra={}){
      const challenge=await(await request('/auth/challenge','POST',{})).json(),credential=randomUUID();
      identities.set(credential,{sub,email,email_verified:verified,nonce:challenge.nonce});
      const response=await request('/auth/google','POST',{credential,...extra});await status();return response;
    }
    return{request,status,login,jar};
  }
  return{store,shared,settings,config,client,now,trafficCalls,advance:ms=>time+=ms};
}
test('only the verified configured Google account can read or change admin data',async t=>{
  const f=await fixture(t),guest=f.client(),member=f.client(),owner=f.client();
  assert.equal((await guest.request('/admin/dashboard')).status,401);
  await member.login('member','member@example.com');
  assert.equal((await member.status()).admin,false);
  assert.equal((await member.request('/admin/dashboard')).status,403);
  assert.equal((await member.request('/admin/settings','PUT',{version:0,values:defaultSettings({})})).status,403);
  await owner.login('owner',OWNER);assert.equal((await owner.status()).admin,true);
  const response=await owner.request('/admin/dashboard');assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  const dashboard=await response.json();assert.equal(dashboard.stats.members,2);
  assert.equal(dashboard.stats.new_members,2);assert.equal(dashboard.stats.signed_in_members,2);
  assert.doesNotMatch(JSON.stringify(dashboard),/owner@example|member@example|csrfToken|email_enc|email_hash/);
});
test('unified traffic read and sync use the existing admin, session, CSRF and origin boundary',async t=>{
  const f=await fixture(t),guest=f.client(),member=f.client(),owner=f.client();
  assert.equal((await guest.request('/admin/traffic')).status,401);
  await member.login('ordinary','member@example.com');
  assert.equal((await member.request('/admin/traffic')).status,403);
  assert.equal((await member.request('/admin/traffic/sync','POST',{})).status,403);
  await owner.login('owner');
  assert.equal((await owner.request('/admin/traffic','GET',undefined,{'X-CSRF-Token':''})).status,403);
  assert.equal((await owner.request('/admin/traffic/sync','POST',{},{Origin:'https://evil.example'})).status,403);
  assert.equal(f.trafficCalls.length,0);
  const read=await owner.request('/admin/traffic?days=7');assert.equal(read.status,200);assert.equal(read.headers.get('cache-control'),'no-store');assert.equal((await read.json()).days,7);
  assert.equal((await owner.request('/admin/traffic/sync','POST',{})).status,200);assert.deepEqual(f.trafficCalls,['read','sync']);
});
test('email claims must be verified and client flags or an empty allowlist never grant admin',async t=>{
  const f=await fixture(t),user=f.client();
  await user.login('unverified',OWNER,false,{admin:true,role:'admin',userId:'owner'});
  assert.equal((await user.status()).admin,false);
  await user.login('verified',OWNER.toUpperCase());assert.equal((await user.status()).admin,true);
  f.config.adminEmailHashes=[];
  assert.equal((await user.status()).admin,false);
  assert.equal((await user.request('/admin/dashboard')).status,403);
});
test('admin requests require CSRF and same-origin changes, and invalid values leave settings unchanged',async t=>{
  const f=await fixture(t),owner=f.client();await owner.login('owner');
  const values=defaultSettings({});
  assert.equal((await owner.request('/admin/dashboard','GET',undefined,{'X-CSRF-Token':''})).status,403);
  assert.equal((await owner.request('/admin/settings','PUT',{version:0,values},{Origin:'https://evil.example'})).status,403);
  for(const patch of [{memberDaily:-1},{maxSessions:0},{globalConcurrent:1.5},{aiEnabled:'true'},{isAdmin:true}]){
    const response=await owner.request('/admin/settings','PUT',{version:0,values:{...values,...patch}});assert.equal(response.status,400);
  }
  assert.equal((await f.settings.read()).version,0);assert.equal((await f.store.settingsHistory()).length,0);
});
test('settings persist, reject stale writes and record only the winning changes atomically',async t=>{
  const f=await fixture(t),owner=f.client();await owner.login('owner');
  const values={...defaultSettings({}),memberDaily:25,maxSessions:2,maxFavorites:3,maxPush:2};
  const results=await Promise.all([owner.request('/admin/settings','PUT',{version:0,values}),owner.request('/admin/settings','PUT',{version:0,values:{...values,memberDaily:30}})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const stored=await f.settings.read();assert.equal(stored.version,1);
  const otherInstance=createSettingsService({store:f.store,now:f.now,env:{}});assert.deepEqual(await otherInstance.read(),stored);
  const history=await f.store.settingsHistory();assert.equal(history.length,1);
  assert.equal(JSON.parse(history[0].value_json).memberDaily,stored.values.memberDaily);
  assert.equal(JSON.parse(history[0].before_json).memberDaily,10);
});
test('a failed audit write rolls back the settings change',async t=>{
  const f=await fixture(t),owner=f.client();await owner.login('owner');
  await f.store.query("CREATE TRIGGER reject_audit BEFORE INSERT ON app_settings_audit BEGIN SELECT RAISE(ABORT,'private database details'); END");
  const response=await owner.request('/admin/settings','PUT',{version:0,values:{...defaultSettings({}),memberDaily:30}});
  assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/private database details/);
  assert.equal((await f.settings.read()).version,0);assert.equal((await f.settings.read()).values.memberDaily,10);
});
test('saved AI settings take effect in the shared limiter without resetting usage',async t=>{
  const f=await fixture(t),run=createAnalysisLimiter({store:f.shared,now:f.now,env:{},getSettings:f.settings.values});
  let calls=0;await run('member',async()=>++calls);f.advance(10000);
  await f.settings.save({...defaultSettings({}),memberDaily:1},0,'admin');
  await assert.rejects(run('member',()=>++calls),{status:429});assert.equal(calls,1);
  await f.settings.save({...defaultSettings({}),memberDaily:3,aiEnabled:false},1,'admin');
  await assert.rejects(run('member',()=>++calls),{status:503,code:'AI_PAUSED'});assert.equal(calls,1);
  await f.settings.save({...defaultSettings({}),memberDaily:3},2,'admin');
  await run('member',async()=>++calls);assert.equal(calls,2);
  assert.deepEqual(await f.shared.analysisUsage('2026-11-06',f.now()),{used:2,active:0});
});
test('saved account limits apply to subsequent registrations and logins without deleting existing favorites',async t=>{
  const f=await fixture(t),owner=f.client();await owner.login('owner');
  await f.settings.save({...defaultSettings({}),maxSessions:1,maxFavorites:1},0,'admin');
  assert.equal((await owner.request('/account/favorites','POST',{corpCode:'00126380'})).status,200);
  assert.equal((await owner.request('/account/favorites','POST',{corpCode:'00164779'})).status,409);
  const before=owner.jar.finalyze_session,other=f.client();await other.login('owner');
  assert.equal((await owner.status()).authenticated,false);assert.equal((await other.status()).limits.maxSessions,1);
  assert.equal((await other.status()).favorites.length,1);assert.notEqual(other.jar.finalyze_session,before);
});
test('dynamic member concurrency and push caps are enforced without blocking an existing subscription update',async t=>{
  const f=await fixture(t),owner=f.client();await owner.login('owner');
  await f.settings.save({...defaultSettings({}),memberConcurrent:2,intervalSeconds:1,maxPush:1},0,'admin');
  const run=createAnalysisLimiter({store:f.shared,now:f.now,env:{},getSettings:f.settings.values}),releases=[];
  const first=run('same-user',()=>new Promise(resolve=>releases.push(resolve)));await new Promise(setImmediate);f.advance(1000);
  const second=run('same-user',()=>new Promise(resolve=>releases.push(resolve)));await new Promise(setImmediate);f.advance(1000);
  await assert.rejects(run('same-user',()=>assert.fail('member concurrency bypass')),{status:429});
  releases.forEach(resolve=>resolve());await Promise.all([first,second]);
  const {createECDH}=require('node:crypto');const key=createECDH('prime256v1');key.generateKeys();
  const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/first',keys:{p256dh:key.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
  f.config.pushPublic='test-public';f.config.pushPrivate='test-private';
  assert.equal((await owner.request('/account/push','POST',{subscription})).status,200);
  assert.equal((await owner.request('/account/push','POST',{subscription:{...subscription,endpoint:'https://fcm.googleapis.com/fcm/send/second'}})).status,409);
  assert.equal((await owner.request('/account/push','POST',{subscription})).status,200);
  assert.equal((await owner.status()).subscriptions.length,1);
});
test('dashboard keeps member stats available if usage cache is down, and KST signup counts exclude earlier days',async t=>{
  const f=await fixture(t),owner=f.client();await owner.login('owner');
  await f.store.query('UPDATE app_users SET created_at=$1',[Date.parse('2026-11-05T14:59:59Z')]);
  f.shared.analysisUsage=async()=>{throw Error('private cache details');};
  const data=await(await owner.request('/admin/dashboard')).json();
  assert.equal(data.stats.members,1);assert.equal(data.stats.new_members,0);assert.equal(data.aiUsage,null);
  assert.doesNotMatch(JSON.stringify(data),/private cache details/);
});
