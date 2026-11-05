const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
function worker() {
  const listeners={},notices=[],opened=[];
  const origin='https://finalyze-ai.vercel.app';
  const self={location:{origin},addEventListener:(type,fn)=>{listeners[type]=fn;},
    registration:{showNotification:async(title,options)=>notices.push({title,...options})},
    clients:{matchAll:async()=>[],openWindow:async url=>opened.push(url)}};
  const context={self,URL,location:self.location};
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/sw.js'),'utf8'),context);
  async function emit(type,data) {let done; listeners[type]({...data,waitUntil:value=>{done=value;}}); await done;}
  return{emit,notices,opened};
}
test('push notifications retain disclosure selection only for the app origin',async()=>{
  const w=worker();
  const url='https://finalyze-ai.vercel.app/?corp=00126380&rcept=20261106000001';
  await w.emit('push',{data:{json:()=>({title:'새 공시',body:'분기보고서',url,tag:'one'})}});
  assert.equal(w.notices[0].data.url,url);
  for(const url of ['https://evil.example/','javascript:alert(1)','/api/ai-financial-analysis']) {
    await w.emit('push',{data:{json:()=>({url})}});
    assert.equal(w.notices.at(-1).data.url,'https://finalyze-ai.vercel.app/');
  }
  let closed=false;
  await w.emit('notificationclick',{notification:{data:{url},close:()=>{closed=true;}}});
  assert.equal(closed,true); assert.equal(w.opened[0],url);
});
