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
  const app=express();app.use(express.json());app.use('/api',accounts.router);app.use('/api/admin',createAdminRouter({accounts,settings,store,sharedStore:shared,now}));
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
  return{store,shared,settings,config,client,now,advance:ms=>time+=ms};
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
test('the migrated traffic proxy is removed even for a signed-in administrator',async t=>{
 const f=await fixture(t),owner=f.client();await owner.login('owner');
 assert.equal((await owner.request('/admin/traffic')).status,404);
 assert.equal((await owner.request('/admin/traffic/sync','POST',{})).status,404);
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

test('member list and detail enforce admin, CSRF and live allowlist, with no-store responses',async t=>{
  const f=await fixture(t),guest=f.client(),normal=f.client(),owner=f.client();
  await normal.login('normal','normal@example.com');await owner.login('owner');
  const id=(await f.store.query('SELECT id FROM app_users ORDER BY id'))[0].id;
  for(const path of ['/admin/members','/admin/members/'+id]){
    assert.equal((await guest.request(path)).status,401);
    assert.equal((await normal.request(path)).status,403);
    assert.equal((await owner.request(path,'GET',undefined,{'X-CSRF-Token':''})).status,403);
    assert.equal((await owner.request(path,'GET',undefined,{Origin:'https://evil.example'})).status,403);
    const response=await owner.request(path);assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'no-store');assert.match(response.headers.get('x-robots-tag'),/noindex/);
  }
  f.config.adminEmailHashes=[];
  assert.equal((await owner.request('/admin/members/'+id)).status,403);
});

test('member filters agree with aggregate counts without multiplying sessions, devices or favorites',async t=>{
  const f=await fixture(t),owner=f.client();await owner.login('owner');
  const {sign}=require('../accountSecurity');
  const ids=['older','today','boundary','inactive'].map(x=>sign(x,'fixture-members'));
  for(const id of ids)await f.store.ensureUser(id);
  const start=Date.parse('2026-11-06T00:00:00+09:00');
  await f.store.query('UPDATE app_users SET created_at=$1 WHERE id=$2',[start-1,ids[0]]);
  await f.store.query('UPDATE app_users SET created_at=$1 WHERE id=$2',[start,ids[2]]);
  await f.store.setEmail(ids[1],'private-email-ciphertext');
  for(let i=0;i<2;i++){
    await f.store.addSession('secret-token-'+i,ids[1],f.now()+10000+i);
    await f.store.addPush(ids[1],'private-endpoint-'+i,'private-subscription-ciphertext');
    await f.store.addFavorite(ids[1],{corp_code:'0000000'+i,corp_name:'기업 '+i,stock_code:'00000'+i});
  }
  await f.store.addSession('expired-token',ids[0],f.now());
  const stats=(await(await owner.request('/admin/dashboard')).json()).stats;
  for(const [filter,key] of Object.entries({all:'members',new:'new_members',signedIn:'signed_in_members',email:'email_members',push:'push_members'})){
    const data=await(await owner.request('/admin/members?filter='+filter)).json();assert.equal(data.total,stats[key],filter);
  }
  const listed=await(await owner.request('/admin/members?filter=push')).json();
  assert.equal(listed.total,1);assert.equal(listed.members[0].devices,2);assert.equal(listed.members[0].sessions,2);assert.equal(listed.members[0].favorites,2);
  assert.equal((await(await owner.request('/admin/members?filter=favorites')).json()).total,1);
  assert.equal((await(await owner.request('/admin/members?filter=queued')).json()).total,0);
  assert.doesNotMatch(JSON.stringify(listed),/private-|email_enc|subscription_enc|token_hash|email_hash/);
});

test('member list validates input, bounds pages and supports exact case-sensitive identifier prefixes',async t=>{
  const f=await fixture(t),owner=f.client();await owner.login('owner');
  for(let i=0;i<29;i++)await f.store.ensureUser(String(i).padStart(43,'A'));
  const first=await(await owner.request('/admin/members')).json();
  const second=await(await owner.request('/admin/members?page=2')).json();
  assert.equal(first.total,30);assert.equal(first.members.length,25);assert.equal(second.members.length,5);
  assert.equal(new Set([...first.members,...second.members].map(m=>m.id)).size,30);
  assert.equal((await(await owner.request('/admin/members?page=999999')).json()).page,2);
  assert.equal((await(await owner.request('/admin/members?search=AAAA')).json()).total,29);
  assert.equal((await(await owner.request('/admin/members?search=aaaa')).json()).total,0);
  for(const query of ['filter=__proto__','filter=bad','filter[]=all','page=0','page=-1','page=1.5','page=1000000','page=2&page=1','search=%25','search=%27%20OR%201=1','search[]=id','search='+'a'.repeat(44)])
    assert.equal((await owner.request('/admin/members?'+query)).status,400,query);
});

test('member details return only operational data, member-scoped usage and recent delivery outcomes',async t=>{
  const f=await fixture(t),owner=f.client();await owner.login('owner');
  const [user]=await f.store.query('SELECT id FROM app_users');
  const id=user.id,other='z'.repeat(43);await f.store.ensureUser(other);
  await f.store.setEmail(id,'not-decryptable-private-email');
  await f.store.addPush(id,'private-push-id','private-endpoint');
  await f.store.addFavorite(id,{corp_code:'00126380',corp_name:'<img src=x onerror=alert(1)>',stock_code:'005930'});
  await f.store.query('INSERT INTO app_disclosures(receipt,corp_code,corp_name,report_name,receipt_date,first_seen) VALUES($1,$2,$3,$4,$5,$6)',
    ['20261106000001','00126380','삼성전자','분기보고서','20261106',f.now()]);
  for(let i=0;i<34;i++)await f.store.query('INSERT INTO app_deliveries(id,user_id,receipt,channel,target_id,status,attempts) VALUES($1,$2,$3,$4,$5,$6,$7)',
    ['private-delivery-'+i,i===33?other:id,'20261106000001','email','private-target',i===0?'pending':i===1?'failed':'sent',i===0?1:5]);
  await f.shared.set(`finalyze:ai:v1:user:${id}:day:2026-11-06`,3,86400);
  const detail=await(await owner.request('/admin/members/'+id)).json();
  assert.equal(detail.aiUsage.used,3);assert.equal(detail.member.queued,1);assert.equal(detail.deliveries.length,30);
  assert.equal(detail.member.emailEnabled,true);assert.equal(detail.devices.length,1);assert.equal(detail.sessions.length,1);
  assert.equal(detail.favorites[0].name,'<img src=x onerror=alert(1)>');
  assert.doesNotMatch(JSON.stringify(detail),/private-|email_enc|subscription_enc|token_hash|email_hash|csrfToken/);
  assert.equal((await(await owner.request('/admin/members?filter=queued')).json()).total,1);
  f.shared.get=async()=>{throw Error('private cache details');};
  assert.equal((await(await owner.request('/admin/members/'+id)).json()).aiUsage,null);
  assert.equal((await owner.request('/admin/members/not-an-id')).status,400);
  await f.store.deleteUser(id);
  // Keep authorization in a separate account after deleting the inspected member.
  const secondOwner=f.client();await secondOwner.login('second-owner');
  assert.equal((await secondOwner.request('/admin/members/'+id)).status,404);
});
