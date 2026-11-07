const { createHash } = require('node:crypto');

const INDEX_DEFINITIONS = Object.freeze([
  { id: 'kospi200', name: '코스피200', count: 200, query: 'upmidCd=0102&idxCd=1028&idxId=K2G01P' },
  { id: 'kosdaq150', name: '코스닥150', count: 150, query: 'upmidCd=0103&idxCd=2203&idxId=Q5G01P' }
]);
const SOURCE_URL = 'https://index.krx.co.kr/';
const sourceUrl = definition => `${SOURCE_URL}contents/MKD/03/0304/03040101/MKD03040101T3.jsp?${definition.query}`;

function validateUniverse(data) {
  if (data?.schemaVersion !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(data.asOf || '') ||
      new Date(data.asOf).toISOString().slice(0, 10) !== data.asOf ||
      data.source?.url !== SOURCE_URL || !Array.isArray(data.indices) || data.indices.length !== 2) {
    throw new Error('INDEX_UNIVERSE_INVALID_METADATA');
  }
  const codes = new Set();
  for (const definition of INDEX_DEFINITIONS) {
    const index = data.indices.find(item => item.id === definition.id);
    if (index?.name !== definition.name || index.sourceUrl !== sourceUrl(definition) ||
        !Number.isInteger(index.reportedCount) || index.reportedCount < 1 || index.reportedCount > 1000 ||
        !Array.isArray(index.constituents) || index.constituents.length !== index.reportedCount ||
        (index.reportedCount !== definition.count && (typeof index.countNote !== 'string' || !index.countNote.trim()))) {
      throw new Error(`INDEX_UNIVERSE_INVALID_COUNT:${definition.id}`);
    }
    for (const item of index.constituents) {
      if (!/^[0-9A-Z]{6}$/.test(item.stockCode || '') || typeof item.name !== 'string' || !item.name.trim() || codes.has(item.stockCode)) {
        throw new Error(`INDEX_UNIVERSE_INVALID_CONSTITUENT:${definition.id}`);
      }
      codes.add(item.stockCode);
    }
  }
  return data;
}

let snapshot;
function universe() {
  if (!snapshot) snapshot = validateUniverse(require('./public/data/disclosure-universe.json'));
  return snapshot;
}
function getIndexStockCodes() {
  return universe().indices.flatMap(index => index.constituents.map(item => item.stockCode));
}
function getIndexUniverseSummary() {
  const data = universe();
  return { label: '코스피200·코스닥150', asOf: data.asOf, source: { ...data.source },
    indices: data.indices.map(index => ({ id: index.id, name: index.name, count: index.constituents.length })),
    companyCount: getIndexStockCodes().length,
    revision: createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16) };
}

module.exports = { INDEX_DEFINITIONS, SOURCE_URL, sourceUrl, validateUniverse, getIndexStockCodes, getIndexUniverseSummary };
