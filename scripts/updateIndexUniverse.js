// Import the two official KRX "지수구성종목" CSV exports for the same trading date.
// No credentials or live KRX requests are needed by the production application.
const fs = require('node:fs');
const path = require('node:path');
const { INDEX_DEFINITIONS, SOURCE_URL, sourceUrl, validateUniverse } = require('../indexUniverse');

function parseCsv(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n')) {
      row.push(field.replace(/\r$/, '')); field = '';
      if (c === '\n') { if (row.some(cell => cell.trim())) rows.push(row); row = []; }
    } else field += c;
  }
  if (quoted) throw new Error('KRX_CSV_UNCLOSED_QUOTE');
  row.push(field.replace(/\r$/, ''));
  if (row.some(cell => cell.trim())) rows.push(row);
  return rows;
}
function readConstituents(buffer) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { text = new TextDecoder('euc-kr', { fatal: true }).decode(buffer); }
  const rows = parseCsv(text.replace(/^\uFEFF/, ''));
  const headers = rows.shift()?.map(cell => cell.trim()) || [];
  const codeColumn = headers.indexOf('종목코드'), nameColumn = headers.indexOf('종목명');
  if (codeColumn < 0 || nameColumn < 0) throw new Error('KRX_CSV_HEADERS_REQUIRED');
  return rows.map(row => ({ stockCode: row[codeColumn]?.trim(), name: row[nameColumn]?.trim() }))
    .sort((a, b) => a.stockCode.localeCompare(b.stockCode));
}
function buildUniverse(asOf, buffers, options = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf || '') || !Number.isFinite(Date.parse(asOf)) ||
      asOf > new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)) throw new Error('KRX_AS_OF_INVALID');
  return validateUniverse({ schemaVersion: 1, asOf,
    source: { name: '한국거래소 KRX 지수정보 · 구성종목', url: SOURCE_URL },
    indices: INDEX_DEFINITIONS.map(index => ({ id: index.id, name: index.name, sourceUrl: sourceUrl(index),
      reportedCount: options[`${index.id}-count`] === undefined ? index.count : Number(options[`${index.id}-count`]),
      countNote: options[`${index.id}-count-note`] || '',
      constituents: readConstituents(buffers[index.id]) })) });
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--as-of', '--kospi200', '--kosdaq150', '--kospi200-count', '--kosdaq150-count',
        '--kospi200-count-note', '--kosdaq150-count-note'].includes(args[i]) || !args[i + 1]) throw new Error('Invalid arguments');
      options[args[i].slice(2)] = args[i + 1];
    }
    if (!options.kospi200 || !options.kosdaq150) throw new Error('Both KRX CSV files are required');
    const data = buildUniverse(options['as-of'], Object.fromEntries(INDEX_DEFINITIONS.map(index =>
      [index.id, fs.readFileSync(options[index.id])])), options);
    const output = path.join(__dirname, '../public/data/disclosure-universe.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const temporary = `${output}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(temporary, output);
    console.log(`KRX ${data.asOf}: ${data.indices.map(index => `${index.name} ${index.constituents.length}종목`).join(' + ')} 저장`);
  } catch (error) {
    console.error(error.message);
    console.error('Usage: npm run update:index-universe -- --as-of YYYY-MM-DD --kospi200 <KRX.csv> --kosdaq150 <KRX.csv>');
    process.exitCode = 1;
  }
}
module.exports = { parseCsv, readConstituents, buildUniverse };
