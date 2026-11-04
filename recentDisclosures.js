// 대형 대표기업과 소비자에게 익숙한 브랜드 기업을 함께 선정한 편집 목록입니다.
// 인기 순위나 투자 추천 목록이 아니며, 종목코드로 비교해 상호 변경에 대응합니다.
const FEATURED_STOCK_CODES = new Set([
  '005930', '000660', '005380', '000270', '035420', '035720',
  '373220', '051910', '006400', '005490', '086280', '207940',
  '068270', '028260', '012330', '066570', '034020', '012450',
  '009540', '329180', '003550', '017670', '030200', '032640',
  '015760', '096770', '034730', '105560', '055550', '086790',
  '316140', '000810', '032830', '033780', '018260', '010950',
  '011200', '003490', '036570', '251270', '259960', '352820',
  '041510', '035900', '051900', '090430', '271560', '097950',
  '004170', '139480', '008770', '023530', '004990', '004370',
  '007310', '005300', '282330', '007070', '030000', '036460'
]);
const REFRESH_MS = 5 * 60 * 1000;
const MAX_STALE_MS = 24 * 60 * 60 * 1000;
const { randomUUID } = require('node:crypto');
const DISPLAY_LIMIT = 5;

function dateAtKst(timestamp, daysAgo = 0) {
  return new Date(timestamp + 9 * 3600000 - daysAgo * 86400000)
    .toISOString().slice(0, 10).replace(/-/g, '');
}

function reportType(reportName) {
  const title = reportName.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, '');
  if (title.startsWith('사업보고서(')) return '사업보고서';
  if (title.startsWith('반기보고서(')) return '반기보고서';
  if (/^(?:1분기보고서|분기보고서)\(\d{4}\.03/.test(title)) return '1분기보고서';
  if (/^(?:3분기보고서|분기보고서)\(\d{4}\.09/.test(title)) return '3분기보고서';
  if (title.includes('잠정') && title.includes('실적')) return '잠정실적';
  return null;
}

// 공시 양식에 계정명이 있어도 값이 모두 '-'인 월간 판매대수 발표는 제외합니다.
// 기존 원문 추출기의 셀 구분자(|)를 사용해 날짜·판매대수를 재무금액으로 오인하지 않습니다.
function hasFinancialResults(text) {
  const cells = text.split('|').map(cell => cell.replace(/\s+/g, ''));
  const metric = /^(?:매출액|영업수익|영업이익(?:\(손실\))?|당기순이익(?:\(손실\))?)$/;
  const number = /^[△▲+\-−]?\(?\d[\d,.]*\)?$/;
  for (let i = 0; i < cells.length; i++) {
    if (!metric.test(cells[i])) continue;
    let valueIndex = i + 1;
    if (/^(?:당해실적|당기실적|누계실적)$/.test(cells[valueIndex])) valueIndex++;
    if (number.test(cells[valueIndex] || '')) return true;
  }
  return false;
}

function compareReports(a, b) {
  return b.rcept_dt.localeCompare(a.rcept_dt) ||
    Number(reportType(a.report_nm) === '잠정실적') - Number(reportType(b.report_nm) === '잠정실적') ||
    Number(b.report_nm.includes('연결재무제표')) - Number(a.report_nm.includes('연결재무제표')) ||
    b.rcept_no.localeCompare(a.rcept_no);
}

function createRecentDisclosureService({ fetchList, fetchDocumentText, now = () => Date.now(),
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)), onDocumentError = () => {},
  sharedStore, namespace = 'finalyze:recent:v3:5' }) {
  let cached = null;
  let inFlight = null;
  let retryAfter = 0;
  const documentChecks = new Map();

  async function withTransientRetry(operation) {
    try {
      return await operation();
    } catch (error) {
      const status = error.response?.status;
      const transient = ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error.code) ||
        status === 408 || status === 429 || (status >= 500 && status <= 599);
      if (!transient) throw error;
      await pause(250);
      return operation();
    }
  }

  async function fetchPage(params) {
    let data;
    try {
      data = await withTransientRetry(() => fetchList({ ...params, page_count: 100, sort: 'date', sort_mth: 'desc', last_reprt_at: 'Y' }));
    } catch (error) {
      error.stage = 'list';
      throw error;
    }
    if (data.status === '013') return { list: [], total_page: 0 };
    if (data.status !== '000' || !Array.isArray(data.list)) {
      throw Object.assign(new Error('DART 공시 목록을 확인하지 못했습니다.'), { stage: 'list', dartStatus: data.status });
    }
    return data;
  }

  async function fetchWindow(timestamp, firstDayAgo, lastDayAgo, failedDocuments, previousRows = []) {
    const dates = { bgn_de: dateAtKst(timestamp, lastDayAgo), end_de: dateAtKst(timestamp, firstDayAgo) };
    const sources = [{ ...dates, pblntf_ty: 'A' }, { ...dates, pblntf_detail_ty: 'I002' }];
    const firstPages = await Promise.all(sources.map(params => fetchPage({ ...params, page_no: 1 })));
    const rows = firstPages.flatMap(data => data.list);
    const states = firstPages.map((data, index) => ({ params: sources[index], page: 1,
      total: Number(data.total_page), oldest: data.list.at(-1)?.rcept_dt }));
    while (true) {
      const selected = await selectReports([...previousRows, ...rows], failedDocuments);
      const cutoff = selected.length >= DISPLAY_LIMIT ? selected[DISPLAY_LIMIT - 1].rcept_dt : null;
      // 5개를 확보하고 나머지 페이지가 모두 더 오래되면 조회를 마칩니다.
      // 같은 날짜의 연결·정정 공시는 다음 페이지까지 확인합니다.
      const pending = states.filter(state => state.page < state.total && (!cutoff || state.oldest >= cutoff));
      if (!pending.length) break;
      const pages = await Promise.all(pending.map(state => fetchPage({ ...state.params, page_no: state.page + 1 })));
      pages.forEach((data, index) => {
        pending[index].page++;
        pending[index].oldest = data.list.at(-1)?.rcept_dt;
        rows.push(...data.list);
      });
    }
    return rows;
  }

  async function isEligible(row) {
    if (reportType(row.report_nm) !== '잠정실적') return true;
    if (!documentChecks.has(row.rcept_no)) {
      const text = await withTransientRetry(() => fetchDocumentText(row.rcept_no));
      if (documentChecks.size >= 256) documentChecks.delete(documentChecks.keys().next().value);
      documentChecks.set(row.rcept_no, hasFinancialResults(text));
    }
    return documentChecks.get(row.rcept_no);
  }

  async function selectReports(rows, failedDocuments) {
    const groups = new Map();
    const receipts = new Set();
    rows.filter(row => FEATURED_STOCK_CODES.has(row.stock_code) && ['Y', 'K'].includes(row.corp_cls) &&
      /^\d{8}$/.test(row.corp_code) && /^\d{14}$/.test(row.rcept_no) && /^\d{8}$/.test(row.rcept_dt) &&
      typeof row.corp_name === 'string' && typeof row.report_nm === 'string' && !/자회사의\s*주요경영사항/.test(row.report_nm) &&
      !/[철정]/.test(row.rm || '') && reportType(row.report_nm))
      .sort(compareReports).forEach(row => {
        if (receipts.has(row.rcept_no)) return;
        receipts.add(row.rcept_no);
        if (!groups.has(row.corp_code)) groups.set(row.corp_code, []);
        groups.get(row.corp_code).push(row);
      });
    const companies = [...groups.values()];
    const selected = [];
    for (let i = 0; i < companies.length; i += 4) {
      const batch = await Promise.all(companies.slice(i, i + 4).map(async reports => {
        for (const row of reports) {
          if (failedDocuments.has(row.rcept_no)) continue;
          try {
            if (await isEligible(row)) return row;
          } catch (error) {
            // 원문 한 건의 장애로 전체 목록이 중단되지 않도록 다른 공시를 계속 확인합니다.
            // 실패는 적격/부적격 판정으로 저장하지 않아 다음 갱신에서 재시도합니다.
            failedDocuments.add(row.rcept_no);
            onDocumentError(row.rcept_no, error);
          }
        }
        return null;
      }));
      selected.push(...batch.filter(Boolean));
      selected.sort(compareReports);
      // 월간 공시를 건너뛴 기업의 이전 보고서보다 최근인 다른 기업도 계속 확인합니다.
      const next = companies[i + 4];
      if (selected.length >= DISPLAY_LIMIT && (!next || next[0].rcept_dt < selected[DISPLAY_LIMIT - 1].rcept_dt)) break;
    }
    return selected.slice(0, DISPLAY_LIMIT).map(row => ({
      corp_code: row.corp_code,
      corp_name: row.corp_name.trim(),
      stock_code: row.stock_code,
      report_nm: row.report_nm.trim(),
      rcept_no: row.rcept_no,
      rcept_dt: row.rcept_dt,
      type: reportType(row.report_nm),
      corrected: /정정/.test(row.report_nm)
    }));
  }

  async function refresh(timestamp) {
    const failedDocuments = new Set();
    const rows = await fetchWindow(timestamp, 0, 29, failedDocuments);
    let data = await selectReports(rows, failedDocuments);
    let lookbackDays = 30;
    if (data.length < DISPLAY_LIMIT) {
      rows.push(...await fetchWindow(timestamp, 30, 89, failedDocuments, rows));
      data = await selectReports(rows, failedDocuments);
      lookbackDays = 90;
    }
    const partial = failedDocuments.size > 0;
    if (partial && data.length === 0) {
      throw Object.assign(new Error('잠정실적 원문을 확인하지 못했습니다.'), { stage: 'document' });
    }
    cached = { status: 'success', data, updatedAt: new Date(timestamp).toISOString(), lookbackDays,
      companyCount: FEATURED_STOCK_CODES.size, refreshSeconds: partial ? 60 : REFRESH_MS / 1000, stale: false, partial };
    retryAfter = 0;
    return cached;
  }

  async function refreshShared(timestamp) {
    if (!sharedStore) return refresh(timestamp);
    const storage = typeof sharedStore === 'function' ? sharedStore() : sharedStore;
    const snapshotKey = `${namespace}:snapshot`;
    function adopt(value) {
      if (value && Array.isArray(value.data) && value.data.length <= DISPLAY_LIMIT) cached = value;
      return cached && timestamp - Date.parse(cached.updatedAt) < cached.refreshSeconds * 1000;
    }
    if (adopt(await storage.get(snapshotKey))) return cached;
    if (await storage.get(`${namespace}:retry`)) throw new Error('공시 목록을 잠시 후 다시 확인해주세요.');
    const token = randomUUID();
    const lockKey = `${namespace}:lock`;
    if (!await storage.lock(lockKey, token, 120)) {
      if (cached && timestamp - Date.parse(cached.updatedAt) < MAX_STALE_MS) return { ...cached, stale: true };
      for (let attempt = 0; attempt < 40; attempt++) {
        await pause(500);
        if (adopt(await storage.get(snapshotKey))) return cached;
      }
      throw new Error('공시 목록을 갱신하고 있습니다. 잠시 후 다시 확인해주세요.');
    }
    try {
      if (adopt(await storage.get(snapshotKey))) return cached;
      const result = await refresh(timestamp);
      await storage.set(snapshotKey, result, MAX_STALE_MS / 1000);
      return result;
    } catch (error) {
      await storage.set(`${namespace}:retry`, true, 60).catch(() => {});
      throw error;
    } finally {
      await storage.unlock(lockKey, token).catch(() => {});
    }
  }

  return {
    async getRecentDisclosures() {
      const timestamp = now();
      const age = cached ? timestamp - Date.parse(cached.updatedAt) : Infinity;
      if (cached && age < cached.refreshSeconds * 1000) return cached;
      if (timestamp < retryAfter && age < MAX_STALE_MS) return { ...cached, stale: true };
      if (!inFlight) {
        inFlight = refreshShared(timestamp).catch(error => {
          retryAfter = now() + 60 * 1000;
          if (cached && now() - Date.parse(cached.updatedAt) < MAX_STALE_MS) return { ...cached, stale: true };
          throw error;
        }).finally(() => { inFlight = null; });
      }
      return inFlight;
    }
  };
}

module.exports = { createRecentDisclosureService, hasFinancialResults, reportType };
