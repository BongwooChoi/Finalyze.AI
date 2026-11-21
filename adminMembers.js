const {kstDate}=require('./serviceSettings');

// Only existing operational fields are read. Email ciphertext and push endpoints
// never enter these queries or the administrator response.
const FILTERS={
  all:'1=1',
  new:'u.created_at >= $2 AND u.created_at < $3',
  signedIn:'EXISTS(SELECT 1 FROM app_sessions s WHERE s.user_id=u.id AND s.expires_at>$1)',
  email:'u.email_enabled=1',
  push:'EXISTS(SELECT 1 FROM app_push p WHERE p.user_id=u.id)',
  favorites:'EXISTS(SELECT 1 FROM app_favorites f WHERE f.user_id=u.id)',
  queued:"EXISTS(SELECT 1 FROM app_deliveries d WHERE d.user_id=u.id AND d.status='pending' AND d.attempts<5)"
};
const SUMMARY=`u.id,u.created_at,u.email_enabled,
  (SELECT COUNT(*) FROM app_sessions s WHERE s.user_id=u.id AND s.expires_at>$1) AS sessions,
  (SELECT COUNT(*) FROM app_push p WHERE p.user_id=u.id) AS devices,
  (SELECT COUNT(*) FROM app_favorites f WHERE f.user_id=u.id) AS favorites,
  (SELECT COUNT(*) FROM app_deliveries d WHERE d.user_id=u.id AND d.status='pending' AND d.attempts<5) AS queued`;
const member=row=>({id:row.id,createdAt:Number(row.created_at),emailEnabled:Number(row.email_enabled)===1,
  sessions:Number(row.sessions),devices:Number(row.devices),favorites:Number(row.favorites),queued:Number(row.queued)});
const invalid=()=>Object.assign(new Error('조회 조건을 확인해주세요.'),{status:400});
function createAdminMembers({store,sharedStore,now=()=>Date.now()}) {
  const storage=()=>typeof store==='function'?store():store;
  return {
    async list(input={}) {
      const filter=input.filter ?? 'all',pageText=input.page ?? '1',search=input.search ?? '';
      if(typeof filter!=='string' || !Object.hasOwn(FILTERS,filter) || typeof pageText!=='string' ||
        !/^[1-9]\d{0,5}$/.test(pageText) || typeof search!=='string' || !/^[A-Za-z0-9_-]{0,43}$/.test(search)) throw invalid();
      const time=now(),day=kstDate(time),start=Date.parse(day+'T00:00:00+09:00'),pageSize=25;
      // Fixed parameters keep both SQLite and PostgreSQL placeholders consistent.
      const where=`(${FILTERS[filter]}) AND CAST($1 AS BIGINT)>=0 AND CAST($2 AS BIGINT)<CAST($3 AS BIGINT) AND SUBSTR(u.id,1,LENGTH($4))=$4`;
      const params=[time,start,start+86400000,search];
      const [count]=await storage().query(`SELECT COUNT(*) AS total FROM app_users u WHERE ${where}`,params);
      const total=Number(count.total),pages=Math.max(1,Math.ceil(total/pageSize)),page=Math.min(Number(pageText),pages);
      const rows=await storage().query(`SELECT ${SUMMARY} FROM app_users u WHERE ${where}
        ORDER BY u.created_at DESC,u.id LIMIT $5 OFFSET $6`,[...params,pageSize,(page-1)*pageSize]);
      return {members:rows.map(member),filter,search,page,pageSize,total,pages,day,asOf:time};
    },
    async detail(id) {
      if(typeof id!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(id)) throw invalid();
      const time=now(),day=kstDate(time);
      const [row]=await storage().query(`SELECT ${SUMMARY} FROM app_users u WHERE u.id=$2`,[time,id]);
      if(!row) throw Object.assign(new Error('해당 회원을 찾을 수 없습니다. 탈퇴했거나 목록이 변경됐을 수 있습니다.'),{status:404});
      const [favorites,devices,sessions,deliveries]=await Promise.all([
        storage().query('SELECT corp_code,corp_name,stock_code,created_at FROM app_favorites WHERE user_id=$1 ORDER BY created_at DESC,corp_code',[id]),
        storage().query('SELECT created_at FROM app_push WHERE user_id=$1 ORDER BY created_at DESC,id',[id]),
        storage().query('SELECT expires_at FROM app_sessions WHERE user_id=$1 AND expires_at>$2 ORDER BY expires_at DESC',[id,time]),
        storage().query(`SELECT e.receipt,e.corp_name,e.report_name,e.first_seen,d.channel,d.status,d.attempts,d.next_attempt
          FROM app_deliveries d JOIN app_disclosures e ON e.receipt=d.receipt WHERE d.user_id=$1
          ORDER BY e.first_seen DESC,e.receipt DESC,d.channel,d.id LIMIT 30`,[id])
      ]);
      let aiUsage=null;
      try {
        const shared=typeof sharedStore==='function'?sharedStore():sharedStore;
        aiUsage={used:Number(await shared.get(`finalyze:ai:v1:user:${id}:day:${day}`) || 0)};
      } catch {} // Unknown usage must not be presented as zero during a cache outage.
      return {member:member(row),day,asOf:time,aiUsage,
        favorites:favorites.map(f=>({corpCode:f.corp_code,name:f.corp_name,stockCode:f.stock_code,createdAt:Number(f.created_at)})),
        devices:devices.map(d=>({createdAt:Number(d.created_at)})),
        sessions:sessions.map(s=>({expiresAt:Number(s.expires_at)})),
        deliveries:deliveries.map(d=>({receipt:d.receipt,company:d.corp_name,report:d.report_name,observedAt:Number(d.first_seen),
          channel:d.channel,status:d.status,attempts:Number(d.attempts),nextAttempt:Number(d.next_attempt)}))};
    }
  };
}
module.exports={createAdminMembers};
