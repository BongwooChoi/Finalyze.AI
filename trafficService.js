function createTrafficService({env=process.env,fetcher=fetch}={}) {
  async function request(method,days=30) {
    if(!env.TRAFFIC_REPORT_SECRET || env.TRAFFIC_REPORT_SECRET.length<32)throw Object.assign(Error('통합 통계 연결을 준비하고 있습니다.'),{status:503});
    if(![7,30,90,365].includes(Number(days)))throw Object.assign(Error('지원하지 않는 조회 기간입니다.'),{status:400});
    const response=await fetcher('https://bongwoo-projects.vercel.app/api/traffic?days='+Number(days),{
      method,headers:{Authorization:'Bearer '+env.TRAFFIC_REPORT_SECRET.trim()},signal:AbortSignal.timeout(method==='POST'?55000:10000)
    });
    if(response.status===429)throw Object.assign(Error('최근 갱신했거나 수집 중입니다. 5분 뒤 다시 시도해주세요.'),{status:429});
    if(!response.ok)throw Object.assign(Error('통계 저장소에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.'),{status:503});
    return response.json();
  }
  return {report:days=>request('GET',days),sync:()=>request('POST')};
}
module.exports={createTrafficService};
