(() => {
  let account = { authenticated:false,favorites:[] };
  let company = null;
  let pendingFavorite = null;
  let googleScript;
  let modal;
  let busy = false;
  let loginForAnalysis = false;
  let googleAttempt = 0;
  const byId = id => document.getElementById(id);
  function message(text,error = false,target = 'accountMessage') {
    const element = byId(target);
    element.textContent = text;
    element.classList.toggle('account-error',error);
  }
  async function api(path,method = 'GET',body) {
    const response = await fetch(`/api${path}`,{ method,headers:{ 'Content-Type':'application/json',
      ...(account.csrfToken ? {'X-CSRF-Token':account.csrfToken} : {}) },
      ...(body === undefined ? {} : {body:JSON.stringify(body)}) });
    const result = await response.json();
    if(!response.ok) throw new Error(result.message || '요청을 처리하지 못했습니다. 다시 시도해주세요.');
    return result;
  }
  async function currentSubscription() {
    if(!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
    const registration = await navigator.serviceWorker.getRegistration();
    return registration ? registration.pushManager.getSubscription() : null;
  }
  async function subscriptionId(subscription) {
    if(!subscription) return '';
    const hash = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(subscription.endpoint));
    return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2,'0')).join('');
  }
  function renderCompany() {
    const button = byId('companyFavoriteButton');
    button.hidden = !company || !/^\d{6}$/.test(company.stock_code || '');
    const selected = account.authenticated && account.favorites.some(item => item.corp_code === company?.corp_code);
    button.textContent = selected ? '★ 관심 기업' : '☆ 관심 기업 등록';
    button.setAttribute('aria-pressed',String(Boolean(selected)));
    button.classList.toggle('is-favorite',Boolean(selected));
    button.disabled = busy;
  }
  function renderFavorites() {
    const list = byId('accountFavorites');
    list.replaceChildren();
    if(!account.favorites.length) {
      const empty = document.createElement('p');
      empty.className = 'account-note';
      empty.textContent = '기업을 검색한 뒤 ☆ 관심 기업 등록을 눌러보세요.';
      list.append(empty);
    }
    account.favorites.forEach(favorite => {
      const item = document.createElement('li');
      const open = document.createElement('button');
      open.type = 'button'; open.className = 'account-favorite-open';
      const name = document.createElement('strong'); name.textContent = favorite.corp_name;
      const stock = document.createElement('span'); stock.textContent = favorite.stock_code;
      open.append(name,stock);
      open.addEventListener('click',() => {
        modal.hide();
        document.dispatchEvent(new CustomEvent('favorite:open',{ detail:favorite }));
      });
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'account-favorite-remove'; remove.textContent = '해제';
      remove.setAttribute('aria-label',`${favorite.corp_name} 관심 기업 해제`);
      remove.addEventListener('click',() => perform(async () => {
        await api(`/account/favorites/${favorite.corp_code}`,'DELETE');
        await refresh(); message('관심 기업에서 해제했습니다.');
      }));
      item.append(open,remove); list.append(item);
    });
  }
  async function render() {
    byId('accountMenuButton').textContent = account.authenticated ? `관심 기업 ${account.favorites.length}` : '로그인';
    byId('accountSignedIn').hidden = !account.authenticated;
    byId('accountSignedOut').hidden = account.authenticated;
    const adminLink=byId('adminMenuLink');if(adminLink)adminLink.hidden=!account.admin;
    const limitsNote=byId('accountLimitsNote');
    if(limitsNote && account.limits)limitsNote.textContent=`관심 기업 ${account.limits.maxFavorites}개 · 푸시 기기 ${account.limits.maxPush}개 · 로그인 환경 ${account.limits.maxSessions}개까지 등록할 수 있습니다.`;
    renderCompany();
    if(!account.authenticated || account.emailEnabled) closeEmailConnection();
    if(!account.authenticated) return;
    renderFavorites();
    byId('emailEnableButton').disabled = !account.mailAvailable;
    byId('emailEnableButton').hidden = account.emailEnabled;
    byId('emailDisableButton').hidden = !account.emailEnabled;
    byId('accountEmailStatus').textContent = account.emailEnabled ? `${account.emailMasked}로 알림을 받습니다.` :
      account.mailAvailable ? 'Google 계정의 이메일로 공시 알림을 받을 수 있습니다.' : '이메일 알림은 준비 중입니다.';
    const supported = 'Notification' in window && 'PushManager' in window && 'serviceWorker' in navigator;
    const subscription = supported ? await currentSubscription() : null;
    const id = await subscriptionId(subscription);
    const enabled = account.subscriptions.some(item => item.id === id);
    byId('pushEnableButton').hidden = enabled;
    byId('pushDisableButton').hidden = !enabled;
    byId('pushEnableButton').disabled = !supported || !account.pushAvailable || Notification.permission === 'denied';
    byId('accountPushStatus').textContent = enabled ? '이 기기에서 공시 알림을 받습니다.' : !supported ?
      '이 환경에서는 푸시를 사용할 수 없습니다. iPhone은 홈 화면에 추가한 앱에서 이용해주세요.' :
      Notification.permission === 'denied' ? '브라우저 설정에서 이 사이트의 알림을 허용해주세요.' :
      account.pushAvailable ? '허용한 기기에서 관심 기업의 새 실적 공시를 알려드립니다.' : '푸시 알림을 준비하고 있습니다.';
  }
  async function refresh() {
    const wasAuthenticated = account.authenticated;
    account = await api('/account');
    account.favorites ||= [];
    account.subscriptions ||= [];
    if(wasAuthenticated !== account.authenticated) document.dispatchEvent(new CustomEvent('account:changed',{detail:{authenticated:account.authenticated}}));
    await render();
  }
  async function perform(action) {
    if(busy) return;
    busy = true; renderCompany();
    byId('accountSignedIn').setAttribute('aria-busy','true');
    byId('accountSignedIn').inert = true;
    try { await action(); }
    catch(error) { message(error.message,true); }
    finally { busy = false; byId('accountSignedIn').inert = false; byId('accountSignedIn').setAttribute('aria-busy','false'); renderCompany(); }
  }
  async function loadGoogle() {
    if(window.google?.accounts?.id) return;
    if(!googleScript) googleScript = new Promise((resolve,reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client'; script.async = true;
      script.onload = resolve;
      script.onerror = () => { script.remove(); googleScript = null; reject(new Error('Google 로그인을 불러오지 못했습니다.')); };
      document.head.append(script);
    });
    await googleScript;
  }
  function closeEmailConnection() {
    googleAttempt++;
    byId('accountEmailConnect').hidden = true;
    byId('googleEmailButton').replaceChildren();
    byId('googleEmailButton').hidden = true;
    byId('emailEnableButton').setAttribute('aria-expanded','false');
    byId('emailEnableButton').disabled = !account.mailAvailable;
    byId('emailEnableButton').textContent = '메일 연결';
  }
  async function prepareGoogle(emailOptIn = false) {
    if(!emailOptIn) closeEmailConnection();
    const attempt = ++googleAttempt;
    const container = byId(emailOptIn ? 'googleEmailButton' : 'googleAccountButton');
    const notify = (text,error = false) => message(text,error,emailOptIn ? 'accountEmailMessage' : 'accountMessage');
    if(emailOptIn) {
      byId('accountEmailConnect').hidden = false;
      byId('emailEnableButton').setAttribute('aria-expanded','true');
      byId('emailEnableButton').disabled = true;
      byId('emailEnableButton').textContent = '계정 선택 중';
      byId('accountEmailConnect').scrollIntoView({block:'nearest',behavior:'instant'});
    }
    container.replaceChildren(); container.hidden = false;
    if(!account.enabled) { notify('로그인 기능을 준비하고 있습니다. 잠시 후 다시 이용해주세요.'); return; }
    notify(emailOptIn ? '아래 버튼에서 Google 계정을 확인해주세요.' : loginForAnalysis ? '선택한 공시의 AI 분석을 위해 Google로 로그인해주세요.' : 'Google 로그인 후 AI 재무분석과 관심 기업 동기화를 이용할 수 있습니다.');
    await loadGoogle();
    if(attempt !== googleAttempt) return;
    const { nonce } = await api('/auth/challenge','POST',{});
    if(attempt !== googleAttempt) return;
    google.accounts.id.initialize({ client_id:account.clientId,nonce,auto_select:false,
      callback:async response => {
        if(attempt !== googleAttempt) return;
        notify(emailOptIn ? '메일 연결을 확인하고 있습니다.' : '로그인 정보를 확인하고 있습니다.');
        try {
          await api('/auth/google','POST',{ credential:response.credential,emailOptIn });
          container.replaceChildren(); container.hidden = true;
          await refresh();
          if(pendingFavorite) {
            await api('/account/favorites','POST',{corpCode:pendingFavorite.corp_code});
            pendingFavorite = null; await refresh();
          }
          message(emailOptIn ? '이메일 알림을 켰습니다.' : '로그인했습니다. 관심 기업과 알림을 설정해보세요.');
          if(loginForAnalysis) { loginForAnalysis = false; modal.hide(); }
        } catch(error) { if(attempt !== googleAttempt) return; try { await prepareGoogle(emailOptIn); } catch {} notify(error.message,true); }
      }
    });
    google.accounts.id.renderButton(container,{ theme:'outline',size:'large',shape:'pill',text:'continue_with',width:Math.max(200,Math.min(280,Math.floor(container.clientWidth || 280))) });
    if(emailOptIn) byId('accountEmailConnect').scrollIntoView({block:'nearest',behavior:'instant'});
  }
  async function show() {
    byId('accountModalTitle').textContent = loginForAnalysis ? 'AI 재무분석 시작하기' : '관심 기업 · 공시 알림';
    modal.show();
    message('계정 정보를 확인하고 있습니다.');
    try {
      await refresh();
      if(account.authenticated) message('관심 기업의 정기보고서·잠정실적을 알려드립니다.');
      else await prepareGoogle();
    } catch(error) { message(error.message,true); }
  }
  async function toggleCompany() {
    if(!company) return;
    if(!account.authenticated) { pendingFavorite = company; await show(); return; }
    await perform(async () => {
      const selected = account.favorites.some(item => item.corp_code === company.corp_code);
      await api(selected ? `/account/favorites/${company.corp_code}` : '/account/favorites',selected ? 'DELETE' : 'POST',selected ? undefined : {corpCode:company.corp_code});
      await refresh();
      if(typeof showToast === 'function') showToast(selected ? '관심 기업에서 해제했습니다.' : '관심 기업에 등록했습니다.');
    });
  }
  async function enablePush() {
    // Request permission directly from the user's click, before other awaited work (required on iOS).
    const permission = Notification.requestPermission();
    await perform(async () => {
      if(await permission !== 'granted') { message('알림을 허용하면 이 기기에서 푸시를 받을 수 있습니다.'); return; }
      const registration = await navigator.serviceWorker.ready;
      const base64 = account.pushPublicKey.replace(/-/g,'+').replace(/_/g,'/');
      const key = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length/4)*4,'=')),char => char.charCodeAt(0));
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing || await registration.pushManager.subscribe({ userVisibleOnly:true,applicationServerKey:key });
      try { await api('/account/push','POST',{ subscription:subscription.toJSON() }); }
      catch(error) { if(!existing) await subscription.unsubscribe(); throw error; }
      await refresh(); message('이 기기에서 공시 푸시 알림을 받습니다.');
    });
  }
  document.addEventListener('DOMContentLoaded',() => {
    modal = new bootstrap.Modal(byId('accountModal'));
    byId('accountModal').addEventListener('hidden.bs.modal',() => { loginForAnalysis = false; closeEmailConnection(); });
    byId('accountMenuButton').addEventListener('click',show);
    byId('companyFavoriteButton').addEventListener('click',toggleCompany);
    byId('pushEnableButton').addEventListener('click',enablePush);
    byId('pushDisableButton').addEventListener('click',() => perform(async () => {
      const subscription = await currentSubscription();
      if(subscription) { await api('/account/push','DELETE',{endpoint:subscription.endpoint}); await subscription.unsubscribe(); }
      await refresh(); message('이 기기의 푸시 알림을 껐습니다.');
    }));
    byId('emailEnableButton').addEventListener('click',() => prepareGoogle(true).catch(error => {
      message(error.message,true,'accountEmailMessage');
      byId('emailEnableButton').disabled = false;
      byId('emailEnableButton').textContent = '다시 연결';
    }));
    byId('emailConnectCancel').addEventListener('click',() => {
      closeEmailConnection();
      byId('emailEnableButton').focus({preventScroll:true});
    });
    byId('emailDisableButton').addEventListener('click',() => perform(async () => { await api('/account/email','DELETE'); await refresh(); message('이메일 알림을 끄고 저장된 이메일을 삭제했습니다.'); }));
    byId('accountLogoutButton').addEventListener('click',() => perform(async () => {
      const subscription = await currentSubscription();
      await api('/auth/logout','POST',{endpoint:subscription?.endpoint});
      if(subscription) await subscription.unsubscribe();
      window.google?.accounts?.id?.disableAutoSelect();
      await refresh(); await prepareGoogle(); message('이 기기에서 로그아웃했습니다.');
    }));
    byId('accountDeleteButton').addEventListener('click',() => {
      if(!confirm('계정, 관심 기업, 모든 기기의 알림 설정을 삭제할까요?')) return;
      perform(async () => {
        const subscription = await currentSubscription();
        await api('/account','DELETE',{confirm:true});
        if(subscription) await subscription.unsubscribe();
        await refresh(); await prepareGoogle(); message('계정과 저장된 정보를 삭제했습니다.');
      });
    });
    refresh().catch(() => { byId('accountMenuButton').textContent = '로그인'; });
  });
  window.FinalyzeAccount = {
    setCompany(value) { company = value; if(byId('companyFavoriteButton')) renderCompany(); },
    async analysisAccess() { await refresh(); return {authenticated:account.authenticated,csrfToken:account.csrfToken}; },
    async openAnalysisLogin() {
      loginForAnalysis = true; await show();
      if(account.authenticated) { loginForAnalysis = false; modal.hide(); }
    }
  };
})();
