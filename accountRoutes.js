const express = require('express');
const { randomBytes } = require('node:crypto');
const { OAuth2Client } = require('google-auth-library');
const { digest, sign, equal, seal, open, validateSubscription } = require('./accountSecurity');
const { getMailProvider } = require('./mailSender');
const { getSharedStore } = require('./sharedStore');

function accountConfig(env = process.env) {
  const origin = new URL(env.APP_ORIGIN || (env.VERCEL ? 'https://finalyze-ai.vercel.app' : `http://localhost:${env.PORT || 3000}`)).origin;
  return { origin, clientId: env.GOOGLE_CLIENT_ID || '', sessionSecret: env.SESSION_SECRET || '',
    identitySecret: env.USER_ID_SECRET || '', dataKey: env.USER_DATA_KEY || '',
    pushPublic: env.VAPID_PUBLIC_KEY || '', pushPrivate: env.VAPID_PRIVATE_KEY || '',
    mailAvailable: Boolean(getMailProvider(env)), production: Boolean(env.VERCEL),
    enabled: Boolean(env.GOOGLE_CLIENT_ID && env.SESSION_SECRET?.length >= 32 && env.USER_ID_SECRET?.length >= 32 &&
      Buffer.from(env.USER_DATA_KEY || '', 'base64').length === 32 && (!env.VERCEL || env.ACCOUNTS_DATABASE_URL || env.DATABASE_URL)) };
}
function cookies(req) {
  return Object.fromEntries((req.get('cookie') || '').split(';').map(value => {
    const index = value.indexOf('=');
    if (index < 0) return ['', ''];
    return [value.slice(0,index).trim(),value.slice(index+1).trim()];
  }));
}
function httpError(status, message) { return Object.assign(new Error(message), { status }); }

function createAccountRouter({ store, findCompany, config = accountConfig(), now = () => Date.now(), verifyIdentity, rateLimit, securityStore = getSharedStore }) {
  const router = express.Router();
  const google = new OAuth2Client(config.clientId);
  const verify = verifyIdentity || (async credential => (await google.verifyIdToken({ idToken: credential, audience: config.clientId })).getPayload());
  const storage = () => typeof store === 'function' ? store() : store;
  const secure = config.origin.startsWith('https:');
  const sessionName = `${secure ? '__Host-' : ''}finalyze_session`;
  const challengeName = `${secure ? '__Host-' : ''}finalyze_challenge`;
  const cookieOptions = { httpOnly: true, secure, sameSite: 'lax', path: '/' };
  const duration = 7*86400000;
  const wrap = fn => (req,res,next) => Promise.resolve(fn(req,res)).catch(next);
  const csrfFor = token => sign(`csrf:${token}`, config.sessionSecret);
  const userId = payload => sign(`google:${payload.sub}`, config.identitySecret);
  router.use((req,res,next) => { res.set('Cache-Control','no-store'); res.vary('Cookie'); next(); });
  function requireEnabled() { if (!config.enabled) throw httpError(503,'로그인 기능을 준비하고 있습니다. 잠시 후 다시 이용해주세요.'); }
  function requireOrigin(req) {
    if (req.get('origin') !== config.origin) throw httpError(403,'요청 출처를 확인할 수 없습니다.');
  }
  async function session(req) {
    requireEnabled();
    const token = cookies(req)[sessionName];
    if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) throw httpError(401,'로그인이 필요합니다.');
    const value = await storage().session(digest(token));
    if (!value) throw httpError(401,'다시 로그인해주세요.');
    return { ...value, token };
  }
  async function mutation(req) {
    requireOrigin(req);
    const value = await session(req);
    if (!equal(req.get('x-csrf-token'),csrfFor(value.token))) throw httpError(403,'요청을 확인하지 못했습니다. 화면을 새로고침해주세요.');
    return value;
  }
  function requireAnalysis(req,res,next) {
    res.set('Cache-Control','no-store'); res.vary('Cookie');
    (async () => {
      const value = await session(req);
      // GET requests also need the session-bound token: links and cross-site navigation cannot spend AI credits.
      if(req.method !== 'GET' || req.get('origin')) requireOrigin(req);
      if(!equal(req.get('x-csrf-token'),csrfFor(value.token))) throw httpError(403,'분석 요청을 확인하지 못했습니다. 화면을 새로고침해주세요.');
      req.analysisUserId=value.user_id;
    })().then(() => next()).catch(error => {
      if(!error.status) console.warn('AI 이용 권한 확인 실패:',{code:'ACCOUNT_UNAVAILABLE'});
      res.status(error.status || 503).json({status:'error',code:error.status===401 ? 'LOGIN_REQUIRED' : 'ANALYSIS_ACCESS_DENIED',
        message:error.status===401 ? 'AI 재무분석은 로그인 후 이용할 수 있습니다.' : error.status ? error.message : '로그인 상태를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.'});
    });
  }
  router.get('/account', wrap(async (req,res) => {
    const base = { enabled: config.enabled, clientId: config.clientId, mailAvailable: config.mailAvailable,
      pushAvailable: Boolean(config.pushPublic && config.pushPrivate), pushPublicKey: config.pushPublic };
    if (!config.enabled) return res.json({ ...base, authenticated: false });
    let value;
    try { value = await session(req); } catch (error) { if(error.status===401) return res.json({ ...base, authenticated:false }); throw error; }
    const [user,favorites,subscriptions] = await Promise.all([storage().user(value.user_id),storage().favorites(value.user_id),storage().subscriptions(value.user_id)]);
    if (!user) return res.json({ ...base, authenticated:false });
    let email = null;
    if (user.email_enabled && user.email_enc) {
      const address = open(user.email_enc,config.dataKey);
      email = address.replace(/^(.{1,2})[^@]*@/, '$1***@');
    }
    res.json({ ...base, authenticated:true, csrfToken:csrfFor(value.token), favorites, subscriptions,
      emailEnabled:Boolean(user.email_enabled), emailMasked:email });
  }));
  router.post('/auth/challenge', wrap(async (req,res) => {
    requireEnabled(); requireOrigin(req);
    if (rateLimit && !await rateLimit(req,'challenge')) throw httpError(429,'로그인 요청이 많습니다. 잠시 후 다시 시도해주세요.');
    const nonce = randomBytes(32).toString('base64url');
    const body = Buffer.from(JSON.stringify({ nonce, expires:now()+600000 })).toString('base64url');
    res.cookie(challengeName,`${body}.${sign(body,config.sessionSecret)}`,{ ...cookieOptions,maxAge:600000 });
    res.json({ nonce });
  }));
  router.post('/auth/google', wrap(async (req,res) => {
    requireEnabled(); requireOrigin(req);
    if (rateLimit && !await rateLimit(req,'complete')) throw httpError(429,'로그인 요청이 많습니다. 잠시 후 다시 시도해주세요.');
    const challenge = cookies(req)[challengeName] || '';
    res.clearCookie(challengeName,cookieOptions);
    const [body,signature] = challenge.split('.');
    let expected;
    try { expected = JSON.parse(Buffer.from(body || '', 'base64url').toString()); } catch {}
    if (!body || !equal(signature,sign(body,config.sessionSecret)) || !expected ||
        !/^[A-Za-z0-9_-]{43}$/.test(expected.nonce || '') || !Number.isFinite(expected.expires) || expected.expires<=now()) throw httpError(403,'로그인 요청이 만료됐습니다. 다시 시도해주세요.');
    const shared=typeof securityStore==='function'?securityStore():securityStore;
    // NX makes a challenge single-use across instances, including failed verification attempts.
    if (!await shared.lock(`finalyze:login:used:${digest(expected.nonce)}`,'used',600)) throw httpError(403,'이미 사용한 로그인 요청입니다. 다시 시도해주세요.');
    const credential = req.body?.credential;
    if (typeof credential !== 'string' || credential.length>12000) throw httpError(400,'로그인 응답이 올바르지 않습니다.');
    let payload;
    try { payload = await verify(credential); } catch { throw httpError(401,'Google 로그인 정보를 확인하지 못했습니다.'); }
    if (!payload || typeof payload.sub !== 'string' || !payload.sub.length || payload.sub.length>255 || !equal(payload.nonce,expected.nonce)) throw httpError(401,'로그인 요청이 일치하지 않습니다.');
    const id = userId(payload);
    let email = null;
    if (req.body.emailOptIn === true) {
      if (!config.mailAvailable) throw httpError(409,'이메일 알림은 아직 준비 중입니다.');
      if (payload.email_verified !== true || typeof payload.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email) ||
        !(payload.email.endsWith('@gmail.com') || payload.hd)) throw httpError(400,'메일 알림은 Gmail 또는 Google Workspace 계정으로 연결해주세요.');
      email = payload.email;
    }
    await storage().ensureUser(id);
    if (email) await storage().setEmail(id,seal(email,config.dataKey));
    const old = cookies(req)[sessionName];
    if (old) await storage().removeSession(digest(old));
    const token = randomBytes(32).toString('base64url');
    await storage().addSession(digest(token),id,now()+duration);
    res.cookie(sessionName,token,{ ...cookieOptions,maxAge:duration });
    // ID tokens, Google profile, and Google email (without email opt-in) are never persisted.
    res.json({ status:'success' });
  }));
  router.post('/auth/logout', wrap(async (req,res) => {
    const value = await mutation(req);
    if (typeof req.body?.endpoint === 'string') await storage().removePush(value.user_id,digest(req.body.endpoint));
    await storage().removeSession(digest(value.token));
    res.clearCookie(sessionName,cookieOptions);
    res.json({ status:'success' });
  }));
  router.post('/account/favorites', wrap(async (req,res) => {
    const value = await mutation(req);
    const corp = req.body?.corpCode;
    if (!/^\d{8}$/.test(corp || '')) throw httpError(400,'기업 고유번호를 확인해주세요.');
    const company = await findCompany(corp);
    if (!company || !/^\d{6}$/.test(company.stock_code || '')) throw httpError(404,'상장기업 정보를 찾지 못했습니다.');
    if (!await storage().addFavorite(value.user_id,company)) throw httpError(409,'관심 기업은 최대 50개까지 등록할 수 있습니다.');
    res.json({ status:'success' });
  }));
  router.delete('/account/favorites/:corp', wrap(async (req,res) => {
    const value = await mutation(req);
    if (!/^\d{8}$/.test(req.params.corp)) throw httpError(400,'기업 고유번호를 확인해주세요.');
    await storage().removeFavorite(value.user_id,req.params.corp);
    res.json({ status:'success' });
  }));
  router.post('/account/push', wrap(async (req,res) => {
    const value = await mutation(req);
    if (!config.pushPublic || !config.pushPrivate) throw httpError(503,'푸시 알림을 준비하고 있습니다.');
    const subscription = req.body?.subscription;
    if (!validateSubscription(subscription)) throw httpError(400,'푸시 구독 정보가 올바르지 않습니다.');
    const normalized = { endpoint:subscription.endpoint, keys:{ p256dh:subscription.keys.p256dh,auth:subscription.keys.auth } };
    if (!await storage().addPush(value.user_id,digest(subscription.endpoint),seal(normalized,config.dataKey))) throw httpError(409,'푸시는 계정당 최대 5개 기기까지 사용할 수 있습니다.');
    res.json({ status:'success' });
  }));
  router.delete('/account/push', wrap(async (req,res) => {
    const value = await mutation(req);
    if (typeof req.body?.endpoint !== 'string' || req.body.endpoint.length>4096) throw httpError(400,'푸시 구독 정보를 확인해주세요.');
    await storage().removePush(value.user_id,digest(req.body.endpoint));
    res.json({ status:'success' });
  }));
  router.delete('/account/email', wrap(async (req,res) => {
    const value = await mutation(req);
    await storage().setEmail(value.user_id,null);
    res.json({ status:'success' });
  }));
  router.delete('/account', wrap(async (req,res) => {
    const value = await mutation(req);
    if (req.body?.confirm !== true) throw httpError(400,'계정 삭제를 확인해주세요.');
    await storage().deleteUser(value.user_id);
    res.clearCookie(sessionName,cookieOptions);
    res.json({ status:'success' });
  }));
  function unsubscribeToken(id, since) {
    const value = Buffer.from(JSON.stringify({ id,since })).toString('base64url');
    return `${value}.${sign(`unsubscribe:${value}`,config.identitySecret)}`;
  }
  async function unsubscribeValue(token) {
    const [value,signature] = (token || '').split('.');
    if (!value || !equal(signature,sign(`unsubscribe:${value}`,config.identitySecret))) throw httpError(400,'수신 해제 링크가 올바르지 않습니다.');
    let data;
    try { data = JSON.parse(Buffer.from(value,'base64url').toString()); } catch { throw httpError(400,'수신 해제 링크를 확인해주세요.'); }
    const user = await storage().user(data.id);
    if (!user || Number(user.email_since)!==data.since) throw httpError(400,'만료된 수신 해제 링크입니다.');
    return data.id;
  }
  router.get('/notifications/unsubscribe/:token', wrap(async (req,res) => {
    await unsubscribeValue(req.params.token);
    res.type('html').send('<!doctype html><html lang="ko"><meta charset="UTF-8"><meta name="viewport" content="width=device-width"><title>이메일 수신 해제 | Finalyze.AI</title><body><h1>이메일 알림 수신 해제</h1><p>공시 알림 메일 수신을 중단할까요?</p><form method="post"><button>이메일 알림 끄기</button></form></body></html>');
  }));
  router.post('/notifications/unsubscribe/:token', wrap(async (req,res) => {
    const id = await unsubscribeValue(req.params.token);
    await storage().setEmail(id,null);
    res.type('html').send('<!doctype html><html lang="ko"><meta charset="UTF-8"><title>수신 해제 완료</title><body><h1>이메일 알림을 껐습니다.</h1><p>저장된 이메일 주소도 삭제했습니다.</p><a href="/">Finalyze.AI로 돌아가기</a></body></html>');
  }));
  router.use((error,req,res,next) => {
    if (res.headersSent) return next(error);
    const status = error.status || 503;
    if (!error.status) console.warn('계정 처리 실패:', { code:'ACCOUNT_UNAVAILABLE', route:req.route?.path });
    res.status(status).json({ status:'error',message:error.status ? error.message : '계정 정보를 처리하지 못했습니다. 잠시 후 다시 시도해주세요.' });
  });
  return { router,unsubscribeToken,config,requireAnalysis };
}
module.exports = { createAccountRouter,accountConfig };
