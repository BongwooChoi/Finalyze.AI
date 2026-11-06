const {randomUUID}=require('node:crypto');
const {getSharedStore}=require('./sharedStore');
const {defaultSettings,validateSettings}=require('./serviceSettings');
const LEASE_MS=180000; // Longer than the complete upstream deadline, including retries.
const OPENAI_DEADLINE_MS=120000;
function createAnalysisLimiter({store=getSharedStore,now=()=>Date.now(),env=process.env,getSettings}={}) {
  const defaults=defaultSettings(env);
  return async function run(user,operation) {
    if(!user) throw Object.assign(new Error('로그인이 필요합니다.'),{status:401});
    const time=now(),day=new Date(time+9*3600000).toISOString().slice(0,10);
    const retrySeconds=Math.max(1,Math.ceil((Date.parse(day+'T15:00:00Z')-time)/1000));
    const token=randomUUID();let storage,code,retry;
    try {
      const settings=getSettings ? validateSettings(await getSettings()) : defaults;
      if(!settings.aiEnabled) throw Object.assign(new Error('AI 분석을 잠시 쉬고 있습니다. 나중에 다시 이용해주세요.'),{status:503,code:'AI_PAUSED'});
      const limits={memberDaily:settings.memberDaily,globalDaily:settings.globalDaily,memberConcurrent:settings.memberConcurrent,
        globalConcurrent:settings.globalConcurrent,intervalMs:settings.intervalSeconds*1000,leaseMs:LEASE_MS};
      storage=typeof store==='function'?store():store;
      [code,retry]=await storage.acquireAnalysis(user,day,token,time,{...limits,retrySeconds});
    } catch(error) {
      if(error.code==='AI_PAUSED') throw error;
      throw Object.assign(new Error('AI 이용 한도를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.'),{status:503,code:'AI_LIMIT_UNAVAILABLE'});
    }
    if(code!==1) {
      const message=code===-1 ? '오늘 이용 가능한 AI 분석 횟수를 모두 사용했습니다. 내일 다시 이용해주세요.' :
        code===-2 ? '오늘 서비스의 AI 분석 한도에 도달했습니다. 내일 다시 이용해주세요.' :
        code===-3 ? '진행 중인 AI 분석이 있습니다. 완료 후 다시 요청해주세요.' :
        'AI 분석 요청이 많습니다. 잠시 후 다시 시도해주세요.';
      throw Object.assign(new Error(message),{status:429,code:'AI_LIMIT_REACHED',retryAfter:retry});
    }
    try { return await operation(); }
    finally {
      // A disconnected browser must not release a still-running paid operation.
      try { await storage.releaseAnalysis(user,token); }
      catch { console.warn('AI 이용 잠금 해제 지연:',{code:'AI_RELEASE_UNAVAILABLE'}); }
    }
  };
}
module.exports={createAnalysisLimiter,OPENAI_DEADLINE_MS};
