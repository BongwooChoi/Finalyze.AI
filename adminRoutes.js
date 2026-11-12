const express=require('express');
function createAdminRouter({accounts,settings,sharedStore,traffic,now=()=>Date.now()}) {
  const router=express.Router();
  const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
  router.use((req,res,next)=>{res.set('Cache-Control','no-store');res.set('X-Robots-Tag','noindex, nofollow');res.vary('Cookie');next();});
  router.use(accounts.requireAdmin);
  router.get('/traffic',wrap(async(req,res)=>{
    if(!traffic)throw Object.assign(Error('통합 통계 연결을 준비하고 있습니다.'),{status:503});
    res.json({status:'success',...await traffic.report(req.query.days||30)});
  }));
  router.post('/traffic/sync',wrap(async(req,res)=>{
    if(!traffic)throw Object.assign(Error('통합 통계 연결을 준비하고 있습니다.'),{status:503});
    res.json(await traffic.sync());
  }));
  router.get('/dashboard',wrap(async(req,res)=>{
    const data=await settings.dashboard();let aiUsage=null;
    try {const store=typeof sharedStore==='function'?sharedStore():sharedStore;aiUsage=await store.analysisUsage(data.day,now());} catch {}
    res.json({status:'success',...data,aiUsage});
  }));
  router.put('/settings',wrap(async(req,res)=>{
    const result=await settings.save(req.body?.values,req.body?.version,req.adminUserId);
    res.json({status:'success',settings:result});
  }));
  router.use((error,req,res,next)=>{
    if(res.headersSent) return next(error);
    if(!error.status) console.warn('관리자 요청 실패:',{code:'ADMIN_UNAVAILABLE'});
    res.status(error.status || 503).json({status:'error',message:error.status ? error.message : '관리자 정보를 처리하지 못했습니다. 잠시 후 다시 시도해주세요.'});
  });
  return router;
}
module.exports={createAdminRouter};
