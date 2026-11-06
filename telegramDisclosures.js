const {getFeaturedStockCodes,reportType}=require('./recentDisclosures');
const {parseProvisionalFinancials,readDisclosureXml}=require('./provisionalFinancials');
const html=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function telegramConfig(env=process.env) {
  const token=env.TELEGRAM_BOT_TOKEN || '',chat=env.TELEGRAM_CHAT_ID || '';
  return {token,chat,origin:env.APP_ORIGIN || 'https://finalyze-ai.vercel.app',
    enabled:env.TELEGRAM_ENABLED==='true' && /^\d{5,15}:[A-Za-z0-9_-]{30,100}$/.test(token) && /^(?:-100\d{5,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(chat)};
}
function change(current,previous) {
  if(!Number.isFinite(current)||!Number.isFinite(previous)) return '';
  if(previous<0) return current>0 ? '흑자전환' : current===0 ? '손익분기' : current>previous ? '적자축소' : current<previous ? '적자확대' : '변동 없음';
  if(previous===0) return current===0 ? '변동 없음' : '직전 수치 0';
  if(current<0) return '적자전환';
  const value=(current-previous)/previous*100;
  return `${value>0?'+':''}${value.toFixed(1)}%`;
}
function formatTelegramDisclosure(event,chartData,origin='https://finalyze-ai.vercel.app') {
  const type=reportType(event.report_nm)||'실적 공시';
  const title=String(event.report_nm).trim().slice(0,250);
  const date=event.rcept_dt.replace(/^(\d{4})(\d{2})(\d{2})$/,'$1.$2.$3');
  const lines=[`📊 <b>[${html(type)}] ${html(String(event.corp_name).slice(0,80))} (${html(event.stock_code)})</b>`,html(title),`공시일 ${html(date)}`];
  if(chartData?.labels?.current) lines.push(`기간 ${html(chartData.labels.current)}`);
  const unit=chartData?.unit;
  if(['원','천원','백만원','억원','조원'].includes(unit)) {
    for(const metric of (chartData.metrics || []).slice(0,3)) {
      if(!Number.isFinite(metric.current)) continue;
      const comparisons=[['전기',metric.previous],['전년',metric.yearAgo]].map(([label,value])=>{const text=change(metric.current,value);return text?`${label} ${text}`:'';}).filter(Boolean);
      const amount=metric.current.toLocaleString('ko-KR',{maximumFractionDigits:2});
      lines.push(`• ${html(metric.name)} <b>${html(amount)}${unit}</b>${comparisons.length?` (${comparisons.join(' · ')})`:''}`);
    }
    lines.push('※ 증감률은 표시 수치 기준 계산');
  }
  lines.push('',type==='잠정실적'?'※ 잠정치는 확정 실적과 다를 수 있습니다.':'', '출처: 금융감독원 OPEN DART');
  const params=new URLSearchParams({corp:event.corp_code,name:event.corp_name,rcept:event.rcept_no});
  return {text:lines.filter((line,index,array)=>line!=='' || array[index-1]!=='').join('\n'),parse_mode:'HTML',
    link_preview_options:{is_disabled:true},allow_paid_broadcast:false,
    reply_markup:{inline_keyboard:[[{text:'DART 원문',url:`https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${event.rcept_no}`},
      {text:'차트·AI 분석 보기',url:`${new URL(origin).origin}/?${params}`}]]}};
}

function createTelegramApi({token,fetchImpl=fetch}) {
  return async function call(method,payload) {
    if(!['sendMessage','getMe','getChat','getChatMember'].includes(method)) throw new Error('TELEGRAM_METHOD_UNSUPPORTED');
    let response,body;
    try {
      response=await fetchImpl(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)});
      body=await response.json();
    } catch { throw Object.assign(new Error('TELEGRAM_DELIVERY_UNCERTAIN'),{uncertain:true}); }
    if(!response.ok || body.ok!==true) {
      const code=Number(body.error_code || response.status);
      throw Object.assign(new Error('TELEGRAM_REQUEST_REJECTED'),{statusCode:code,retryAfter:code===429?Math.max(1,Math.min(86400,Number(body.parameters?.retry_after)||60)):0,uncertain:code>=500});
    }
    if(method==='sendMessage' && !Number.isSafeInteger(body.result?.message_id)) {
      throw Object.assign(new Error('TELEGRAM_DELIVERY_UNCERTAIN'),{uncertain:true});
    }
    return body.result;
  };
}

function createTelegramBroadcast({config=telegramConfig(),store,companies,fetchDocument,api=createTelegramApi({token:config.token}),
  now=()=>Date.now(),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
  const storage=()=>typeof store==='function'?store():store;
  const allowed=()=>new Set(getFeaturedStockCodes());
  const eligible=async()=> {const stocks=allowed();return (await companies()).filter(row=>stocks.has(row.stock_code));};
  return {
    enabled:config.enabled,
    companies:eligible,
    async capture(featured,events,observedAt,incomplete) {
      const selected=new Map(featured.filter(row=>allowed().has(row.stock_code)).map(row=>[row.corp_code,row]));
      const rows=events.filter(event=>selected.has(event.corp_code)).map(event=>({
        corp_code:event.corp_code,corp_name:event.corp_name,stock_code:selected.get(event.corp_code).stock_code,
        report_nm:event.report_nm,rcept_no:event.rcept_no,rcept_dt:event.rcept_dt
      }));
      await storage().captureTelegram(config.chat,[...selected.values()],rows,observedAt,incomplete);
    },
    async deliver({deadline=now()+90000}={}) {
      const result={sent:0,failed:0,uncertain:0,skipped:0};
      const current=new Map((await eligible()).map(row=>[row.corp_code,row]));
      for(const item of await storage().telegramPending(config.chat)) {
        if(now()+15000>deadline) break;
        const event=JSON.parse(item.event_json);
        if(!current.has(event.corp_code)||current.get(event.corp_code).stock_code!==event.stock_code) {
          await storage().finishTelegram(config.chat,item.receipt,'skipped');result.skipped++;continue;
        }
        let chartData=null;
        if(reportType(event.report_nm)==='잠정실적') {
          try {chartData=parseProvisionalFinancials(readDisclosureXml(await fetchDocument(event.rcept_no)));}
          catch { /* The verified disclosure and original link are still useful without optional figures. */ }
        }
        if(now()+11000>deadline) break;
        const claimed=await storage().claimTelegram(config.chat,item.receipt);
        if(!claimed) continue;
        let sent;
        try { sent=await api('sendMessage',{chat_id:config.chat,...formatTelegramDisclosure(event,chartData,config.origin)}); }
        catch(error) {
          const status=error.uncertain?'uncertain':error.retryAfter && Number(claimed.attempts)<5?'pending':'failed';
          await storage().finishTelegram(config.chat,item.receipt,status,(error.retryAfter||0)*1000);
          result[status==='uncertain'?'uncertain':'failed']++;
          if(error.retryAfter) await storage().pauseTelegram(config.chat,error.retryAfter*1000);
          if([401,403].includes(error.statusCode)) await storage().pauseTelegram(config.chat,86400000);
          console.warn('텔레그램 공시 발송 지연:',{receipt:item.receipt,code:error.statusCode || 'DELIVERY_UNCERTAIN'});
          if(error.retryAfter || [401,403].includes(error.statusCode) || error.uncertain) break;
          continue;
        }
        // If this write fails, leave the receipt leased; the next run marks it uncertain instead of duplicating it.
        await storage().finishTelegram(config.chat,item.receipt,'sent',0,String(sent.message_id));result.sent++;
        await pause(1200);
      }
      return result;
    }
  };
}
module.exports={telegramConfig,formatTelegramDisclosure,createTelegramApi,createTelegramBroadcast,change};
