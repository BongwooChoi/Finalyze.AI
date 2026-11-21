(() => {
  const byId=id=>document.getElementById(id);
  const labels={aiEnabled:'AI 분석 제공',memberDaily:'회원당 하루 분석',globalDaily:'전체 하루 분석',memberConcurrent:'회원당 동시 분석',globalConcurrent:'전체 동시 분석',intervalSeconds:'요청 간격(초)',maxSessions:'활성 세션',maxFavorites:'관심 기업',maxPush:'푸시 기기'};
  let account={},version=0,dirty=false,googleScript,attempt=0;
  let memberPage=1,memberPages=1,listAttempt=0,detailAttempt=0;
  let memberQuery={filter:'all',search:''};
  const number=value=>new Intl.NumberFormat('ko-KR').format(value);
  function say(id,text,error=false){byId(id).textContent=text;byId(id).classList.toggle('error',error);}
  function loading(id,on){byId(id).disabled=on;byId(id).classList.toggle('is-loading',on);}
  async function api(path,method='GET',body){
    const response=await fetch('/api'+path,{method,cache:'no-store',headers:{'Content-Type':'application/json',...(account.csrfToken?{'X-CSRF-Token':account.csrfToken}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const result=await response.json();
    if(!response.ok) throw Object.assign(new Error(result.message || '요청을 처리하지 못했습니다.'),{status:response.status});
    return result;
  }
  function gate(text){listAttempt++;detailAttempt++;byId('memberRows').replaceChildren();byId('memberDetailBody').replaceChildren();byId('memberDialog').close();byId('dashboard').hidden=true;byId('refreshButton').hidden=true;byId('loginGate').hidden=false;if(text)say('loginMessage',text);}
  function date(value){return value?new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',dateStyle:'short',timeStyle:'short'}):'아직 수집되지 않음';}
  function element(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
  function badge(text,on){return element('span',text,'state-badge'+(on?' on':''));}
  async function loadMembers(page=1){
    const current=++listAttempt;memberPage=page;
    byId('memberRows').replaceChildren();byId('memberPage').textContent='';
    byId('memberPrevious').disabled=byId('memberNext').disabled=true;
    byId('memberTableWrap').setAttribute('aria-busy','true');
    say('memberListMessage','회원 현황을 불러오고 있습니다.');byId('memberListMessage').classList.add('is-loading');
    const notes={push:'기기 수를 누르면 기기를 등록한 회원을 표시합니다. 한 회원이 여러 기기를 등록할 수 있습니다.',favorites:'관심 기업 등록 건수를 회원별로 나눠 표시합니다. 같은 기업을 여러 회원이 등록할 수 있습니다.',queued:'아직 전송을 기다리는 알림이 있는 회원입니다. 알림 건수와 회원 수는 다를 수 있습니다.',signedIn:'유효한 로그인 세션이 있는 회원입니다. 현재 접속 중이라는 뜻은 아닙니다.'};
    byId('memberListNote').textContent=notes[memberQuery.filter] || '이름·이메일 대신 서비스 전용 회원 식별자로 구분합니다.';
    try{
      const data=await api('/admin/members?'+new URLSearchParams({...memberQuery,page:String(page)}));
      if(current!==listAttempt)return;
      memberPage=data.page;memberPages=data.pages;
      for(const member of data.members){
        const row=element('tr');
        const link=element('button',member.id.slice(0,12)+'…','member-link');link.type='button';link.title=member.id;
        link.setAttribute('aria-label','회원 '+member.id.slice(0,12)+' 상세 보기');link.addEventListener('click',()=>showMember(member.id));
        const cells=[['회원',link],['가입일 · KST',date(member.createdAt)],['로그인 세션',member.sessions?number(member.sessions)+'개':'없음'],['메일',badge(member.emailEnabled?'켜짐':'꺼짐',member.emailEnabled)],['푸시 기기',number(member.devices)+'대'],['관심 기업',number(member.favorites)+'개'],['대기 알림',number(member.queued)+'건']];
        for(const [label,value] of cells){const cell=element('td');cell.dataset.label=label;cell.append(typeof value==='string'?document.createTextNode(value):value);row.append(cell);}
        byId('memberRows').append(row);
      }
      say('memberListMessage',data.total?`조건에 맞는 회원 ${number(data.total)}명 · 가입일 최신순 · ${date(data.asOf)} 기준`:'조건에 맞는 회원이 없습니다.');
      byId('memberPage').textContent=`${data.page} / ${data.pages} 페이지 · ${data.pageSize}명씩`;
      byId('memberPrevious').disabled=data.page<=1;byId('memberNext').disabled=data.page>=data.pages;
    }catch(error){if(current!==listAttempt)return;say('memberListMessage',error.message+' 조회 버튼으로 다시 시도해주세요.',true);if([401,403].includes(error.status))gate();}
    finally{if(current===listAttempt){byId('memberListMessage').classList.remove('is-loading');byId('memberTableWrap').setAttribute('aria-busy','false');}}
  }
  async function showMember(id){
    const current=++detailAttempt,dialog=byId('memberDialog'),body=byId('memberDetailBody');
    byId('memberDetailTitle').textContent='회원 '+id.slice(0,12)+'…';body.replaceChildren();
    say('memberDetailMessage','상세 현황을 불러오고 있습니다.');byId('memberDetailMessage').classList.add('is-loading');
    if(!dialog.open)dialog.showModal();
    try{
      const data=await api('/admin/members/'+encodeURIComponent(id));if(current!==detailAttempt || !dialog.open)return;
      const m=data.member,summary=element('dl',undefined,'detail-summary');
      for(const [title,value] of [['가입일',date(m.createdAt)],['메일 알림',m.emailEnabled?'켜짐':'꺼짐'],['로그인 세션',number(m.sessions)+'개'],['푸시 기기',number(m.devices)+'대'],['관심 기업',number(m.favorites)+'개'],['오늘 AI 분석',data.aiUsage?number(data.aiUsage.used)+'회':'확인 불가']]){const group=element('div');group.append(element('dt',title),element('dd',value));summary.append(group);}
      body.append(element('p',m.id,'member-full-id'),summary,element('p',`${data.day} 한국 시간 기준 · AI 횟수는 실패를 포함한 허용 요청 수입니다. 최근 접속 시각은 별도로 수집하지 않습니다.`,'muted small'));
      function section(title,items,empty){const block=element('section',undefined,'detail-section');block.append(element('h3',title));if(!items.length)block.append(element('p',empty,'muted small'));else {const list=element('ul',undefined,'detail-list');for(const item of items)list.append(element('li',item));block.append(list);}body.append(block);return block;}
      section('관심 기업',data.favorites.map(f=>`${f.name} (${f.stockCode}) · 등록 ${date(f.createdAt)}`),'등록한 관심 기업이 없습니다.');
      section('푸시 기기',data.devices.map((d,i)=>`기기 ${i+1} · 등록 ${date(d.createdAt)}`),'등록된 푸시 기기가 없습니다.');
      section('로그인 세션',data.sessions.map((s,i)=>`세션 ${i+1} · 만료 예정 ${date(s.expiresAt)}`),'유효한 로그인 세션이 없습니다.');
      const history=section('최근 알림 처리 · 최대 30건',[],'저장된 알림 처리 기록이 없습니다.');
      if(data.deliveries.length){history.lastChild.remove();const list=element('ul',undefined,'delivery-list');const statuses={pending:'대기',sending:'전송 처리 중',sent:'발송 서비스 접수',failed:'실패 · 재시도 종료',skipped:'조건 변경으로 생략'};
        for(const d of data.deliveries){const item=element('li');item.append(element('strong',`${d.company} · ${d.channel==='email'?'메일':'푸시'}`),badge(statuses[d.status] || '확인 필요',d.status==='sent'),element('p',d.report),element('small',`공시 확인 ${date(d.observedAt)} · 전송 시도 ${d.attempts}회${d.status==='pending' && d.nextAttempt?` · 재시도 가능 ${date(d.nextAttempt)}`:''}`));list.append(item);}history.append(list);}
      history.append(element('p','발송 서비스 접수는 수신함 도착이나 열람 확인이 아닙니다. 푸시는 기기마다 별도 기록하며, 지난 기록은 보관 정책에 따라 삭제될 수 있습니다.','muted small'));
      say('memberDetailMessage','마지막 확인 '+date(data.asOf));
    }catch(error){if(current!==detailAttempt)return;say('memberDetailMessage',error.message,true);if([401,403].includes(error.status))gate();}
    finally{if(current===detailAttempt)byId('memberDetailMessage').classList.remove('is-loading');}
  }
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
      await loadMembers(memberPage);
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
  document.querySelectorAll('[data-member-filter]').forEach(button=>button.addEventListener('click',()=>{
    memberQuery={filter:button.dataset.memberFilter,search:''};byId('memberFilter').value=memberQuery.filter;byId('memberSearch').value='';
    loadMembers(1);byId('membersHeading').focus();
  }));
  byId('memberFilters').addEventListener('submit',event=>{event.preventDefault();memberQuery={filter:byId('memberFilter').value,search:byId('memberSearch').value.trim()};loadMembers(1);});
  byId('memberFilter').addEventListener('change',()=>byId('memberFilters').requestSubmit());
  byId('memberPrevious').addEventListener('click',()=>{if(memberPage>1)loadMembers(memberPage-1);});
  byId('memberNext').addEventListener('click',()=>{if(memberPage<memberPages)loadMembers(memberPage+1);});
  byId('closeMember').addEventListener('click',()=>byId('memberDialog').close());
  byId('memberDialog').addEventListener('close',()=>{detailAttempt++;byId('memberDetailBody').replaceChildren();});
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
