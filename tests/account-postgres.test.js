const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {neonDatabase,createAccountStore}=require('../accountStore');
const options={skip:!process.env.TEST_POSTGRES_URL};
async function fixture(t,hooks={}) {
  const url=new URL(process.env.TEST_POSTGRES_URL);
  assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/finalyze_security');
  const {Pool}=require(process.env.TEST_PG_MODULE || 'pg');
  const admin=new Pool({connectionString:url.href});
  const schema='security_'+randomUUID().replaceAll('-','');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({connectionString:url.href,max:16,options:`-c search_path=${schema}`});
  t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  // Exercise the production adapter's SQL, migration and transaction options against real PostgreSQL.
  const sql={
    query(text,params=[]){return {text,params,then(resolve,reject){return pool.query(text,params).then(r=>r.rows).then(resolve,reject);}};},
    async transaction(queries,config){
      assert.equal(config.isolationLevel,'ReadCommitted');
      const client=await pool.connect();
      try {await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');const result=[];
        for(const [index,{text,params}] of queries.entries()) {
          result.push((await client.query(text,params)).rows);
          await hooks.afterStatement?.({text,params,index});
        }
        await client.query('COMMIT');return result;
      } catch(error){await client.query('ROLLBACK');throw error;} finally {client.release();}
    }
  };
  const store=createAccountStore(neonDatabase('test-only',()=>sql));await store.initialize();
  await store.ensureUser('a');await store.ensureUser('b');return store;
}
function company(i){return {corp_code:String(i).padStart(8,'0'),corp_name:'Test '+i,stock_code:String(i).padStart(6,'0')};}
test('Postgres: distinct concurrent favorites cannot exceed 50 and repeat registration remains idempotent',options,async t=>{
  const store=await fixture(t);
  await Promise.all(Array.from({length:49},(_,i)=>store.addFavorite('a',company(i))));
  const result=await Promise.all(Array.from({length:20},(_,i)=>store.addFavorite('a',company(i+49))));
  assert.equal(result.filter(Boolean).length,1);assert.equal((await store.favorites('a')).length,50);
  assert.ok(await store.addFavorite('a',company(0)));assert.ok(await store.addFavorite('b',company(100)));
});
test('Postgres: concurrent push additions stay within five, updates and moves preserve ownership on rejection',options,async t=>{
  const store=await fixture(t);
  await Promise.all(Array.from({length:4},(_,i)=>store.addPush('a','device'+i,'encrypted')));
  const result=await Promise.all(Array.from({length:20},(_,i)=>store.addPush('a','device'+(i+4),'encrypted')));
  assert.equal(result.filter(Boolean).length,1);assert.equal((await store.subscriptions('a')).length,5);
  assert.ok(await store.addPush('a','device0','updated'));
  assert.ok(await store.addPush('b','moving-device','encrypted'));
  assert.equal(await store.addPush('a','moving-device','encrypted'),null);
  assert.equal((await store.subscriptions('b')).length,1);
  await store.removePush('a','device0');assert.ok(await store.addPush('a','moving-device','encrypted'));
  assert.equal((await store.subscriptions('a')).length,5);assert.equal((await store.subscriptions('b')).length,0);
});
test('Postgres: concurrent account moves leave a push endpoint assigned to only one account',options,async t=>{
  const store=await fixture(t);
  await Promise.all([store.addPush('a','shared','encrypted'),store.addPush('b','shared','encrypted')]);
  assert.equal((await store.query('SELECT * FROM app_push WHERE id=$1',['shared'])).length,1);
});
test('Postgres: email consent and push registration use a consistent lock order',options,async t=>{
  let armed=false,notify;const started=new Promise(resolve=>{notify=resolve;});
  const store=await fixture(t,{afterStatement:async({text,index})=>{
    if(armed && index===0 && text.startsWith('UPDATE ')) {
      armed=false;notify();await new Promise(resolve=>setTimeout(resolve,150));
    }
  }});
  await store.addFavorite('a',company(1));armed=true;
  const email=store.setEmail('a','encrypted-email');await started;
  const outcomes=await Promise.allSettled([email,store.addPush('a','device','encrypted-push')]);
  assert.deepEqual(outcomes.map(r=>r.status==='fulfilled'?'ok':r.reason.code),['ok','ok']);
  assert.equal((await store.user('a')).email_enabled,1);assert.equal((await store.subscriptions('a')).length,1);
});
test('Postgres: concurrent session issuance stays within five and preserves another account',options,async t=>{
  const store=await fixture(t),expires=Date.now()+86400000;
  await store.addSession('other','b',expires);
  await Promise.all(Array.from({length:24},(_,i)=>store.addSession('session'+i,'a',expires+i)));
  await store.addSession('newest','a',expires+1000);
  assert.equal((await store.query('SELECT * FROM app_sessions WHERE user_id=$1',['a'])).length,5);
  assert.ok(await store.session('newest'));assert.ok(await store.session('other'));
});
