const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { createAccountStore,sqliteDatabase } = require('../accountStore');
const { createAccountRouter } = require('../accountRoutes');
const { seal,open,validateSubscription,digest } = require('../accountSecurity');
const { createNotificationJob,createDisclosureFeed } = require('../disclosureNotifications');
const COMPANY = { corp_code:'00126380',corp_name:'삼성전자',stock_code:'005930' };
const config = { enabled:true,origin:'http://localhost:3000',clientId:'test-client',sessionSecret:'session'.repeat(10),
  identitySecret:'identity'.repeat(10),dataKey:crypto.randomBytes(32).toString('base64'),pushPublic:'public',pushPrivate:'private',mailAvailable:false };
const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
const subscription = { endpoint:'https://fcm.googleapis.com/fcm/send/test-subscription',
  keys:{ p256dh:ecdh.getPublicKey().toString('base64url'),auth:crypto.randomBytes(16).toString('base64url') } };
async function fixture(t,options = {}) {
  let time = Date.parse('2026-11-06T01:00:00Z');
  const now = () => time;
  const store = createAccountStore(sqliteDatabase(),now);
  const identities = new Map();
  const accounts = createAccountRouter({ store,config:{...config,...options},now,
    findCompany:async id => id===COMPANY.corp_code ? COMPANY : null,
    verifyIdentity:async token => { if(!identities.has(token)) throw new Error('forged'); return identities.get(token); } });
  const app = express(); app.use(express.json()); app.use('/api',accounts.router);
  const server = await new Promise(resolve => { const instance=app.listen(0,'127.0.0.1',() => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await store.close(); });
  function client() {
    const jar = {};
    async function request(route,method = 'GET',body,headers = {}) {
      const response = await fetch(base+route,{ method,headers:{ Origin:config.origin,'Content-Type':'application/json',
        Cookie:Object.entries(jar).map(([key,value])=>`${key}=${value}`).join('; '),...headers },
        ...(body===undefined ? {} : {body:JSON.stringify(body)}) });
      for(const cookie of response.headers.getSetCookie()) { const value=cookie.split(';')[0],index=value.indexOf('='); jar[value.slice(0,index)]=value.slice(index+1); }
      return response;
    }
    async function status() { return (await request('/account')).json(); }
    async function login(sub = 'google-user-a',options = {}) {
      const challenge=await (await request('/auth/challenge','POST',{})).json();
      const token=crypto.randomUUID();
      identities.set(token,{sub,nonce:challenge.nonce,email:'private@gmail.com',email_verified:true,name:'PRIVATE NAME',picture:'PRIVATE PHOTO',...options.payload});
      return request('/auth/google','POST',{credential:token,...options.body});
    }
    async function mutate(route,method,body) { return request(route,method,body,{'X-CSRF-Token':(await status()).csrfToken}); }
    return {request,status,login,mutate,jar};
  }
  return {store,client,identities,accounts,now,advance:ms=>{time+=ms;}};
}

test('Google profile and email are discarded; sessions only persist token hashes',async t => {
  const f=await fixture(t), a=f.client();
  assert.equal((await a.login()).status,200);
  const state=await a.status();
  assert.equal(state.authenticated,true);
  assert.equal(state.emailEnabled,false);
  const users=await f.store.query('SELECT * FROM app_users');
  assert.equal(users.length,1); assert.equal(users[0].email_enc,null);
  assert.doesNotMatch(JSON.stringify(users),/private@gmail|PRIVATE|google-user-a/);
  const sessions=await f.store.query('SELECT * FROM app_sessions');
  assert.equal(sessions[0].token_hash,digest(a.jar.finalyze_session));
  assert.notEqual(sessions[0].token_hash,a.jar.finalyze_session);
});
test('login requires correct origin, valid identity, and the browser-bound nonce',async t => {
  const f=await fixture(t), a=f.client();
  assert.equal((await a.request('/auth/challenge','POST',{}, {Origin:'https://evil.example'})).status,403);
  assert.equal((await a.request('/auth/google','POST',{credential:'forged'})).status,403);
  assert.equal((await a.login('user',{payload:{nonce:'wrong'}})).status,401);
  const challenge=await a.request('/auth/challenge','POST',{}); assert.equal(challenge.status,200);
  assert.equal((await a.request('/auth/google','POST',{credential:'forged'})).status,401);
  assert.equal((await a.status()).authenticated,false);
});
test('favorites require session and CSRF and stay isolated between accounts',async t => {
  const f=await fixture(t), a=f.client(),b=f.client();
  assert.equal((await a.request('/account/favorites','POST',{corpCode:COMPANY.corp_code})).status,401);
  await a.login(); await b.login('google-user-b');
  assert.equal((await a.request('/account/favorites','POST',{corpCode:COMPANY.corp_code})).status,403);
  assert.equal((await a.mutate('/account/favorites','POST',{corpCode:'invalid'})).status,400);
  assert.equal((await a.mutate('/account/favorites','POST',{corpCode:'99999999'})).status,404);
  assert.equal((await a.mutate('/account/favorites','POST',{corpCode:COMPANY.corp_code})).status,200);
  await a.mutate('/account/favorites','POST',{corpCode:COMPANY.corp_code});
  assert.equal((await a.status()).favorites.length,1);
  assert.equal((await b.status()).favorites.length,0);
  await b.mutate(`/account/favorites/${COMPANY.corp_code}`,'DELETE');
  assert.equal((await a.status()).favorites.length,1);
  const oldToken=a.jar.finalyze_session; await a.login();
  assert.equal(await f.store.session(digest(oldToken)),null);
  f.advance(8*86400000); assert.equal((await a.status()).authenticated,false);
});
test('push endpoints are allowlisted and subscriptions are encrypted at rest',async t => {
  const f=await fixture(t), a=f.client(); await a.login();
  assert.equal(validateSubscription(subscription),true);
  for(const endpoint of ['http://fcm.googleapis.com/x','https://127.0.0.1/x','https://fcm.googleapis.com.attacker.example/x','https://user:password@fcm.googleapis.com/x']) {
    assert.equal((await a.mutate('/account/push','POST',{subscription:{...subscription,endpoint}})).status,400);
  }
  assert.equal((await a.mutate('/account/push','POST',{subscription})).status,200);
  const rows=await f.store.query('SELECT * FROM app_push');
  assert.equal(rows.length,1); assert.ok(!rows[0].subscription_enc.includes(subscription.endpoint));
  assert.deepEqual(open(rows[0].subscription_enc,config.dataKey),subscription);
  const tampered=rows[0].subscription_enc.slice(0,-4)+'AAAA';
  assert.throws(()=>open(tampered,config.dataKey));
});
test('a browser push subscription moves to the currently signed-in account',async t => {
  const f=await fixture(t),a=f.client(),b=f.client(); await a.login(); await b.login('another-push-user');
  await a.mutate('/account/push','POST',{subscription});
  await b.mutate('/account/push','POST',{subscription});
  assert.equal((await a.status()).subscriptions.length,0);
  assert.equal((await b.status()).subscriptions.length,1);
});
test('mail remains off without sender setup, and GET unsubscribe never changes consent',async t => {
  const f=await fixture(t), a=f.client();
  assert.equal((await a.login('mail-user',{body:{emailOptIn:true}})).status,409);
  await a.login(); const id=(await f.store.query('SELECT id FROM app_users'))[0].id;
  await f.store.setEmail(id,seal('user@gmail.com',config.dataKey));
  const user=await f.store.user(id), token=f.accounts.unsubscribeToken(id,Number(user.email_since));
  assert.equal((await a.request(`/notifications/unsubscribe/${token}`)).status,200);
  assert.equal((await f.store.user(id)).email_enabled,1);
  assert.equal((await a.request(`/notifications/unsubscribe/${token}`,'POST',{})).status,200);
  assert.equal((await f.store.user(id)).email_enc,null);
});
test('logout removes the current device, and account deletion cascades only its own records',async t => {
  const f=await fixture(t), a=f.client(),b=f.client(); await a.login(); await b.login('another-user');
  await a.mutate('/account/favorites','POST',{corpCode:COMPANY.corp_code});
  await a.mutate('/account/push','POST',{subscription});
  await a.mutate('/auth/logout','POST',{endpoint:subscription.endpoint});
  assert.equal((await a.status()).authenticated,false);
  assert.equal((await f.store.query('SELECT * FROM app_push')).length,0);
  await a.login();
  assert.equal((await a.mutate('/account','DELETE',{confirm:true})).status,200);
  assert.equal((await f.store.query('SELECT * FROM app_favorites')).length,0);
  assert.equal((await b.status()).authenticated,true);
  assert.equal((await f.store.query('SELECT * FROM app_users')).length,1);
});
function event(id) { return {...COMPANY,rcept_no:`20261106${String(id).padStart(6,'0')}`,rcept_dt:'20261106',report_nm:'분기보고서 (2026.09)'}; }
test('notification baseline skips history; new receipts send once and retries honor opt-out',async t => {
  const f=await fixture(t); const id='notification-user'; await f.store.ensureUser(id); await f.store.addFavorite(id,COMPANY);
  await f.store.addPush(id,'device',seal(subscription,config.dataKey));
  let rows=[event(1)],sent=0,fail=false;
  const job=createNotificationJob({store:f.store,now:f.now,collect:async()=>rows,senders:{push:async()=>{if(fail)throw {statusCode:503};sent++;}}});
  assert.equal((await job()).sent,0); assert.equal(sent,0);
  f.advance(1000); rows=[event(1),event(2)]; assert.equal((await job()).sent,1);
  f.advance(1000); await job(); assert.equal(sent,1);
  fail=true; rows.push(event(3)); f.advance(1000); assert.equal((await job()).failed,1);
  await f.store.removeFavorite(id,COMPANY.corp_code); f.advance(600000); fail=false;
  assert.equal((await job()).skipped,1); assert.equal(sent,1);
});
test('a failed scan does not advance baseline; distributed job lease blocks overlap',async t => {
  const f=await fixture(t); await f.store.ensureUser('id'); await f.store.addFavorite('id',COMPANY); await f.store.addPush('id','device',seal(subscription,config.dataKey));
  const job=createNotificationJob({store:f.store,collect:async()=>{throw Error('offline');},senders:{},now:f.now});
  assert.equal((await job()).partial,true);
  assert.equal(Number((await f.store.query('SELECT monitoring_since FROM app_favorites'))[0].monitoring_since),0);
  const lease=await f.store.acquireJob(); assert.ok(lease); assert.equal(await f.store.acquireJob(),null); await f.store.releaseJob(lease.token);
});
test('notification feed paginates both sources and excludes monthly sales without financial amounts',async()=>{
  const calls=[];
  const collect=createDisclosureFeed({now:()=>Date.parse('2026-11-06T01:00:00Z'),fetchList:async params=>{
    calls.push(params);
    if(params.pblntf_detail_ty) return {status:'000',total_page:1,list:[{...event(3),report_nm:'영업(잠정)실적(공정공시)'}]};
    return {status:'000',total_page:2,list:[event(params.page_no)]};
  },fetchDocumentText:async()=> '매출액 | 당해실적 | - | 판매대수 | 100 |'});
  const rows=await collect([COMPANY],Date.parse('2026-11-06T00:00:00Z'));
  assert.equal(rows.length,2); assert.equal(calls.length,3); assert.ok(calls.some(params=>params.page_no===2));
});
test('one unavailable provisional document leaves its company baseline pending without hiding healthy reports',async t=>{
  const f=await fixture(t); await f.store.ensureUser('id'); await f.store.addFavorite('id',COMPANY);
  const second={corp_code:'00164779',corp_name:'현대자동차',stock_code:'005380'};
  await f.store.addFavorite('id',second); await f.store.addPush('id','device',seal(subscription,config.dataKey));
  const collect=createDisclosureFeed({now:f.now,fetchList:async params=>({status:'000',total_page:1,list:params.pblntf_ty ?
    [{...event(2),...second}] : [{...event(1),report_nm:'영업(잠정)실적(공정공시)'}]}),fetchDocumentText:async()=>{throw Error('offline');}});
  const job=createNotificationJob({store:f.store,collect,senders:{push:async()=>assert.fail('baseline must not send')},now:f.now});
  const result=await job(); assert.equal(result.partial,true); assert.equal(result.scanned,1);
  const rows=await f.store.query('SELECT corp_code,monitoring_since FROM app_favorites');
  assert.equal(Number(rows.find(row=>row.corp_code===COMPANY.corp_code).monitoring_since),0);
  assert.ok(Number(rows.find(row=>row.corp_code===second.corp_code).monitoring_since)>0);
});
