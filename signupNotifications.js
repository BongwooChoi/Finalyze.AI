const {createTelegramApi}=require('./telegramDisclosures');

function signupNotificationConfig(env=process.env) {
  const token=env.TELEGRAM_BOT_TOKEN || '',chat=env.TELEGRAM_ADMIN_CHAT_ID || '';
  // Never fall back to the public disclosure channel. Only a private user chat is accepted.
  return {token,chat,enabled:env.TELEGRAM_SIGNUP_ENABLED==='true' && /^[1-9]\d{4,15}$/.test(chat) &&
    /^\d{5,15}:[A-Za-z0-9_-]{30,100}$/.test(token)};
}
function kstTimestamp(time) { return new Date(Number(time)+9*3600000).toISOString().slice(0,16).replace('T',' '); }
function formatSignupNotification(createdAt,stats,now) {
  return {text:`🎉 Finalyze.AI 신규 회원 가입\n가입 시각: ${kstTimestamp(createdAt)} (KST)\n\n오늘 신규: ${Number(stats.new_members)}명\n현재 전체 회원: ${Number(stats.members)}명\n집계 시각: ${kstTimestamp(now)} (KST)`,
    allow_paid_broadcast:false,link_preview_options:{is_disabled:true}};
}
function createSignupNotifications({store,config=signupNotificationConfig(),now=()=>Date.now(),
  api=createTelegramApi({token:config.token}),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
  async function run() {
    if(!config.enabled) return {enabled:false};
    const storage=typeof store==='function'?store():store;
    const result={sent:0,failed:0,uncertain:0};
    await storage.captureSignups(config.chat);
    for(const item of await storage.pendingSignups(config.chat)) {
      // Read counts before claiming: a stats failure must not leave an unsent message uncertain.
      const time=now(),start=Math.floor((time+9*3600000)/86400000)*86400000-9*3600000;
      const stats=await storage.signupStats(start,start+86400000);
      const delivery=await storage.claimSignup(config.chat,item.user_id);
      if(!delivery) continue;
      try {
        const sent=await api('sendMessage',{chat_id:config.chat,...formatSignupNotification(delivery.created_at,stats,time)});
        await storage.finishSignup(config.chat,item.user_id,'sent',0,String(sent.message_id));
        result.sent++;
      } catch(error) {
        // Telegram has no idempotency key. Retry only an explicit 429 rejection.
        const retry=error.statusCode===429 && Number(delivery.attempts)<5;
        const uncertain=error.uncertain || !error.statusCode;
        const delay=Math.max(1,Number(error.retryAfter)||60)*1000;
        await storage.finishSignup(config.chat,item.user_id,retry?'pending':uncertain?'uncertain':'failed',retry?delay:0);
        result[uncertain?'uncertain':'failed']++;
        if(error.statusCode===429 || [401,403].includes(error.statusCode)) {
          await storage.pauseSignups(config.chat,error.statusCode===429?delay:86400000);
        }
        console.warn('회원 가입 알림 전송 지연:',{code:uncertain?'DELIVERY_UNCERTAIN':'DELIVERY_REJECTED'});
        break;
      }
      await pause(1200);
    }
    return result;
  }
  return {enabled:config.enabled,run};
}
module.exports={signupNotificationConfig,formatSignupNotification,createSignupNotifications};
