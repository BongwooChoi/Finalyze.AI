(() => {
  const $=id=>document.getElementById(id),number=n=>new Intl.NumberFormat('ko-KR').format(n);
  const names={'bongwoo-projects':'프로젝트 포털','bangbang':'뱅뱅밥','finalyze-ai':'Finalyze.AI','coin-trader-dashboard':'Coin Trader','ytchoi':'ytchoi'};
  const clickNames={'bangbang':'뱅뱅밥','finalyze':'Finalyze.AI','finalyze-telegram':'Finalyze.AI 텔레그램','coin':'Coin Trader','coin-telegram':'Coin Trader 텔레그램'};
  let account={},data,metric='visitors',googleScript,attempt=0,loading=false,selected='all';
  const date=value=>value?new Date(Number(value)).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',dateStyle:'short',timeStyle:'short'}):'아직 수집되지 않음';
  function say(text,error=false,busy=false){$('message').textContent=text;$('message').classList.toggle('error',error);$('message').classList.toggle('busy',busy);}
  function gate(text){data=null;$('dashboard').hidden=true;$('syncButton').hidden=true;$('loginGate').hidden=false;if(text)$('loginMessage').textContent=text;}
  async function api(path,method='GET',body){
    const response=await fetch('/api'+path,{method,cache:'no-store',signal:AbortSignal.timeout(method==='POST'?65000:20000),headers:{'Content-Type':'application/json',...(account.csrfToken?{'X-CSRF-Token':account.csrfToken}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const result=await response.json();if(!response.ok)throw Object.assign(Error(result.message||'요청을 처리하지 못했습니다.'),{status:response.status});return result;
  }
  function element(tag,text,className){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;}
  function rowsFor(id){return data.daily.filter(r=>id==='all'||r.project_id===id);}
  function sum(rows,key){return rows.reduce((n,r)=>n+Number(r[key]),0);}
  function projectName(p){return names[p.name]||p.name;}
  function render(){
    const selectedRows=rowsFor(selected),byDay=new Map();
    for(const row of selectedRows){const value=byDay.get(row.day)||{visitors:0,pageviews:0,projects:0};value.visitors+=Number(row.visitors);value.pageviews+=Number(row.pageviews);value.projects++;byDay.set(row.day,value);}
    $('visitors').textContent=selectedRows.length?number(sum(selectedRows,'visitors')):'—';
    $('pageviews').textContent=selectedRows.length?number(sum(selectedRows,'pageviews')):'—';
    $('coverage').textContent=number(byDay.size)+'일';
    $('period').textContent=data.from+' ~ '+data.until+' · UTC';
    $('coverageNote').textContent=byDay.size?'수집되지 않은 날짜는 합계에서 제외합니다.':'아직 보관된 데이터가 없습니다.';
    const chart=$('chart');chart.replaceChildren();const dates=[];
    for(let n=Date.parse(data.from);n<=Date.parse(data.until);n+=86400000)dates.push(new Date(n).toISOString().slice(0,10));
    const max=Math.max(1,...[...byDay.values()].map(r=>r[metric]));
    if(!byDay.size)chart.append(element('p','이 기간에 보관된 통계가 없습니다.','chart-empty'));
    else for(const day of dates){const value=byDay.get(day),bar=element('div',undefined,'bar'+(value?'':' empty'));bar.style.height=value?Math.max(1,value[metric]/max*100)+'%':'7px';bar.title=day+' · '+(value?number(value[metric])+' · '+value.projects+'개 서비스':'데이터 없음');chart.append(bar);}
    chart.setAttribute('aria-label',`${data.from}부터 ${data.until}까지 ${metric==='visitors'?'일별 방문자 합계':'페이지 조회'} 추이. 상세 수치는 일별 데이터 표에서 확인할 수 있습니다.`);
    $('chartStart').textContent=data.from;$('chartEnd').textContent=data.until+' · 사선: 데이터 없음';
    $('services').replaceChildren();
    for(const p of data.projects.filter(p=>selected==='all'||p.project_id===selected)){
      const rows=rowsFor(p.project_id),today=rows.find(r=>r.day===data.until),row=element('tr'),name=element('td');
      const title=element('strong',projectName(p));if(p.url&&/^https:\/\//.test(p.url)){const link=element('a');link.href=p.url;link.target='_blank';link.rel='noopener noreferrer';link.append(title);name.append(link);}else name.append(title);
      name.append(element('small',p.name));row.append(name,element('td',today?number(today.visitors):'—'),element('td',rows.length?number(sum(rows,'visitors')):'—'),element('td',rows.length?number(sum(rows,'pageviews')):'—'));
      const state=element('td');let label=p.sync_status==='ok'?'수집 완료':p.sync_status==='disabled'?'Analytics 미설정':p.sync_status==='no_data'?'원본 방문 데이터 없음':p.sync_status==='error'?'수집 실패 · 이전 값 유지':'수집 대기';
      if(!p.active)label='이전 프로젝트 · 보관 중';
      state.append(element('span',label,'state'+(p.sync_status==='error'?' error':'')),element('small',date(p.last_success)));
      row.append(state);$('services').append(row);
    }
    const counts=Object.fromEntries(Object.keys(clickNames).map(id=>[id,0]));for(const r of data.clicks)if(r.destination in counts)counts[r.destination]+=Number(r.clicks);
    const highest=Math.max(1,...Object.values(counts));$('clickRows').replaceChildren();
    for(const [id,label] of Object.entries(clickNames)){const row=element('div',undefined,'click-row'),track=element('div',undefined,'click-track'),fill=element('div',undefined,'click-fill');fill.style.width=(counts[id]/highest*100)+'%';track.append(fill);row.append(element('span',label),track,element('strong',number(counts[id])));$('clickRows').append(row);}
    $('dailyRows').replaceChildren();
    for(const day of [...dates].reverse()){const row=element('tr'),value=byDay.get(day);row.append(element('td',day),element('td',value?number(value.visitors):'—'),element('td',value?number(value.pageviews):'—'),element('td',value?value.projects+'개':'수집된 데이터 없음'));$('dailyRows').append(row);}
    $('archiveStatus').textContent='마지막 수집 완료: '+date(data.sync?.finished_at)+' · 일별 원본: Vercel Web Analytics · 보관: 독립 Neon DB';
    $('loginGate').hidden=true;$('dashboard').hidden=false;$('syncButton').hidden=false;
    const failed=data.projects.filter(p=>p.active&&p.sync_status==='error').length;
    const stale=!data.sync?.last_success||Date.now()-Number(data.sync.last_success)>36*3600000;
    const syncFailed=data.sync?.status==='error';
    say(failed?`${failed}개 서비스의 수집에 실패했습니다. 마지막으로 저장한 값을 표시합니다.`:syncFailed?'최근 수집에 실패했습니다. 이전 보관 데이터를 표시합니다.':stale?'최근 수집이 확인되지 않습니다. 최신 통계 가져오기를 눌러 확인해주세요.':data.sync?.status==='running'?'수집이 진행 중입니다. 이전 보관 데이터를 표시합니다.':'보관 데이터 기준 · 마지막 확인 '+date(data.generatedAt),Boolean(failed||stale||syncFailed));
  }
  async function refresh(){
    account=await api('/account');
    if(!account.authenticated||!account.admin){gate(account.authenticated?'지정된 관리자 Google 계정으로 다시 로그인해주세요.':undefined);say('관리자 전용 화면입니다.');return;}
    $('syncButton').hidden=false;
    data=await api('/admin/traffic?days='+$('range').value);
    const select=$('project');select.replaceChildren(element('option','전체 서비스'));select.firstChild.value='all';
    for(const p of data.projects){const option=element('option',projectName(p));option.value=p.project_id;select.append(option);}
    if(!data.projects.some(p=>p.project_id===selected))selected='all';select.value=selected;render();
  }
  async function run(action){
    if(loading)return;loading=true;$('syncButton').disabled=true;$('syncButton').setAttribute('aria-busy','true');$('range').disabled=true;
    try{say('통계를 확인하고 있습니다.',false,true);await action();}
    catch(error){if([401,403].includes(error.status))gate();say(error.name==='TimeoutError'?'응답이 늦어지고 있습니다. 잠시 후 다시 확인해주세요.':error.message,true);}
    finally{loading=false;$('syncButton').disabled=false;$('syncButton').removeAttribute('aria-busy');$('range').disabled=false;}
  }
  async function login(){
    const current=++attempt;$('loginButton').disabled=true;
    try{
      account=await api('/account');if(!account.enabled)throw Error('로그인을 사용할 수 없습니다.');
      if(!window.google?.accounts?.id){if(!googleScript)googleScript=new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='https://accounts.google.com/gsi/client';s.async=true;s.onload=resolve;s.onerror=()=>{googleScript=null;s.remove();reject(Error('Google 로그인을 불러오지 못했습니다.'));};document.head.append(s);});await googleScript;}
      const {nonce}=await api('/auth/challenge','POST',{});if(current!==attempt)return;
      google.accounts.id.initialize({client_id:account.clientId,nonce,auto_select:false,callback:async response=>{
        if(current!==attempt)return;
        try{await api('/auth/google','POST',{credential:response.credential,emailOptIn:false});$('googleButton').replaceChildren();$('googleButton').hidden=true;$('loginButton').hidden=false;await run(refresh);}
        catch(error){$('loginMessage').textContent=error.message;$('googleButton').hidden=true;$('loginButton').hidden=false;}
      }});
      const container=$('googleButton');container.replaceChildren();container.hidden=false;
      google.accounts.id.renderButton(container,{theme:'outline',size:'large',shape:'pill',text:'continue_with',width:260});$('loginButton').hidden=true;
    }catch(error){$('loginMessage').textContent=error.message;}finally{$('loginButton').disabled=false;}
  }
  $('loginButton').addEventListener('click',login);
  $('range').addEventListener('change',()=>run(refresh));
  $('project').addEventListener('change',()=>{selected=$('project').value;if(data)render();});
  document.querySelectorAll('[data-metric]').forEach(button=>button.addEventListener('click',()=>{metric=button.dataset.metric;document.querySelectorAll('[data-metric]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));if(data)render();}));
  $('syncButton').addEventListener('click',()=>run(async()=>{
    say('Vercel에서 최신 통계를 가져오는 중입니다.',false,true);const result=await api('/admin/traffic/sync','POST',{});await refresh();
    say(result.status==='partial'?`${result.success}개 서비스 갱신, ${result.failed}개 수집 실패. 실패한 서비스는 이전 값을 유지합니다.`:`${result.success}개 서비스의 최신 통계를 저장했습니다.`,result.status==='partial');
  }));
  run(refresh);
})();
