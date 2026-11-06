const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');

async function fixture(options = {}) {
  const nodes = new Map(), events = new Map(), requests = [], rendered = [];
  const state = { enabled: true, authenticated: true, mailAvailable: true, emailEnabled: false,
    clientId: 'test-client', csrfToken: 'test-csrf', favorites: [], subscriptions: [],
    pushAvailable: true, pushPublicKey: Buffer.alloc(65,4).toString('base64url'), ...options.state };
  const subscriptionData={endpoint:'https://fcm.googleapis.com/fcm/send/test-device',keys:{p256dh:'public',auth:'auth'}};
  const id=crypto.createHash('sha256').update(subscriptionData.endpoint).digest('hex');
  let subscribed=Boolean(options.pushEnabled), permissionCalls=0;
  if(subscribed) state.subscriptions=[{id}];
  const subscription={endpoint:subscriptionData.endpoint,toJSON:()=>subscriptionData,unsubscribe:async()=>{subscribed=false;return true;}};
  const registration={pushManager:{getSubscription:async()=>subscribed?subscription:null,
    subscribe:async()=>{subscribed=true;return subscription;}}};
  const Notification={permission:options.permission||'default',requestPermission:async()=>{
    permissionCalls++;Notification.permission=options.requestPermission?await options.requestPermission():'granted';return Notification.permission;
  }};
  let googleCallback;
  function node(id = '') {
    const classes=new Set();
    return { id, hidden: true, disabled: false, clientWidth: 236, textContent: '', attrs: {}, listeners: new Map(),
      classList: { toggle(name,on) {if(on)classes.add(name);else classes.delete(name);},contains(name){return classes.has(name);} }, replaceChildren() {}, append() {},
      setAttribute(key, value) { this.attrs[key] = value; }, getAttribute(key) { return this.attrs[key]; },
      addEventListener(type, callback) { this.listeners.set(type, callback); },
      focus() { this.focused = true; },
      scrollIntoView(value) { this.scrolled = value; }, async click() { return this.listeners.get('click')?.(); } };
  }
  const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node(id)); return nodes.get(id); },
    createElement() { return node(); }, addEventListener(type, callback) { events.set(type, callback); }, dispatchEvent() {} };
  const google = { accounts: { id: {
    initialize(value) { googleCallback = value.callback; },
    renderButton(container, value) { rendered.push({ id: container.id, width: value.width }); }, disableAutoSelect() {}
  } } };
  const context = vm.createContext({ document, window: { google,Notification,PushManager:class {} }, google,Notification,
    navigator: {serviceWorker:{ready:Promise.resolve(registration),getRegistration:async()=>registration}},
    crypto:crypto.webcrypto,TextEncoder,Uint8Array,atob:value=>Buffer.from(value,'base64').toString('binary'),
    bootstrap: { Modal: class { show() {} hide() { document.getElementById('accountModal').listeners.get('hidden.bs.modal')?.(); } } },
    CustomEvent: class {}, fetch: async (url, request = {}) => {
      requests.push({ url, ...request });
      const intercepted=await options.request?.(url,request);
      if(intercepted)return intercepted;
      let result;
      if (url === '/api/account') result = structuredClone(state);
      else if (url === '/api/auth/challenge') result = options.challenge ? await options.challenge() : { nonce: 'nonce' };
      else if (url === '/api/auth/google') {
        const body = JSON.parse(request.body);
        state.emailEnabled = body.emailOptIn;
        state.emailMasked = 'm***@gmail.com';
        result = { status: 'success' };
      } else if(url==='/api/account/push') {
        state.subscriptions=request.method==='POST'?[{id}]:[];result={status:'success'};
      } else if(url==='/api/account/email' && request.method==='DELETE') {
        state.emailEnabled=false;result={status:'success'};
      } else throw new Error('Unexpected request: ' + url);
      return { ok: true, json: async () => result };
    } });
  vm.runInContext(fs.readFileSync(require.resolve('../public/js/accounts.js'), 'utf8'), context);
  events.get('DOMContentLoaded')();
  const deadline=Date.now()+1000;
  while(!document.getElementById('accountPushState').textContent && Date.now()<deadline) await new Promise(setImmediate);
  assert.ok(document.getElementById('accountPushState').textContent,'initial account render completed');
  return { nodes, state, requests, rendered, byId: document.getElementById,
    googleCallback: () => googleCallback,permissionCalls:()=>permissionCalls };
}

test('email linking shows the Google button beside the email setting without returning to the login area', async () => {
  const f = await fixture();
  await f.byId('emailEnableButton').click();
  assert.equal(f.byId('accountEmailConnect').hidden, false);
  assert.equal(f.byId('googleAccountButton').hidden, true);
  assert.equal(f.rendered.length, 1);
  assert.equal(f.rendered[0].id, 'googleEmailButton');
  assert.ok(f.rendered[0].width <= 236);
  assert.equal(f.byId('accountEmailConnect').scrolled.block, 'nearest');
  assert.equal(f.byId('emailEnableButton').getAttribute('aria-expanded'), 'true');
  assert.match(f.byId('accountEmailMessage').textContent, /아래 버튼/);
  assert.ok(!f.requests.some(request => request.url === '/api/auth/google'));
  assert.equal(f.byId('accountEmailState').textContent,'꺼짐');
  assert.match(f.byId('accountEmailFeedback').textContent,/계정을 확인하면/);
});

test('a completed email choice sends explicit consent and collapses the local panel after refreshing status', async () => {
  const f = await fixture();
  await f.byId('emailEnableButton').click();
  await f.googleCallback()({ credential: 'verified-google-response' });
  const request = f.requests.find(request => request.url === '/api/auth/google');
  assert.equal(JSON.parse(request.body).emailOptIn, true);
  assert.equal(f.byId('accountEmailConnect').hidden, true);
  assert.equal(f.byId('emailEnableButton').hidden, true);
  assert.equal(f.byId('emailDisableButton').hidden, false);
  assert.match(f.byId('accountEmailStatus').textContent, /m\*\*\*@gmail.com/);
  assert.equal(f.byId('accountEmailState').textContent,'켜짐');
  assert.match(f.byId('accountEmailFeedback').className,/success/);
  assert.equal(f.byId('emailEnableButton').getAttribute('aria-busy'),'false');
  await f.byId('emailDisableButton').click();
  assert.equal(f.byId('accountEmailState').textContent,'꺼짐');
  assert.doesNotMatch(f.byId('accountMessage').textContent,/켰습니다/);
  assert.match(f.byId('accountEmailFeedback').textContent,/이메일 알림을 끄고/);
});

test('canceling email linking ignores a late Google response and does not change consent', async () => {
  const f = await fixture();
  await f.byId('emailEnableButton').click();
  const callback = f.googleCallback();
  await f.byId('emailConnectCancel').click();
  await callback({ credential: 'late-response' });
  assert.equal(f.byId('accountEmailConnect').hidden, true);
  assert.equal(f.byId('emailEnableButton').disabled, false);
  assert.equal(f.byId('emailEnableButton').getAttribute('aria-expanded'), 'false');
  assert.equal(f.byId('emailEnableButton').focused, true);
  assert.ok(!f.requests.some(request => request.url === '/api/auth/google'));
  assert.equal(f.byId('accountEmailState').textContent,'꺼짐');
  assert.match(f.byId('accountEmailFeedback').textContent,/취소/);
});

test('closing the account modal while a challenge is loading cannot reopen the email connection', async () => {
  let resolveChallenge;
  const f = await fixture({ challenge: () => new Promise(resolve => { resolveChallenge = resolve; }) });
  const preparing = f.byId('emailEnableButton').click();
  await new Promise(setImmediate);
  f.byId('accountModal').listeners.get('hidden.bs.modal')();
  resolveChallenge({ nonce: 'late-nonce' });
  await preparing;
  assert.equal(f.byId('accountEmailConnect').hidden, true);
  assert.equal(f.rendered.length, 0);
  assert.equal(f.byId('emailEnableButton').getAttribute('aria-busy'),'false');
});

test('push enabling reports progress immediately, prevents duplicate requests and waits for persisted state',async()=>{
  let release;
  const f=await fixture({request:async(url)=>{if(url==='/api/account/push')await new Promise(resolve=>{release=resolve;});}});
  assert.equal(f.byId('accountPushState').textContent,'꺼짐');
  const pending=f.byId('pushEnableButton').click();await new Promise(setImmediate);
  assert.equal(f.byId('pushEnableButton').disabled,true);
  assert.equal(f.byId('pushEnableButton').getAttribute('aria-busy'),'true');
  assert.match(f.byId('pushEnableButton').textContent,/켜는 중/);
  assert.match(f.byId('accountPushFeedback').className,/pending/);
  assert.equal(f.byId('accountPushState').textContent,'꺼짐');
  await f.byId('pushEnableButton').click();assert.equal(f.permissionCalls(),1);
  assert.equal(f.requests.filter(r=>r.url==='/api/account/push').length,1);
  release();await pending;
  assert.equal(f.byId('accountPushState').textContent,'켜짐');
  assert.equal(f.byId('pushDisableButton').hidden,false);
  assert.match(f.byId('accountPushFeedback').className,/success/);
  assert.match(f.byId('accountPushFeedback').textContent,/켰습니다/);
  assert.equal(f.byId('pushEnableButton').getAttribute('aria-busy'),'false');
});

test('both disabling controls show local progress and only confirm off after server acknowledgement',async()=>{
  for(const kind of ['push','email']) {
    let release;
    const path=`/api/account/${kind}`,button=`${kind}DisableButton`,prefix=kind==='push'?'Push':'Email';
    const f=await fixture({pushEnabled:true,state:{emailEnabled:true,emailMasked:'m***@gmail.com'},
      request:async(url)=>{if(url===path)await new Promise(resolve=>{release=resolve;});}});
    const pending=f.byId(button).click();await new Promise(setImmediate);
    assert.equal(f.byId(button).getAttribute('aria-busy'),'true');assert.equal(f.byId(button).disabled,true);
    assert.equal(f.byId(`account${prefix}State`).textContent,'켜짐');
    assert.match(f.byId(`account${prefix}Feedback`).textContent,/끄고 있습니다/);
    release();await pending;
    assert.equal(f.byId(`account${prefix}State`).textContent,'꺼짐');
    assert.equal(f.byId(`${kind}EnableButton`).hidden,false);
    assert.match(f.byId(`account${prefix}Feedback`).className,/success/);
    assert.match(f.byId(`account${prefix}Feedback`).textContent,/껐습니다|끄고 저장된/);
    assert.equal(f.byId(button).getAttribute('aria-busy'),'false');
  }
});

test('notification failures remain beside the affected control without showing a false success',async()=>{
  for(const kind of ['push','email']) {
    const path=`/api/account/${kind}`,prefix=kind==='push'?'Push':'Email';
    const f=await fixture({pushEnabled:true,state:{emailEnabled:true},request:async(url)=>url===path?
      {ok:false,json:async()=>({message:'설정을 저장하지 못했습니다.'})}:undefined});
    await f.byId(`${kind}DisableButton`).click();
    assert.equal(f.byId(`account${prefix}State`).textContent,'켜짐');
    assert.equal(f.byId(`${kind}DisableButton`).disabled,false);
    assert.equal(f.byId(`${kind}DisableButton`).getAttribute('aria-busy'),'false');
    assert.match(f.byId(`account${prefix}Feedback`).textContent,/설정을 저장하지 못했습니다/);
    assert.match(f.byId(`account${prefix}Feedback`).className,/error/);
  }
});

test('denied push permission explains the block locally and never registers or reports enabled',async()=>{
  const f=await fixture({requestPermission:async()=>'denied'});
  await f.byId('pushEnableButton').click();
  assert.equal(f.byId('accountPushState').textContent,'꺼짐');
  assert.equal(f.byId('pushEnableButton').disabled,true);
  assert.equal(f.byId('pushEnableButton').getAttribute('aria-busy'),'false');
  assert.match(f.byId('accountPushFeedback').textContent,/권한이 차단/);
  assert.ok(!f.requests.some(r=>r.url==='/api/account/push'));
});

test('email enablement waits for Google verification and server acknowledgement with duplicate callbacks ignored',async()=>{
  let release;
  const f=await fixture({request:async(url)=>{if(url==='/api/auth/google')await new Promise(resolve=>{release=resolve;});}});
  await f.byId('emailEnableButton').click();
  assert.equal(f.byId('accountEmailState').textContent,'꺼짐');
  const callback=f.googleCallback(),pending=callback({credential:'verified'});await new Promise(setImmediate);
  assert.equal(f.byId('emailEnableButton').getAttribute('aria-busy'),'true');
  assert.match(f.byId('accountEmailFeedback').className,/pending/);
  await callback({credential:'duplicate'});
  assert.equal(f.requests.filter(r=>r.url==='/api/auth/google').length,1);
  assert.equal(f.byId('accountEmailState').textContent,'꺼짐');
  release();await pending;
  assert.equal(f.byId('accountEmailState').textContent,'켜짐');
  assert.match(f.byId('accountEmailFeedback').className,/success/);
  assert.equal(f.byId('accountSignedIn').inert,false);
});

test('failed email verification stays off with a local error and waits for an explicit retry',async()=>{
  let rejected=false;
  const f=await fixture({request:async(url)=>{
    if(url==='/api/auth/google' && !rejected){rejected=true;return{ok:false,json:async()=>({message:'계정을 확인하지 못했습니다. 다시 선택해주세요.'})};}
  }});
  await f.byId('emailEnableButton').click();await f.googleCallback()({credential:'first-attempt'});
  assert.equal(f.byId('accountEmailState').textContent,'꺼짐');
  assert.match(f.byId('accountEmailFeedback').className,/error/);
  assert.match(f.byId('accountEmailFeedback').textContent,/계정을 확인하지 못했습니다/);
  assert.equal(f.byId('emailEnableButton').getAttribute('aria-busy'),'false');
  assert.equal(f.byId('accountEmailConnect').hidden,false);
  assert.equal(f.requests.filter(r=>r.url==='/api/auth/google').length,1);
  await f.googleCallback()({credential:'explicit-retry'});
  assert.equal(f.byId('accountEmailState').textContent,'켜짐');
  assert.match(f.byId('accountEmailFeedback').className,/success/);
});
