const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../public/js/main.js'), 'utf8');
const init = source.slice(source.indexOf('function initPwaInstallBanner()'));
const functionSource = init.slice(0, init.indexOf('\n// ============================================='));

function setup({ ua = '', standalone = false, storageBlocked = false } = {}) {
  const listeners = {}, elements = {}, timers = [];
  for (const id of ['pwaInstallBanner', 'pwaInstallBtn', 'pwaDismissBtn', 'pwaMenuButton', 'pwaInstallModal', 'pwaInstallStatus', 'pwaInstallSteps']) {
    elements[id] = { style: {}, hidden: false, disabled: false, attrs: {}, addEventListener(name, fn) { this[name] = fn; }, setAttribute(k,v) { this.attrs[k]=v; }, removeAttribute(k) { delete this.attrs[k]; }, replaceChildren(...nodes) { this.children=nodes; } };
  }
  let shown = 0;
  const context = {
    window: { navigator: {}, matchMedia: () => ({ matches: standalone, addEventListener() {} }), addEventListener: (name, fn) => { listeners[name] = fn; } },
    navigator: { userAgent: ua },
    document: { getElementById: id => elements[id], createElement: () => ({}) },
    sessionStorage: { getItem() { if (storageBlocked) throw Error(); }, setItem() { if (storageBlocked) throw Error(); } },
    setTimeout: fn => timers.push(fn),
    bootstrap: { Modal: { getInstance: () => null, getOrCreateInstance: () => ({ show() { shown++; } }) } }
  };
  vm.runInNewContext(functionSource + '\ninitPwaInstallBanner();', context);
  return { elements, listeners, timers, shown: () => shown };
}

test('iPhone/iPad/Android/desktop get an actionable guide without a native prompt', async () => {
  for (const [ua, expected] of [['iPhone', 'Safari'], ['Android', 'Chrome'], ['', 'Edge']]) {
    const app=setup({ua}); await app.elements.pwaMenuButton.click();
    assert.equal(app.shown(),1);
    assert.ok(app.elements.pwaInstallSteps.children.some(li=>li.textContent.includes(expected)));
  }
});

test('native prompt runs once, blocks duplicate clicks, then allows manual guidance', async () => {
  const app=setup();let calls=0,resolve;
  const choice=new Promise(r=>{resolve=r;});
  app.listeners.beforeinstallprompt({preventDefault(){},prompt:async()=>{calls++;},userChoice:choice});
  const pending=app.elements.pwaMenuButton.click();
  await app.elements.pwaMenuButton.click();assert.equal(calls,1);assert.equal(app.elements.pwaMenuButton.disabled,true);
  resolve({outcome:'dismissed'});await pending;
  assert.equal(app.elements.pwaMenuButton.disabled,false);assert.match(app.elements.pwaInstallStatus.textContent,/취소/);
  await app.elements.pwaMenuButton.click();assert.equal(calls,1);assert.equal(app.shown(),2);
});

test('prompt failure restores controls and explains manual installation', async () => {
  const app=setup();app.listeners.beforeinstallprompt({preventDefault(){},prompt:async()=>{throw Error('blocked');}});
  await app.elements.pwaMenuButton.click();assert.equal(app.elements.pwaMenuButton.disabled,false);assert.match(app.elements.pwaInstallStatus.textContent,/열지 못/);
});

test('standalone and completed installations hide installation affordances and delayed banner', () => {
  assert.equal(setup({standalone:true}).elements.pwaMenuButton.hidden,true);
  const app=setup();app.listeners.beforeinstallprompt({preventDefault(){}});app.listeners.appinstalled();app.timers.forEach(fn=>fn());
  assert.equal(app.elements.pwaMenuButton.hidden,true);assert.equal(app.elements.pwaInstallBanner.style.display,'none');
});

test('blocked session storage does not break installation or dismissing the banner', () => {
  const app=setup({storageBlocked:true});app.listeners.beforeinstallprompt({preventDefault(){}});app.timers.forEach(fn=>fn());
  assert.equal(app.elements.pwaInstallBanner.style.display,'block');app.elements.pwaDismissBtn.click();assert.equal(app.elements.pwaInstallBanner.style.display,'none');assert.equal(app.elements.pwaMenuButton.hidden,false);
});
