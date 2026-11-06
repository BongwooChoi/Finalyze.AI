(() => {
  const byId=id=>document.getElementById(id);
  const labels={aiEnabled:'AI 분석 제공',memberDaily:'회원당 하루 분석',globalDaily:'전체 하루 분석',memberConcurrent:'회원당 동시 분석',globalConcurrent:'전체 동시 분석',intervalSeconds:'요청 간격(초)',maxSessions:'활성 세션',maxFavorites:'관심 기업',maxPush:'푸시 기기'};
  let account={},version=0,dirty=false,googleScript,attempt=0;
  const number=value=>new Intl.NumberFormat('ko-KR').format(value);
  function say(id,text,error=false){byId(id).textContent=text;byId(id).classList.toggle('error',error);}
  function loading(id,on){byId(id).disabled=on;byId(id).classList.toggle('is-loading',on);}
  async function api(path,method='GET',body){
    const response=await fetch('/api'+path,{method,cache:'no-store',headers:{'Content-Type':'application/json',...(account.csrfToken?{'X-CSRF-Token':account.csrfToken}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const result=await response.json();
    if(!response.ok) throw Object.assign(new Error(result.message || '요청을 처리하지 못했습니다.'),{status:response.status});
    return result;
  }
  function gate(text){byId('dashboard').hidden=true;byId('refreshButton').hidden=true;byId('loginGate').hidden=false;if(text)say('loginMessage',text);}
  function date(value){return value?new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',dateStyle:'short',timeStyle:'short'}):'아직 수집되지 않음';}
  function render(data){
    const {stats,settings,aiUsage}=data;version=settings.version;
    const values=settings.values;
    for(const [id,key] of Object.entries({memberCount:'members',newMemberCount:'new_members',signedInCount:'signed_in_members',emailCount:'email_members',pushCount:'push_members',deviceCount:'push_devices',favoriteCount:'favorites',queueCount:'queued_notifications'})) byId(id).textContent=number(stats[key]);
    byId('dayLabel').textContent=data.day+' · 한국 시간';
    byId('sessionCount').textContent=`세션 ${number(stats.sessions)}개 · 실시간 접속자와 다름`;
    byId('lastScan').textContent=date(stats.last_scan);
    byId('aiCount').textContent=aiUsage?`${number(aiUsage.used)} / ${number(values.globalDaily)}`:'확인 불가';
    byId('aiUsageNote').textContent=!aiUsage?'공유 저장소 연결을 확인해주세요.':!values.aiEnabled?'AI 분석 제공 중지':`진행 중 ${number(aiUsage.active)}건 · 허용 요청 기준`;
    byId('aiProgress').style.width=aiUsage && values.globalDaily?Math.min(100,aiUsage.used/values.globalDaily*100)+'%':'0%';
    for(const key of Object.keys(labels)){if(key==='aiEnabled')byId(key).checked=values[key];else byId(key).value=values[key];}
    byId('settingsVersion').textContent='설정 v'+version;
    const history=byId('historyList');history.replaceChildren();
    if(!data.history.length){const p=document.createElement('p');p.className='history-empty';p.textContent='아직 변경한 설정이 없습니다.';history.append(p);}
    for(const item of data.history){
      const row=document.createElement('div');row.className='history-item';const info=document.createElement('div');info.className='history-date';
      const title=document.createElement('strong');title.textContent='설정 v'+item.version;info.append(title,document.createTextNode(date(item.at)));
      const list=document.createElement('ul');
      for(const [key,label] of Object.entries(labels)){if(item.before[key]===item.after[key])continue;const li=document.createElement('li');const format=value=>typeof value==='boolean'?(value?'제공':'중지'):number(value);li.textContent=`${label}: ${format(item.before[key])} → ${format(item.after[key])}`;list.append(li);}
      if(!list.children.length){const li=document.createElement('li');li.textContent='동일한 설정을 다시 저장했습니다.';list.append(li);}row.append(info,list);history.append(row);
    }
    dirty=false;byId('loginGate').hidden=true;byId('dashboard').hidden=false;byId('refreshButton').hidden=false;
    say('pageMessage','마지막 확인 '+date(Date.now()));
  }
  async function refresh(){
    loading('refreshButton',true);
    byId('pageMessage').classList.add('is-loading');
    try{
      account=await api('/account');
      if(!account.authenticated || !account.admin){gate(account.authenticated?'관리자 권한을 확인하려면 지정된 Google 계정으로 다시 로그인해주세요.':undefined);say('pageMessage','관리자 전용 화면입니다.');return;}
      render(await api('/admin/dashboard'));
    }catch(error){if([401,403].includes(error.status))gate();else byId('refreshButton').hidden=false;say('pageMessage',error.message,true);}
    finally{loading('refreshButton',false);byId('pageMessage').classList.remove('is-loading');}
  }
  async function loadGoogle(){
    if(window.google?.accounts?.id)return;
    if(!googleScript)googleScript=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://accounts.google.com/gsi/client';script.async=true;script.onload=resolve;script.onerror=()=>{googleScript=null;script.remove();reject(new Error('Google 로그인을 불러오지 못했습니다.'));};document.head.append(script);});
    await googleScript;
  }
  async function prepareLogin(){
    const current=++attempt;loading('loginButton',true);
    try{
      account=await api('/account');if(!account.enabled)throw new Error('로그인 기능을 사용할 수 없습니다.');
      await loadGoogle();const {nonce}=await api('/auth/challenge','POST',{});if(current!==attempt)return;
      google.accounts.id.initialize({client_id:account.clientId,nonce,auto_select:false,callback:async response=>{
        if(current!==attempt)return;
        try{say('loginMessage','관리자 권한을 확인하고 있습니다.');await api('/auth/google','POST',{credential:response.credential,emailOptIn:false});byId('googleButton').replaceChildren();byId('googleButton').hidden=true;byId('loginButton').hidden=false;await refresh();}
        catch(error){await prepareLogin().catch(()=>{});say('loginMessage',error.message,true);}
      }});
      const container=byId('googleButton');container.replaceChildren();container.hidden=false;
      google.accounts.id.renderButton(container,{theme:'outline',size:'large',shape:'pill',text:'continue_with',width:260});byId('loginButton').hidden=true;
      say('loginMessage','아래 버튼에서 지정된 관리자 Google 계정을 선택해주세요.');
    }catch(error){say('loginMessage',error.message,true);}
    finally{loading('loginButton',false);}
  }
  byId('loginButton').addEventListener('click',prepareLogin);
  byId('refreshButton').addEventListener('click',()=>{if(!dirty || confirm('편집 중인 설정을 버리고 새로 불러올까요?'))refresh();});
  byId('settingsForm').addEventListener('input',()=>{dirty=true;say('saveMessage','아직 저장하지 않은 변경 사항이 있습니다.');});
  byId('settingsForm').addEventListener('submit',async event=>{
    event.preventDefault();loading('saveButton',true);byId('settingsFields').disabled=true;
    try{
      const values=Object.fromEntries(Object.keys(labels).map(key=>[key,key==='aiEnabled'?byId(key).checked:Number(byId(key).value)]));
      await api('/admin/settings','PUT',{version,values});dirty=false;await refresh();say('saveMessage','저장했습니다. 새로운 요청부터 적용됩니다.');
    }catch(error){say('saveMessage',error.message,true);if([401,403].includes(error.status))gate();}
    finally{byId('settingsFields').disabled=false;loading('saveButton',false);}
  });
  window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
  refresh();
})();
