const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY, created_at BIGINT NOT NULL, email_enc TEXT, email_enabled INTEGER NOT NULL DEFAULT 0, email_since BIGINT NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS app_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE, expires_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS app_favorites (user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE, corp_code TEXT NOT NULL, corp_name TEXT NOT NULL, stock_code TEXT NOT NULL, created_at BIGINT NOT NULL, monitoring_since BIGINT NOT NULL DEFAULT 0, PRIMARY KEY(user_id,corp_code))`,
  `CREATE TABLE IF NOT EXISTS app_push (user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE, id TEXT NOT NULL, subscription_enc TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(user_id,id))`,
  `CREATE TABLE IF NOT EXISTS app_disclosures (receipt TEXT PRIMARY KEY, corp_code TEXT NOT NULL, corp_name TEXT NOT NULL, report_name TEXT NOT NULL, receipt_date TEXT NOT NULL, first_seen BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS app_deliveries (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE, receipt TEXT NOT NULL REFERENCES app_disclosures(receipt) ON DELETE CASCADE, channel TEXT NOT NULL, target_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt BIGINT NOT NULL DEFAULT 0, lease_until BIGINT NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS app_jobs (id TEXT PRIMARY KEY, last_success BIGINT NOT NULL DEFAULT 0, lease_token TEXT NOT NULL DEFAULT '', lease_until BIGINT NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS app_telegram_channels (chat_id TEXT PRIMARY KEY, blocked_until BIGINT NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS app_telegram_baselines (chat_id TEXT NOT NULL REFERENCES app_telegram_channels(chat_id) ON DELETE CASCADE, corp_code TEXT NOT NULL, started_at BIGINT NOT NULL, PRIMARY KEY(chat_id,corp_code))`,
  `CREATE TABLE IF NOT EXISTS app_telegram_deliveries (chat_id TEXT NOT NULL REFERENCES app_telegram_channels(chat_id) ON DELETE CASCADE, receipt TEXT NOT NULL, event_json TEXT NOT NULL, created_at BIGINT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt BIGINT NOT NULL DEFAULT 0, lease_until BIGINT NOT NULL DEFAULT 0, message_id TEXT, PRIMARY KEY(chat_id,receipt))`,
  `CREATE INDEX IF NOT EXISTS app_sessions_expiry ON app_sessions(expires_at)`,
  `CREATE INDEX IF NOT EXISTS app_deliveries_pending ON app_deliveries(status,next_attempt)`
];

function sqliteDatabase(filename = ':memory:') {
  const sqlite3 = require('sqlite3');
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new sqlite3.Database(filename);
  db.run('PRAGMA foreign_keys = ON');
  function rawQuery(sql, params = []) {
    const values = [];
    const text = sql.replace(/\$(\d+)/g, (_, index) => { values.push(params[Number(index) - 1]); return '?'; });
    return new Promise((resolve, reject) => db.all(text, values, (error, rows) => error ? reject(error) : resolve(rows)));
  }
  let tail = Promise.resolve();
  function enqueue(operation) {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  }
  const query = (sql, params) => enqueue(() => rawQuery(sql,params));
  function transaction(queries) {
    return enqueue(async () => {
      await rawQuery('BEGIN IMMEDIATE');
      try {
        const result = [];
        for (const [sql, params] of queries) result.push(await rawQuery(sql, params));
        await rawQuery('COMMIT');
        return result;
      } catch (error) { await rawQuery('ROLLBACK'); throw error; }
    });
  }
  return { query, transaction, migrate: () => transaction(SCHEMA.map(sql => [sql, []])),
    close: () => new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve())) };
}

function neonDatabase(url) {
  const { neon } = require('@neondatabase/serverless');
  const sql = neon(url, { fetchOptions: { signal: undefined } });
  const query = (text, params = []) => sql.query(text, params, { fetchOptions: { signal: AbortSignal.timeout(15000) } });
  const transaction = queries => sql.transaction(queries.map(([text, params]) => sql.query(text, params)),
    { fetchOptions: { signal: AbortSignal.timeout(20000) } });
  return { query, transaction, migrate: () => transaction(SCHEMA.map(text => [text, []])), close: async () => {} };
}

function createAccountStore(database, now = () => Date.now()) {
  let ready;
  function initialize() {
    if (!ready) ready = database.migrate().catch(error => { ready = null; throw error; });
    return ready;
  }
  async function query(text, params = []) { await initialize(); return database.query(text, params); }
  async function transaction(queries) { await initialize(); return database.transaction(queries); }
  const first = rows => rows[0] || null;
  return {
    initialize, query, close: database.close,
    async ensureUser(id) { await query('INSERT INTO app_users(id,created_at) VALUES($1,$2) ON CONFLICT(id) DO NOTHING', [id, now()]); },
    async user(id) { return first(await query('SELECT * FROM app_users WHERE id=$1', [id])); },
    async session(hash) { return first(await query('SELECT user_id,expires_at FROM app_sessions WHERE token_hash=$1 AND expires_at>$2', [hash, now()])); },
    async addSession(hash, id, expires) { await query('INSERT INTO app_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [hash,id,expires]); },
    async removeSession(hash) { await query('DELETE FROM app_sessions WHERE token_hash=$1', [hash]); },
    async favorites(id) { return query('SELECT corp_code,corp_name,stock_code,created_at FROM app_favorites WHERE user_id=$1 ORDER BY created_at DESC,corp_code', [id]); },
    async addFavorite(id, company) {
      await query(`INSERT INTO app_favorites(user_id,corp_code,corp_name,stock_code,created_at)
        SELECT $1,$2,$3,$4,$5 WHERE (SELECT COUNT(*) FROM app_favorites WHERE user_id=$1)<50
        ON CONFLICT(user_id,corp_code) DO NOTHING`, [id,company.corp_code,company.corp_name,company.stock_code,now()]);
      return first(await query('SELECT corp_code FROM app_favorites WHERE user_id=$1 AND corp_code=$2', [id,company.corp_code]));
    },
    async removeFavorite(id, corp) { await query('DELETE FROM app_favorites WHERE user_id=$1 AND corp_code=$2', [id,corp]); },
    async subscriptions(id) { return query('SELECT id FROM app_push WHERE user_id=$1', [id]); },
    async addPush(id, target, encrypted) {
      await transaction([
        ['DELETE FROM app_push WHERE id=$2 AND user_id<>$1',[id,target]],
        [`UPDATE app_favorites SET monitoring_since=0 WHERE user_id=$1 AND NOT EXISTS(SELECT 1 FROM app_push WHERE user_id=$1) AND EXISTS(SELECT 1 FROM app_users WHERE id=$1 AND email_enabled=0)`, [id]],
        [`INSERT INTO app_push(user_id,id,subscription_enc,created_at) SELECT $1,$2,$3,$4 WHERE (SELECT COUNT(*) FROM app_push WHERE user_id=$1)<5 OR EXISTS(SELECT 1 FROM app_push WHERE user_id=$1 AND id=$2)
          ON CONFLICT(user_id,id) DO UPDATE SET subscription_enc=excluded.subscription_enc`, [id,target,encrypted,now()]]
      ]);
      return first(await query('SELECT id FROM app_push WHERE user_id=$1 AND id=$2', [id,target]));
    },
    async removePush(id, target) { await query('DELETE FROM app_push WHERE user_id=$1 AND id=$2', [id,target]); },
    async setEmail(id, encrypted) {
      await transaction([
        ['UPDATE app_favorites SET monitoring_since=0 WHERE user_id=$1 AND NOT EXISTS(SELECT 1 FROM app_push WHERE user_id=$1) AND EXISTS(SELECT 1 FROM app_users WHERE id=$1 AND email_enabled=0)', [id]],
        ['UPDATE app_users SET email_enc=$2,email_enabled=$3,email_since=$4 WHERE id=$1', [id,encrypted,encrypted ? 1 : 0,encrypted ? now() : 0]]
      ]);
    },
    async deleteUser(id) { await query('DELETE FROM app_users WHERE id=$1', [id]); },
    async acquireJob() {
      const token = randomUUID();
      const row = first(await query(`INSERT INTO app_jobs(id,lease_token,lease_until) VALUES('disclosures',$1,$2)
        ON CONFLICT(id) DO UPDATE SET lease_token=excluded.lease_token,lease_until=excluded.lease_until
        WHERE app_jobs.lease_until<$3 RETURNING last_success`, [token,now()+240000,now()]));
      return row ? { token, since: Number(row.last_success) } : null;
    },
    async releaseJob(token) { await query("UPDATE app_jobs SET lease_until=0 WHERE id='disclosures' AND lease_token=$1", [token]); },
    async watchedCompanies() { return query(`SELECT DISTINCT f.corp_code FROM app_favorites f JOIN app_users u ON u.id=f.user_id
      WHERE u.email_enabled=1 OR EXISTS(SELECT 1 FROM app_push p WHERE p.user_id=f.user_id)`); },
    async recordDisclosure(event, observedAt) {
      await query(`INSERT INTO app_disclosures(receipt,corp_code,corp_name,report_name,receipt_date,first_seen)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(receipt) DO NOTHING`,
      [event.rcept_no,event.corp_code,event.corp_name,event.report_nm,event.rcept_dt,observedAt]);
      await transaction([
        [`INSERT INTO app_deliveries(id,user_id,receipt,channel,target_id)
          SELECT f.user_id||':'||e.receipt||':push:'||p.id,f.user_id,e.receipt,'push',p.id
          FROM app_disclosures e JOIN app_favorites f ON f.corp_code=e.corp_code JOIN app_push p ON p.user_id=f.user_id
          WHERE e.receipt=$1 AND f.monitoring_since>0 AND f.monitoring_since<=e.first_seen AND p.created_at<=e.first_seen
          ON CONFLICT(id) DO NOTHING`, [event.rcept_no]],
        [`INSERT INTO app_deliveries(id,user_id,receipt,channel,target_id)
          SELECT f.user_id||':'||e.receipt||':email',f.user_id,e.receipt,'email','email'
          FROM app_disclosures e JOIN app_favorites f ON f.corp_code=e.corp_code JOIN app_users u ON u.id=f.user_id
          WHERE e.receipt=$1 AND f.monitoring_since>0 AND f.monitoring_since<=e.first_seen AND u.email_enabled=1 AND u.email_since<=e.first_seen
          ON CONFLICT(id) DO NOTHING`, [event.rcept_no]]
      ]);
    },
    async completeScan(token, observedAt, incomplete = []) {
      const excluded = [...new Set(incomplete)];
      const clause = excluded.length ? ` AND corp_code NOT IN (${excluded.map((_,i)=>`$${i+3}`).join(',')})` : '';
      const queries = [['UPDATE app_favorites SET monitoring_since=$1 WHERE monitoring_since=0 AND created_at<=$2'+clause,[observedAt+1,observedAt,...excluded]]];
      if(!excluded.length) queries.push(["UPDATE app_jobs SET last_success=$1 WHERE id='disclosures' AND lease_token=$2",[observedAt,token]]);
      await transaction(queries);
    },
    async pendingDeliveries() { return query(`SELECT * FROM app_deliveries WHERE attempts<5 AND
      ((status='pending' AND next_attempt<=$1) OR (status='sending' AND lease_until<$1)) ORDER BY next_attempt,id LIMIT 40`, [now()]); },
    async claimDelivery(id) { return first(await query(`UPDATE app_deliveries SET status='sending',attempts=attempts+1,lease_until=$2
      WHERE id=$1 AND attempts<5 AND ((status='pending' AND next_attempt<=$3) OR (status='sending' AND lease_until<$3)) RETURNING *`, [id,now()+60000,now()])); },
    async deliveryTarget(delivery) { return first(await query(`SELECT e.*,u.email_enc,u.email_since,p.subscription_enc FROM app_deliveries d
      JOIN app_disclosures e ON e.receipt=d.receipt JOIN app_users u ON u.id=d.user_id
      JOIN app_favorites f ON f.user_id=d.user_id AND f.corp_code=e.corp_code
      LEFT JOIN app_push p ON p.user_id=d.user_id AND p.id=d.target_id
      WHERE d.id=$1 AND f.monitoring_since>0 AND f.monitoring_since<=e.first_seen AND
      ((d.channel='email' AND u.email_enabled=1 AND u.email_since<=e.first_seen) OR (d.channel='push' AND p.created_at<=e.first_seen))`, [delivery.id])); },
    async finishDelivery(id, status, delay = 0) { await query('UPDATE app_deliveries SET status=$2,next_attempt=$3,lease_until=0 WHERE id=$1', [id,status,now()+delay]); },
    async captureTelegram(chat,companies,events,observedAt,incomplete=[]) {
      const unhealthy=new Set(incomplete);
      const commands=[['INSERT INTO app_telegram_channels(chat_id) VALUES($1) ON CONFLICT(chat_id) DO NOTHING',[chat]]];
      for(const event of events) commands.push([`INSERT INTO app_telegram_deliveries(chat_id,receipt,event_json,created_at,status)
        VALUES($1,$2,$3,$4,CASE WHEN EXISTS(SELECT 1 FROM app_telegram_baselines WHERE chat_id=$1 AND corp_code=$5 AND started_at<=$4) THEN 'pending' ELSE 'baseline' END)
        ON CONFLICT(chat_id,receipt) DO NOTHING`,[chat,event.rcept_no,JSON.stringify(event),observedAt,event.corp_code]]);
      for(const company of companies.filter(item=>!unhealthy.has(item.corp_code))) commands.push([
        'INSERT INTO app_telegram_baselines(chat_id,corp_code,started_at) VALUES($1,$2,$3) ON CONFLICT(chat_id,corp_code) DO NOTHING',[chat,company.corp_code,observedAt+1]
      ]);
      await transaction(commands);
    },
    async telegramPending(chat) {
      // A process may have crashed after Telegram accepted a message. Never blindly resend that receipt.
      await query("UPDATE app_telegram_deliveries SET status='uncertain' WHERE chat_id=$1 AND status='sending' AND lease_until<$2",[chat,now()]);
      return query(`SELECT d.* FROM app_telegram_deliveries d JOIN app_telegram_channels c ON c.chat_id=d.chat_id
        WHERE d.chat_id=$1 AND d.status='pending' AND d.attempts<5 AND d.next_attempt<=$2 AND c.blocked_until<=$2 ORDER BY d.receipt LIMIT 8`,[chat,now()]);
    },
    async claimTelegram(chat,receipt) { return first(await query(`UPDATE app_telegram_deliveries SET status='sending',attempts=attempts+1,lease_until=$3
      WHERE chat_id=$1 AND receipt=$2 AND status='pending' AND next_attempt<=$4 AND attempts<5 RETURNING *`,[chat,receipt,now()+30000,now()])); },
    async finishTelegram(chat,receipt,status,delay=0,messageId=null) {
      await query('UPDATE app_telegram_deliveries SET status=$3,next_attempt=$4,lease_until=0,message_id=$5 WHERE chat_id=$1 AND receipt=$2',[chat,receipt,status,now()+delay,messageId]);
    },
    async pauseTelegram(chat,delay) { await query('UPDATE app_telegram_channels SET blocked_until=$2 WHERE chat_id=$1',[chat,now()+delay]); },
    async cleanup() { await transaction([
      ['DELETE FROM app_sessions WHERE expires_at<$1', [now()]],
      ['DELETE FROM app_disclosures WHERE first_seen<$1', [now()-30*86400000]],
      ['DELETE FROM app_telegram_deliveries WHERE created_at<$1',[now()-30*86400000]]
    ]); }
  };
}

let singleton;
function getAccountStore() {
  if (!singleton) {
    const url = process.env.ACCOUNTS_DATABASE_URL || process.env.DATABASE_URL;
    if (process.env.VERCEL && !url) throw new Error('ACCOUNTS_DATABASE_MISSING');
    singleton = createAccountStore(url ? neonDatabase(url) : sqliteDatabase(path.join(__dirname,'.data','accounts.sqlite')));
  }
  return singleton;
}
module.exports = { createAccountStore, getAccountStore, sqliteDatabase, neonDatabase, SCHEMA };
