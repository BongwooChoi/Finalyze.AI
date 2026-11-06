const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function fixture(options = {}) {
  const nodes = new Map(), events = new Map(), requests = [], rendered = [];
  const state = { enabled: true, authenticated: true, mailAvailable: true, emailEnabled: false,
    clientId: 'test-client', csrfToken: 'test-csrf', favorites: [], subscriptions: [] };
  let googleCallback;
  function node(id = '') {
    return { id, hidden: true, disabled: false, clientWidth: 236, textContent: '', attrs: {}, listeners: new Map(),
      classList: { toggle() {} }, replaceChildren() {}, append() {},
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
  const context = vm.createContext({ document, window: { google }, google, navigator: {},
    bootstrap: { Modal: class { show() {} hide() { document.getElementById('accountModal').listeners.get('hidden.bs.modal')?.(); } } },
    CustomEvent: class {}, fetch: async (url, request = {}) => {
      requests.push({ url, ...request });
      let result;
      if (url === '/api/account') result = structuredClone(state);
      else if (url === '/api/auth/challenge') result = options.challenge ? await options.challenge() : { nonce: 'nonce' };
      else if (url === '/api/auth/google') {
        const body = JSON.parse(request.body);
        state.emailEnabled = body.emailOptIn;
        state.emailMasked = 'm***@gmail.com';
        result = { status: 'success' };
      } else throw new Error('Unexpected request: ' + url);
      return { ok: true, json: async () => result };
    } });
  vm.runInContext(fs.readFileSync(require.resolve('../public/js/accounts.js'), 'utf8'), context);
  events.get('DOMContentLoaded')();
  await new Promise(setImmediate);
  return { nodes, state, requests, rendered, byId: document.getElementById,
    googleCallback: () => googleCallback };
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
});
