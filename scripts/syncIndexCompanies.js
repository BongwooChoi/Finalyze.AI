// Reconcile only missing index constituents against the official DART company-code ZIP.
const fs = require('node:fs/promises');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const AdmZip = require('adm-zip');
const { parseStringPromise } = require('xml2js');
const dartClient = require('../dartClient');
const { getIndexStockCodes } = require('../indexUniverse');

async function main() {
  const apply = process.argv.includes('--apply');
  const dbPath = path.join(__dirname, '../dart.db');
  const db = new sqlite3.Database(dbPath, apply ? sqlite3.OPEN_READWRITE : sqlite3.OPEN_READONLY);
  const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
  const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, error => error ? reject(error) : resolve()));
  try {
    const codes = getIndexStockCodes();
    const existing = await all('SELECT corp_code,stock_code FROM companies');
    const missing = codes.filter(code => !existing.some(row => row.stock_code === code));
    if (!missing.length) { console.log('All index companies are mapped in dart.db.'); return; }
    const response = await dartClient.get('https://opendart.fss.or.kr/api/corpCode.xml', { responseType: 'arraybuffer', timeout: 30000 });
    const entry = new AdmZip(response.data).getEntries().find(item => /CORPCODE\.xml$/i.test(item.entryName));
    if (!entry) throw new Error('DART_COMPANY_XML_MISSING');
    const parsed = await parseStringPromise(entry.getData().toString('utf8'), { explicitArray: false, trim: true });
    const companies = parsed.result?.list;
    if (!Array.isArray(companies)) throw new Error('DART_COMPANY_LIST_INVALID');
    const additions = missing.map(code => {
      const matches = companies.filter(row => row.stock_code === code);
      if (matches.length !== 1 || !/^\d{8}$/.test(matches[0].corp_code) || !matches[0].corp_name) {
        throw new Error(`DART_INDEX_MAPPING_UNRESOLVED:${code}`);
      }
      return matches[0];
    });
    console.log(JSON.stringify({ apply, companies: additions.map(({ corp_code, corp_name, stock_code }) => ({ corp_code, corp_name, stock_code })) }));
    if (!apply) { console.log('Run with --apply to update these verified missing mappings.'); return; }
    const backupDir = path.join(__dirname, '../.data');
    await fs.mkdir(backupDir, { recursive: true });
    await fs.copyFile(dbPath, path.join(backupDir, `dart-before-index-sync-${Date.now()}.db`));
    await run('BEGIN IMMEDIATE');
    try {
      for (const row of additions) {
        await run(`INSERT INTO companies (corp_code,corp_name,corp_eng_name,stock_code,modify_date) VALUES (?,?,?,?,?)
          ON CONFLICT(corp_code) DO UPDATE SET corp_name=excluded.corp_name,corp_eng_name=excluded.corp_eng_name,
          stock_code=excluded.stock_code,modify_date=excluded.modify_date`,
        [row.corp_code,row.corp_name,row.corp_eng_name || '',row.stock_code,row.modify_date || '']);
      }
      await run('COMMIT');
    } catch (error) { await run('ROLLBACK'); throw error; }
    console.log(`Updated ${additions.length} DART company mappings.`);
  } finally { await new Promise(resolve => db.close(resolve)); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
