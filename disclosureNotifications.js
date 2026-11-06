const webpush = require('web-push');
const { reportType,hasFinancialResults } = require('./recentDisclosures');
const { open,equal,digest } = require('./accountSecurity');

function kstDate(timestamp) { return new Date(timestamp+9*3600000).toISOString().slice(0,10).replace(/-/g,''); }
function createDisclosureFeed({ fetchList,fetchDocumentText,now = () => Date.now() }) {
  return async function collect(companies,since) {
    const codes = new Set(companies.map(item => item.corp_code));
    const end = now();
    const dates = { bgn_de:kstDate(Math.max(since-86400000,end-7*86400000)),end_de:kstDate(end),page_count:100,
      sort:'date',sort_mth:'desc',last_reprt_at:'Y' };
    const receipts = new Map();
    for (const source of [{pblntf_ty:'A'},{pblntf_detail_ty:'I002'}]) {
      let pages = 1;
      for (let page=1;page<=pages;page++) {
        const result = await fetchList({ ...dates,...source,page_no:page });
        if(result.status==='013') break;
        if(result.status!=='000' || !Array.isArray(result.list)) throw new Error('NOTIFICATION_FEED_UNAVAILABLE');
        pages = Number(result.total_page);
        if(!Number.isInteger(pages) || pages<1 || pages>100) throw new Error('NOTIFICATION_FEED_PAGINATION');
        for(const row of result.list) {
          if(!codes.has(row.corp_code) || !/^\d{14}$/.test(row.rcept_no || '') || !/^\d{8}$/.test(row.rcept_dt || '') ||
            typeof row.corp_name!=='string' || typeof row.report_nm!=='string' || !reportType(row.report_nm) ||
            /[철정]/.test(row.rm || '') || /자회사의\s*주요경영사항/.test(row.report_nm)) continue;
          receipts.set(row.rcept_no,row);
        }
      }
    }
    const result = [];
    result.incompleteCompanies = [];
    for(const row of receipts.values()) {
      if(reportType(row.report_nm)==='잠정실적') {
        try { if(!hasFinancialResults(await fetchDocumentText(row.rcept_no))) continue; }
        catch { result.incompleteCompanies.push(row.corp_code); continue; }
      }
      result.push(row);
    }
    return result;
  };
}

function createSenders({ config,env = process.env,unsubscribeToken,fetchImpl = fetch,pushImpl = webpush.sendNotification.bind(webpush) }) {
  function link(event) {
    const params = new URLSearchParams({ corp:event.corp_code,name:event.corp_name,rcept:event.receipt });
    return `${config.origin}/?${params}`;
  }
  return {
    async push(target) {
      const subscription = open(target.subscription_enc,config.dataKey);
      await pushImpl(subscription,JSON.stringify({ title:`${target.corp_name} 새 실적 공시`,body:target.report_name,
        url:link(target),tag:`disclosure-${target.receipt}` }), {
        vapidDetails:{ subject:config.origin,publicKey:config.pushPublic,privateKey:config.pushPrivate },
        TTL:86400,timeout:7000,urgency:'normal',topic:digest(target.receipt).slice(0,32)
      });
    },
    async email(target,delivery) {
      if(!config.mailAvailable) throw Object.assign(new Error('MAIL_DISABLED'),{ permanent:true });
      const token = unsubscribeToken(delivery.user_id,Number(target.email_since));
      const unsubscribe = `${config.origin}/api/notifications/unsubscribe/${token}`;
      const response = await fetchImpl('https://api.resend.com/emails', {
        method:'POST',headers:{ Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':delivery.id },
        signal:AbortSignal.timeout(10000),body:JSON.stringify({ from:env.MAIL_FROM,to:[open(target.email_enc,config.dataKey)],
          subject:`[Finalyze.AI] ${target.corp_name} 새 실적 공시`,
          text:`${target.corp_name}\n${target.report_name}\n공시일: ${target.receipt_date}\n\n공시 보기: ${link(target)}\n\n이메일 알림 끄기: ${unsubscribe}`,
          headers:{ 'List-Unsubscribe':`<${unsubscribe}>`,'List-Unsubscribe-Post':'List-Unsubscribe=One-Click' }
        })
      });
      if(!response.ok) throw Object.assign(new Error('MAIL_SEND_FAILED'),{ statusCode:response.status });
    }
  };
}

function createNotificationJob({ store,collect,senders,broadcast,now = () => Date.now() }) {
  return async function run() {
    const startedAt=now();
    const storage = typeof store==='function' ? store() : store;
    const lease = await storage.acquireJob();
    if(!lease) return { busy:true };
    const result = { scanned:0,sent:0,failed:0,skipped:0 };
    try {
      await storage.cleanup();
      const watched = await storage.watchedCompanies();
      const featured = broadcast?.enabled ? await broadcast.companies() : [];
      const companies = [...new Map([...watched,...featured].map(row=>[row.corp_code,row])).values()];
      if(companies.length) {
        const observedAt = now();
        let events;
        try { events = await collect(companies,lease.since || observedAt); }
        catch { result.partial=true; console.warn('알림 공시 수집 지연:',{code:'FEED_UNAVAILABLE'}); }
        if(events) {
          for(const event of events) await storage.recordDisclosure(event,observedAt);
          if(broadcast?.enabled) await broadcast.capture(featured,events,observedAt,events.incompleteCompanies || []);
          await storage.completeScan(lease.token,observedAt,events.incompleteCompanies || []);
          result.scanned = events.length;
          if(events.incompleteCompanies?.length) result.partial=true;
        }
      }
      const deliveries = await storage.pendingDeliveries();
      for(let offset=0;offset<deliveries.length;offset+=4) {
        await Promise.all(deliveries.slice(offset,offset+4).map(async item => {
          const delivery = await storage.claimDelivery(item.id);
          if(!delivery) return;
          const target = await storage.deliveryTarget(delivery);
          if(!target) { await storage.finishDelivery(delivery.id,'skipped'); result.skipped++; return; }
          try {
            await senders[delivery.channel](target,delivery);
            await storage.finishDelivery(delivery.id,'sent');
            result.sent++;
          } catch(error) {
            const expired = delivery.channel==='push' && [404,410].includes(error.statusCode);
            if(expired) await storage.removePush(delivery.user_id,delivery.target_id);
            const terminal = expired || error.permanent || Number(delivery.attempts)>=5;
            await storage.finishDelivery(delivery.id,terminal ? 'failed' : 'pending',Math.min(3600000,60000*2**Number(delivery.attempts)));
            result.failed++;
            console.warn('공시 알림 전송 실패:', { channel:delivery.channel,code:error.statusCode || 'DELIVERY_UNAVAILABLE' });
          }
        }));
      }
      if(broadcast?.enabled) result.telegram=await broadcast.deliver({deadline:startedAt+180000});
      return result;
    } finally { await storage.releaseJob(lease.token); }
  };
}
function cronAuthorized(req,secret) { return typeof secret==='string' && secret.length>=32 && equal(req.get('authorization'),`Bearer ${secret}`); }
module.exports = { createDisclosureFeed,createSenders,createNotificationJob,cronAuthorized };
