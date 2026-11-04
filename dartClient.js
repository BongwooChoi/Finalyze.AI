const axios = require('axios');
const { createHash, randomUUID } = require('node:crypto');
const config = require('./config');
const { getSharedStore } = require('./sharedStore');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function kstDay(timestamp) { return new Date(timestamp + 9 * 3600000).toISOString().slice(0, 10); }
function hash(value) { return createHash('sha256').update(value).digest('hex').slice(0, 24); }
function clientError(code, message, extra = {}) { return Object.assign(new Error(message), { code, ...extra }); }

function createDartClient({ apiKey, store, transport = (...args) => axios.get(...args), now = () => Date.now(), pause = wait,
  intervalMs = 1000, dailyLimit = 8000, maxWaitMs = 12000 }) {
  const namespace = `finalyze:dart:${hash(apiKey || 'missing')}`;
  async function get(input, options = {}) {
    if (!apiKey) throw clientError('DART_KEY_MISSING', 'DART 인증키가 설정되지 않았습니다.');
    const url = new URL(input);
    if (url.origin !== 'https://opendart.fss.or.kr' || !url.pathname.startsWith('/api/')) {
      throw clientError('DART_URL_INVALID', '지원하지 않는 DART 주소입니다.');
    }
    for (const [key, value] of Object.entries(options.params || {})) url.searchParams.set(key, value);
    url.searchParams.delete('crtfc_key');
    url.searchParams.sort();
    const cacheKey = `${namespace}:response:${hash(url.pathname + url.search)}`;
    const storage = typeof store === 'function' ? store() : store;
    function unpack(value) {
      return { data: value.binary ? Buffer.from(value.data, 'base64') : value.data,
        headers: value.headers, status: 200 };
    }
    let cached = await storage.get(cacheKey);
    if (cached) return unpack(cached);
    const token = randomUUID();
    const lockKey = `${cacheKey}:lock`;
    if (!await storage.lock(lockKey, token, 45)) {
      for (let attempt = 0; attempt < 40; attempt++) {
        await pause(500);
        cached = await storage.get(cacheKey);
        if (cached) return unpack(cached);
      }
      throw clientError('DART_REQUEST_BUSY', '같은 공시를 확인하고 있습니다. 잠시 후 다시 시도해주세요.');
    }
    try {
      cached = await storage.get(cacheKey);
      if (cached) return unpack(cached);
      const timestamp = now();
      const [delay] = await storage.reserve(namespace, kstDay(timestamp), timestamp, intervalMs, dailyLimit, maxWaitMs);
      if (delay < 0) throw clientError('DART_RATE_LIMITED', 'DART 호출을 잠시 제한하고 있습니다.');
      if (delay > 0) await pause(delay);
      // 대기 중 다른 요청이 차단 응답을 받았을 수도 있으므로 실제 전송 직전에 확인합니다.
      const blocked = await storage.get(`${namespace}:blocked`);
      if (blocked && blocked > now()) throw clientError('DART_RATE_LIMITED', 'DART 호출을 잠시 제한하고 있습니다.');
      let response;
      try {
        response = await transport(`${url.origin}${url.pathname}`, {
          ...options, timeout: options.timeout || 8000,
          params: { ...Object.fromEntries(url.searchParams), crtfc_key: apiKey }
        });
      } catch (error) {
        if (error.response?.status === 429 || error.response?.status === 403) {
          await storage.block(namespace, now() + 5 * 60 * 1000, now());
          throw clientError('DART_RATE_LIMITED', 'DART 서버의 접근 제한 응답으로 호출을 중지했습니다.', { httpStatus: error.response.status });
        }
        throw clientError(error.code || 'DART_NETWORK_ERROR', String(error.message || 'DART 요청 실패').replaceAll(apiKey, '[REDACTED]'),
          error.response ? { response: { status: error.response.status, data: { message: 'DART 서버 응답 오류' } } } : {});
      }
      const binary = Buffer.isBuffer(response.data) || response.data instanceof ArrayBuffer;
      const bytes = binary ? Buffer.from(response.data) : null;
      const xmlStatus = binary && !(bytes[0] === 80 && bytes[1] === 75)
        ? bytes.toString('utf8').slice(0, 2000).match(/<status>(\d+)<\/status>/)?.[1] : null;
      const status = xmlStatus || response.data?.status;
      if (['020', '012', '011'].includes(status)) {
        const current = now();
        const nextMidnight = Date.parse(`${kstDay(current)}T00:00:00+09:00`) + 86400000;
        await storage.block(namespace, status === '020' ? nextMidnight : current + 5 * 60 * 1000, current);
        throw clientError('DART_RATE_LIMITED', 'DART 호출 제한 응답으로 추가 호출을 중지했습니다.', { dartStatus: status });
      }
      const successful = binary ? bytes[0] === 80 && bytes[1] === 75 : status === '000' || status === '013';
      if (successful) {
        const value = { binary, data: binary ? bytes.toString('base64') : response.data,
          headers: { 'content-type': response.headers?.['content-type'] || '' } };
        const ttl = binary ? 7 * 86400 : status === '013' ? 60 : 300;
        await storage.set(cacheKey, value, ttl);
      }
      return response;
    } finally {
      await storage.unlock(lockKey, token).catch(() => {});
    }
  }
  return { get, namespace };
}

const client = createDartClient({ apiKey: config.OPEN_DART_API_KEY, store: getSharedStore });
module.exports = client;
module.exports.createDartClient = createDartClient;
module.exports.kstDay = kstDay;
