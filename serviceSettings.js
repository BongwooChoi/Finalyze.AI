const FIELDS={
  memberDaily:[0,1000],globalDaily:[0,100000],memberConcurrent:[1,5],globalConcurrent:[1,20],
  intervalSeconds:[1,300],maxSessions:[1,20],maxFavorites:[1,200],maxPush:[1,20]
};
function validateSettings(input) {
  if(!input || Array.isArray(input) || typeof input!=='object' || typeof input.aiEnabled!=='boolean' ||
      Object.keys(input).length!==Object.keys(FIELDS).length+1) throw new Error('설정 항목을 확인해주세요.');
  const values={aiEnabled:input.aiEnabled};
  for(const [key,[min,max]] of Object.entries(FIELDS)) {
    if(!Number.isSafeInteger(input[key]) || input[key]<min || input[key]>max) throw new Error(`${key}: ${min}~${max} 사이의 정수를 입력해주세요.`);
    values[key]=input[key];
  }
  return values;
}
function defaultSettings(env=process.env) {
  const number=(key,fallback)=>env[key]===undefined || env[key]==='' ? fallback : Number(env[key]);
  return validateSettings({aiEnabled:true,memberDaily:number('AI_MEMBER_DAILY_LIMIT',10),globalDaily:number('AI_GLOBAL_DAILY_LIMIT',200),
    memberConcurrent:1,globalConcurrent:4,intervalSeconds:10,maxSessions:5,maxFavorites:50,maxPush:5});
}
function kstDate(time) { return new Date(time+9*3600000).toISOString().slice(0,10); }
function createSettingsService({store,env=process.env,now=()=>Date.now()}) {
  const defaults=defaultSettings(env);
  const storage=()=>typeof store==='function'?store():store;
  async function read() {
    const row=await storage().settingsRecord();
    return row ? {version:Number(row.version),values:validateSettings(JSON.parse(row.value_json)),updatedAt:Number(row.updated_at)} :
      {version:0,values:{...defaults},updatedAt:0};
  }
  return {
    read,values:async()=>(await read()).values,
    async save(input,version,actor) {
      let values;
      try { values=validateSettings(input); }
      catch(error) { throw Object.assign(error,{status:400}); }
      if(!Number.isSafeInteger(version) || version<0) throw Object.assign(new Error('설정 버전을 확인해주세요.'),{status:400});
      const previous=await read();
      if(previous.version!==version) throw Object.assign(new Error('다른 변경이 저장됐습니다. 새로 불러온 뒤 다시 시도해주세요.'),{status:409});
      if(!await storage().saveSettings(values,previous.values,version,actor,now()))
        throw Object.assign(new Error('다른 변경이 저장됐습니다. 새로 불러온 뒤 다시 시도해주세요.'),{status:409});
      return read();
    },
    async dashboard() {
      const time=now(),day=kstDate(time),start=Date.parse(day+'T00:00:00+09:00');
      const [settings,stats,history]=await Promise.all([read(),storage().adminStats(start,start+86400000,time),storage().settingsHistory()]);
      return {settings,stats:Object.fromEntries(Object.entries(stats).map(([key,value])=>[key,Number(value)])),
        day,history:history.map(row=>({version:Number(row.version),at:Number(row.changed_at),before:JSON.parse(row.before_json),after:JSON.parse(row.value_json)}))};
    }
  };
}
module.exports={FIELDS,validateSettings,defaultSettings,createSettingsService,kstDate};
