const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { validateUniverse, getIndexStockCodes, getIndexUniverseSummary } = require('../indexUniverse');
const { readConstituents, buildUniverse } = require('../scripts/updateIndexUniverse');
const data = require('../public/data/disclosure-universe.json');
const reportedTotal = data.indices.reduce((sum, index) => sum + index.reportedCount, 0);

test('KRX snapshot contains all officially reported constituents and exposes dated provenance', () => {
  assert.equal(validateUniverse(data), data);
  assert.deepEqual(data.indices.map(index => index.constituents.length), data.indices.map(index => index.reportedCount));
  const codes = getIndexStockCodes();
  assert.equal(codes.length, reportedTotal);
  assert.equal(new Set(codes).size, reportedTotal);
  codes.pop();
  assert.equal(getIndexStockCodes().length, reportedTotal);
  const summary = getIndexUniverseSummary();
  assert.equal(summary.asOf, data.asOf);
  assert.match(summary.source.url, /^https:\/\/index\.krx\.co\.kr\//);
  assert.match(summary.revision, /^[a-f0-9]{16}$/);
  summary.indices[0].count = 0;
  assert.equal(getIndexUniverseSummary().indices[0].count, data.indices[0].reportedCount);
});

test('incomplete, duplicate, malformed and mixed index snapshots are rejected', () => {
  for (const change of [
    value => value.indices[0].constituents.pop(),
    value => { value.indices[1].constituents[0].stockCode = value.indices[0].constituents[0].stockCode; },
    value => { value.indices[0].constituents[0].stockCode = '5930'; },
    value => { value.asOf = '2026-02-30'; },
    value => { value.source.url = 'https://example.com'; },
    value => { value.indices[1].id = 'kospi200'; }
  ]) {
    const changed = structuredClone(data); change(changed);
    assert.throws(() => validateUniverse(changed));
  }
});

test('KRX CSV preserves leading zeros, quoted commas and Korean names', () => {
  assert.deepEqual(readConstituents(Buffer.from('\uFEFF종목코드,종목명,종가\r\n"005930","삼성전자","100,000"\r\n"000660","회사, A","200,000"\r\n')),
    [{ stockCode: '000660', name: '회사, A' }, { stockCode: '005930', name: '삼성전자' }]);
  assert.throws(() => readConstituents(Buffer.from('code,name\n005930,Samsung')), /HEADERS/);
  assert.throws(() => readConstituents(Buffer.from('종목코드,종목명\n"005930,삼성전자')), /QUOTE/);
});

test('CSV import validates both full indices and rejects a future effective date', () => {
  const buffers = Object.fromEntries(data.indices.map(index => [index.id,
    Buffer.from('종목코드,종목명\n' + index.constituents.map(row => `${row.stockCode},${row.name}`).join('\n'))]));
  const options = Object.fromEntries(data.indices.flatMap(index => [[`${index.id}-count`, index.reportedCount], [`${index.id}-count-note`, index.countNote]]));
  const rebuilt = buildUniverse(data.asOf, buffers, options);
  assert.deepEqual(rebuilt, data);
  assert.throws(() => buildUniverse('2999-01-01', buffers), /AS_OF/);
  if (data.indices.some(index => index.reportedCount !== (index.id === 'kospi200' ? 200 : 150))) {
    assert.throws(() => buildUniverse(data.asOf, buffers), /COUNT/);
  }
  assert.throws(() => buildUniverse(data.asOf, { ...buffers, kosdaq150: Buffer.from('종목코드,종목명\n005930,삼성전자') }, options), /COUNT/);
});

test('every constituent maps to exactly one DART company for Telegram collection', async () => {
  const db = new sqlite3.Database(path.join(__dirname, '../dart.db'), sqlite3.OPEN_READONLY);
  try {
    const codes = getIndexStockCodes();
    const rows = await new Promise((resolve, reject) => db.all(
      `SELECT stock_code,corp_code FROM companies WHERE stock_code IN (${codes.map(() => '?').join(',')})`, codes,
      (error, rows) => error ? reject(error) : resolve(rows)));
    for (const code of codes) {
      const matches = rows.filter(row => row.stock_code === code);
      assert.equal(matches.length, 1, `DART mapping missing or duplicate: ${code}`);
      assert.match(matches[0].corp_code, /^\d{8}$/);
    }
    assert.equal(new Set(rows.map(row => row.corp_code)).size, codes.length);
  } finally { await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve())); }
});

test('current public copy and presentation do not retain the former curated scope', () => {
  for (const file of ['public/index.html', 'README.md', 'CLAUDE.md', 'docs/telegram-disclosures.md',
    'output/presentations/vibe-coding-20261107/index.html', 'output/presentations/vibe-coding-20261107/speaker-notes.html']) {
    const absolute = path.join(__dirname, '..', file);
    if (!fs.existsSync(absolute)) continue; // Presentation artifacts are local and not required in CI.
    assert.doesNotMatch(fs.readFileSync(absolute, 'utf8'), /(?:대표기업|주요 기업)\s*60개|FEATURED_STOCK_CODES/);
  }
});
