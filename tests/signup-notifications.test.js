const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createAccountStore,sqliteDatabase}=require('../accountStore');
const {signupNotificationConfig,createSignupNotifications}=require('../signupNotifications');
const {createNotificationJob}=require('../disclosureNotifications');
const config={enabled:true,chat:'123456789',token:'123456:'+'x'.repeat(35)};
async function fixture(t,options={}) {
  let time=Date.parse('2026-11-13T14:59:00Z');
  const now=()=>time,store=createAccountStore(sqliteDatabase(),now),calls=[];
  t.after(()=>store.close());
  const notifier=createSignupNotifications({store,config,now,pause:async()=>{},api:async(method,payload)=>{
    calls.push({method,payload});return {message_id:100+calls.length};
  },...options});
  return {store,notifier,calls,now,advance:ms=>{time+=ms;}};
}
test('private recipient requires explicit opt-in, never the channel or username',()=>{
  const env={TELEGRAM_SIGNUP_ENABLED:'true',TELEGRAM_BOT_TOKEN:config.token,TELEGRAM_ADMIN_CHAT_ID:config.chat};
  assert.equal(signupNotificationConfig(env).enabled,true);
  for(const chat of ['','-100123456789','@username','0','123 OR 1=1']) assert.equal(signupNotificationConfig({...env,TELEGRAM_ADMIN_CHAT_ID:chat}).enabled,false);
  assert.equal(signupNotificationConfig({...env,TELEGRAM_SIGNUP_ENABLED:'false'}).enabled,false);
  assert.equal(signupNotificationConfig({TELEGRAM_ENABLED:'true',TELEGRAM_BOT_TOKEN:config.token,TELEGRAM_CHAT_ID:config.chat}).enabled,false);
});
test('existing members and repeat logins are skipped; KST counts and message have no member identity',async t=>{
  const f=await fixture(t);
  await f.store.ensureUser('old-private-user');
  assert.equal((await f.notifier.run()).sent,0);
  f.advance(1000);await f.store.ensureUser('new-private-user');
  f.advance(60000);await f.store.ensureUser('next-day-user');
  assert.equal((await f.notifier.run()).sent,2);
  assert.match(f.calls[0].payload.text,/가입 시각: 2026-11-13 23:59 \(KST\)/);
  assert.match(f.calls[0].payload.text,/오늘 신규: 1명/);
  assert.match(f.calls[0].payload.text,/현재 전체 회원: 3명/);
  assert.equal(f.calls[0].payload.chat_id,config.chat);
  assert.doesNotMatch(JSON.stringify(f.calls),/private-user|next-day-user|email|@gmail|google/);
  await f.store.ensureUser('new-private-user');
  assert.equal((await f.notifier.run()).sent,0);
});
test('concurrent workers claim a signup once',async t=>{
  const f=await fixture(t);await f.notifier.run();f.advance(1000);await f.store.ensureUser('a');
  await Promise.all([f.notifier.run(),f.notifier.run(),f.notifier.run()]);
  assert.equal(f.calls.length,1);
});
test('disabled notifier does not access storage',async()=>{
  const n=createSignupNotifications({config:{enabled:false},store:()=>{throw Error('must not run');}});
  assert.deepEqual(await n.run(),{enabled:false});
});
test('429 waits for retry_after and then sends once',async t=>{
  let attempts=0;
  const f=await fixture(t,{api:async()=>{if(++attempts===1) throw Object.assign(Error(),{statusCode:429,retryAfter:60});return {message_id:1};}});
  await f.notifier.run();f.advance(1000);await f.store.ensureUser('a');
  assert.equal((await f.notifier.run()).failed,1);
  await f.notifier.run();assert.equal(attempts,1);
  f.advance(60000);assert.equal((await f.notifier.run()).sent,1);
  await f.notifier.run();assert.equal(attempts,2);
});
test('uncertain delivery, expired lease and post-send database failure never automatically resend',async t=>{
  for(const mode of ['timeout','abandoned','db']) {
    const f=await fixture(t,{api:async()=>{if(mode==='timeout') throw Object.assign(Error(),{uncertain:true});return {message_id:1};}});
    await f.notifier.run();f.advance(1000);await f.store.ensureUser('a');
    if(mode==='abandoned') {await f.store.captureSignups(config.chat);await f.store.claimSignup(config.chat,'a');f.advance(31000);}
    if(mode==='db') {const finish=f.store.finishSignup;f.store.finishSignup=(...args)=>{if(args[2]==='sent') throw Error('db failed');return finish(...args);};}
    await f.notifier.run();f.advance(86400000);assert.equal((await f.notifier.run()).sent,0);
    assert.equal((await f.store.query('SELECT status FROM app_signup_deliveries'))[0].status,'uncertain');
  }
});
test('403 stops the batch and pauses the private recipient',async t=>{
  let attempts=0;const f=await fixture(t,{api:async()=>{attempts++;throw Object.assign(Error(),{statusCode:403});}});
  await f.notifier.run();f.advance(1000);await f.store.ensureUser('a');await f.store.ensureUser('b');
  await f.notifier.run();await f.notifier.run();assert.equal(attempts,1);
});
test('account deletion removes queued signup; old records cannot be re-enqueued after cleanup',async t=>{
  const f=await fixture(t);await f.notifier.run();f.advance(1000);await f.store.ensureUser('a');
  await f.store.captureSignups(config.chat);await f.store.query('DELETE FROM app_users WHERE id=$1',['a']);
  assert.equal((await f.notifier.run()).sent,0);
  await f.store.ensureUser('b');await f.notifier.run();f.advance(31*86400000);
  assert.equal((await f.notifier.run()).sent,0);
  assert.equal((await f.store.query('SELECT * FROM app_signup_deliveries')).length,0);
});
test('signup notifier failure does not stop existing disclosure notifications',async t=>{
  const f=await fixture(t);let collected=0;
  const job=createNotificationJob({store:f.store,now:f.now,senders:{},collect:async()=>{collected++;return [];},
    broadcast:{enabled:true,companies:async()=>[{corp_code:'00126380'}],capture:async()=>{},deliver:async()=>({sent:0})},
    signupNotifications:{enabled:true,run:async()=>{throw Error('private secret must not be logged');}}});
  const result=await job();assert.equal(result.signups.unavailable,true);assert.equal(collected,1);
});
