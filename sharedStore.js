// Redis의 원자 연산으로 서버리스 인스턴스 전체가 잠금·호출 한도를 공유합니다.
const RESERVE_SCRIPT = `
local now = tonumber(ARGV[1])
local blocked = tonumber(redis.call('GET', KEYS[3]) or '0')
if blocked > now then return {-1, blocked-now} end
local next = math.max(now, tonumber(redis.call('GET', KEYS[1]) or '0'))
if next-now > tonumber(ARGV[4]) then return {-2, next-now} end
local used = tonumber(redis.call('GET', KEYS[2]) or '0')
if used >= tonumber(ARGV[3]) then return {-3, 0} end
redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], 172800)
redis.call('SET', KEYS[1], next+tonumber(ARGV[2]), 'PX', 60000)
return {next-now, used+1}`;
const UNLOCK_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
const BLOCK_SCRIPT = `local old=tonumber(redis.call('GET',KEYS[1]) or '0')
if old < tonumber(ARGV[1]) then redis.call('SET',KEYS[1],ARGV[1],'PX',ARGV[2]) end return 1`;

function cacheError() {
  return Object.assign(new Error('공유 캐시에 연결하지 못했습니다.'), { code: 'DART_CACHE_UNAVAILABLE' });
}

function createRedisStore({ url, token, fetchImpl = fetch }) {
  async function command(args) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args), signal: AbortSignal.timeout(5000)
      });
      const body = await response.json();
      if (!response.ok || body.error) throw cacheError();
      return body.result;
    } catch {
      // 연결 정보나 인증 토큰이 오류 메시지·로그에 포함되지 않도록 정규화합니다.
      throw cacheError();
    }
  }
  return {
    async get(key) { const value = await command(['GET', key]); return value === null ? null : JSON.parse(value); },
    async set(key, value, seconds) { await command(['SET', key, JSON.stringify(value), 'EX', seconds]); },
    async lock(key, tokenValue, seconds) { return (await command(['SET', key, tokenValue, 'NX', 'EX', seconds])) === 'OK'; },
    async unlock(key, tokenValue) { await command(['EVAL', UNLOCK_SCRIPT, 1, key, tokenValue]); },
    async reserve(key, day, now, interval, limit, maxWait) {
      return command(['EVAL', RESERVE_SCRIPT, 3, `${key}:next`, `${key}:day:${day}`, `${key}:blocked`, now, interval, limit, maxWait]);
    },
    async block(key, until, now) { await command(['EVAL', BLOCK_SCRIPT, 1, `${key}:blocked`, until, Math.max(1, until - now)]); }
  };
}

// 로컬 실행과 외부 API를 호출하지 않는 단위 테스트용입니다.
function createMemoryStore({ now = () => Date.now() } = {}) {
  const entries = new Map();
  function read(key) {
    const item = entries.get(key);
    if (!item || item.until <= now()) { entries.delete(key); return null; }
    return item.value;
  }
  function put(key, value, seconds) { entries.set(key, { value, until: now() + seconds * 1000 }); }
  return {
    async get(key) { const value = read(key); return value === null ? null : JSON.parse(value); },
    async set(key, value, seconds) { put(key, JSON.stringify(value), seconds); },
    async lock(key, tokenValue, seconds) { if (read(key) !== null) return false; put(key, tokenValue, seconds); return true; },
    async unlock(key, tokenValue) { if (read(key) === tokenValue) entries.delete(key); },
    async reserve(key, day, timestamp, interval, limit, maxWait) {
      const blocked = Number(read(`${key}:blocked`) || 0);
      if (blocked > timestamp) return [-1, blocked - timestamp];
      const next = Math.max(timestamp, Number(read(`${key}:next`) || 0));
      if (next - timestamp > maxWait) return [-2, next - timestamp];
      const used = Number(read(`${key}:day:${day}`) || 0);
      if (used >= limit) return [-3, 0];
      put(`${key}:day:${day}`, used + 1, 172800);
      put(`${key}:next`, next + interval, 60);
      return [next - timestamp, used + 1];
    },
    async block(key, until, timestamp) {
      if (Number(read(`${key}:blocked`) || 0) < until) put(`${key}:blocked`, until, (until - timestamp) / 1000);
    }
  };
}

let store;
function getSharedStore() {
  if (store) return store;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) store = createRedisStore({ url, token });
  else if (!process.env.VERCEL) store = createMemoryStore();
  else throw cacheError(); // 운영에서 공유 저장소 없이 DART를 무제한 호출하는 fallback은 금지합니다.
  return store;
}

module.exports = { createRedisStore, createMemoryStore, getSharedStore };
