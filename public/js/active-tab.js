(() => {
  if (location.origin !== document.currentScript?.dataset.origin || !crypto.randomUUID) return;
  const endpoint = 'https://bongwoo-projects.vercel.app/api/presence';
  const storageKey = 'workshop-active-tab';
  let timer, lastPulse = 0, release, generation = 0;

  function start(tab) {
    function send() {
      if (document.visibilityState !== 'visible' || Date.now()-lastPulse < 5000) return;
      lastPulse = Date.now();
      fetch(endpoint, {method:'POST', body:tab, credentials:'omit', referrerPolicy:'origin',
        signal:AbortSignal.timeout(8000)}).catch(() => {});
    }
    send();
    document.addEventListener('visibilitychange',send);
    timer = setInterval(send,25_000);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange',send); };
  }

  async function open() {
    const current = ++generation;
    let tab = crypto.randomUUID();
    if (!navigator.locks) { release = start(tab); return; }
    // Reloads reuse the tab slot. A duplicated tab inherits storage but cannot own the same lock.
    try { tab = sessionStorage.getItem(storageKey) || tab; } catch {}
    async function hold(lock) {
      if (current !== generation) return;
      if (!lock) {
        tab = crypto.randomUUID();
        return navigator.locks.request(storageKey + tab,hold);
      }
      try { sessionStorage.setItem(storageKey,tab); } catch {}
      const stop = start(tab);
      await new Promise(resolve => { release = () => { stop(); resolve(); }; });
    }
    await navigator.locks.request(storageKey + tab,{ifAvailable:true},hold);
  }
  addEventListener('pagehide',() => { generation++; release?.(); });
  addEventListener('pageshow',event => { if (event.persisted) open(); });
  open();
})();
