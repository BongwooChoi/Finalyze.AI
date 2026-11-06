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
  function channelFeedback(channel,text,tone = 'info') {
    const element = byId(channel === 'push' ? 'accountPushFeedback' : 'accountEmailFeedback');
    element.textContent = `${tone === 'success' ? '✓ ' : tone === 'error' ? '! ' : ''}${text}`;
    element.className = `account-channel-feedback account-feedback-${tone}`;
    element.hidden = !text;
  }
  function channelState(id,enabled) {
    const badge = byId(id);
    badge.textContent = enabled ? '켜짐' : '꺼짐';
    badge.classList.toggle('is-on',enabled);
  }
  function channelBusy(id,pending,label) {
    const button = byId(id);
    button.setAttribute('aria-busy',String(pending));
    button.textContent = pending ? label : id === 'emailEnableButton' && !byId('accountEmailConnect').hidden ? '계정 확인 중' : id.includes('Enable') ? '알림 켜기' : '알림 끄기';
    button.disabled = pending || (id === 'emailEnableButton' && (!account.mailAvailable || !byId('accountEmailConnect').hidden)) ||
      (id === 'pushEnableButton' && (!('Notification' in window) || !('PushManager' in window) || !('serviceWorker' in navigator) || !account.pushAvailable || Notification.permission === 'denied'));
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
    channelState('accountEmailState',account.emailEnabled);
    byId('accountEmailStatus').textContent = account.emailEnabled ? `${account.emailMasked}로 알림을 받습니다.` :
      account.mailAvailable ? '알림을 켜려면 아래에서 메일을 받을 Google 계정을 확인해주세요.' : '이메일 알림은 준비 중입니다.';
    const supported = 'Notification' in window && 'PushManager' in window && 'serviceWorker' in navigator;
    const subscription = supported ? await currentSubscription() : null;
    const id = await subscriptionId(subscription);
    const enabled = account.subscriptions.some(item => item.id === id);
    channelState('accountPushState',enabled);
    byId('pushEnableButton').hidden = enabled;
    byId('pushDisableButton').hidden = !enabled;
    byId('pushEnableButton').disabled = !supported || !account.pushAvailable || Notification.permission === 'denied';
    byId('accountPushStatus').textContent = enabled ? '이 기기에서 공시 알림을 받습니다.' : !supported ?
      '이 환경에서는 푸시를 사용할 수 없습니다. iPhone은 홈 화면에 추가한 앱에서 이용해주세요.' :
      Notification.permission === 'denied' ? '브라우저 설정에서 이 사이트의 알림을 허용해주세요.' :
      account.pushAvailable ? '이 기기는 알림이 꺼져 있습니다. 알림 켜기를 눌러 연결해주세요.' : '푸시 알림을 준비하고 있습니다.';
  }
  async function refresh() {
    const wasAuthenticated = account.authenticated;
    account = await api('/account');
    account.favorites ||= [];
    account.subscriptions ||= [];
    if(wasAuthenticated !== account.authenticated) document.dispatchEvent(new CustomEvent('account:changed',{detail:{authenticated:account.authenticated}}));
    await render();
  }
  async function perform(action,feedback) {
    if(busy) return;
    busy = true; renderCompany();
    if(feedback) {
      channelFeedback(feedback.channel,feedback.message,'pending');
      channelBusy(feedback.button,true,feedback.label);
    }
    byId('accountSignedIn').setAttribute('aria-busy','true');
    byId('accountSignedIn').inert = true;
    try { await action(); }
    catch(error) {
      if(feedback) channelFeedback(feedback.channel,error.message,'error');
      else message(error.message,true);
    }
    finally {
      busy = false; byId('accountSignedIn').inert = false; byId('accountSignedIn').setAttribute('aria-busy','false'); renderCompany();
      if(feedback) channelBusy(feedback.button,false);
    }
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
    channelBusy('emailEnableButton',false);
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
      channelBusy('emailEnableButton',true,'불러오는 중…');
      channelFeedback('email','메일 알림 연결을 준비하고 있습니다.','pending');
      byId('accountEmailConnect').scrollIntoView({block:'nearest',behavior:'instant'});
    }
    container.replaceChildren(); container.hidden = false;
    if(!account.enabled) { notify('로그인 기능을 준비하고 있습니다. 잠시 후 다시 이용해주세요.'); if(emailOptIn)channelBusy('emailEnableButton',false); return; }
    notify(emailOptIn ? '아래 버튼에서 Google 계정을 확인해주세요.' : loginForAnalysis ? '선택한 공시의 AI 분석을 위해 Google로 로그인해주세요.' : 'Google 로그인 후 AI 재무분석과 관심 기업 동기화를 이용할 수 있습니다.');
    await loadGoogle();
    if(attempt !== googleAttempt) return;
    const { nonce } = await api('/auth/challenge','POST',{});
    if(attempt !== googleAttempt) return;
    google.accounts.id.initialize({ client_id:account.clientId,nonce,auto_select:false,
      callback:async response => {
        if(attempt !== googleAttempt) return;
        const complete = async () => {
          notify(emailOptIn ? '메일 연결을 확인하고 있습니다.' : '로그인 정보를 확인하고 있습니다.');
          try {
            await api('/auth/google','POST',{ credential:response.credential,emailOptIn });
            container.replaceChildren(); container.hidden = true;
            await refresh();
            if(pendingFavorite) {
              await api('/account/favorites','POST',{corpCode:pendingFavorite.corp_code});
              pendingFavorite = null; await refresh();
            }
            if(emailOptIn) channelFeedback('email','이메일 알림을 켰습니다. 관심 기업의 새 공시를 메일로 알려드립니다.','success');
            else message('로그인했습니다. 관심 기업과 알림을 설정해보세요.');
            if(loginForAnalysis) { loginForAnalysis = false; modal.hide(); }
          } catch(error) {
            if(attempt !== googleAttempt) return;
            try { await prepareGoogle(emailOptIn); } catch {}
            notify(error.message,true);
            if(emailOptIn) channelFeedback('email',error.message,'error');
          }
        };
        if(emailOptIn) await perform(complete,{channel:'email',button:'emailEnableButton',label:'켜는 중…',message:'선택한 계정을 확인하고 메일 알림을 켜고 있습니다.'});
        else await complete();
      }
    });
    google.accounts.id.renderButton(container,{ theme:'outline',size:'large',shape:'pill',text:'continue_with',width:Math.max(200,Math.min(280,Math.floor(container.clientWidth || 280))) });
    if(emailOptIn) {
      channelBusy('emailEnableButton',false);
      channelFeedback('email','아래 Google 계정을 확인하면 메일 알림이 켜집니다.');
      byId('accountEmailConnect').scrollIntoView({block:'nearest',behavior:'instant'});
    }
  }
  async function show() {
    byId('accountModalTitle').textContent = loginForAnalysis ? 'AI 재무분석 시작하기' : '관심 기업 · 공시 알림';
    modal.show();
    channelFeedback('push',''); channelFeedback('email','');
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
    await perform(async () => {
      // Still in the user's click before the first await (required on iOS).
      const permission = await Notification.requestPermission();
      if(permission !== 'granted') {
        await render();
        channelFeedback('push',permission === 'denied' ? '알림 권한이 차단됐습니다. 크롬·Safari의 사이트 설정에서 알림을 허용해주세요.' : '알림 허용이 완료되지 않았습니다. 다시 알림 켜기를 눌러 허용해주세요.','error');
        return;
      }
      channelFeedback('push','이 기기를 푸시 알림에 연결하고 있습니다.','pending');
      const registration = await navigator.serviceWorker.ready;
      const base64 = account.pushPublicKey.replace(/-/g,'+').replace(/_/g,'/');
      const key = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length/4)*4,'=')),char => char.charCodeAt(0));
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing || await registration.pushManager.subscribe({ userVisibleOnly:true,applicationServerKey:key });
      try { await api('/account/push','POST',{ subscription:subscription.toJSON() }); }
      catch(error) { if(!existing) await subscription.unsubscribe(); throw error; }
      await refresh(); channelFeedback('push','이 기기의 푸시 알림을 켰습니다. 관심 기업의 새 공시를 알려드립니다.','success');
    },{channel:'push',button:'pushEnableButton',label:'켜는 중…',message:'알림 권한을 확인하고 있습니다. 허용 창이 뜨면 허용을 눌러주세요.'});
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
      await refresh(); channelFeedback('push','이 기기의 푸시 알림을 껐습니다. 다른 기기의 설정은 유지됩니다.','success');
    },{channel:'push',button:'pushDisableButton',label:'끄는 중…',message:'이 기기의 푸시 알림을 끄고 있습니다.'}));
    byId('emailEnableButton').addEventListener('click',() => prepareGoogle(true).catch(error => {
      message(error.message,true,'accountEmailMessage');
      channelFeedback('email',error.message,'error');
      channelBusy('emailEnableButton',false);
      byId('emailEnableButton').disabled = false;
      byId('emailEnableButton').textContent = '다시 연결';
    }));
    byId('emailConnectCancel').addEventListener('click',() => {
      closeEmailConnection();
      channelFeedback('email','메일 연결을 취소했습니다. 이메일 알림은 꺼져 있습니다.');
      byId('emailEnableButton').focus({preventScroll:true});
    });
    byId('emailDisableButton').addEventListener('click',() => perform(async () => {
      await api('/account/email','DELETE'); await refresh();
      channelFeedback('email','이메일 알림을 끄고 저장된 이메일 주소를 삭제했습니다.','success');
    },{channel:'email',button:'emailDisableButton',label:'끄는 중…',message:'이메일 알림을 끄고 있습니다.'}));
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
