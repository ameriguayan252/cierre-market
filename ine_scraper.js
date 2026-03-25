const fetch = require('node-fetch');
const XLSX = require('xlsx');
const { saveMetrics, logScrapeRun } = require('./storage');

const SOURCE = 'ine';
const BASE_URL = 'https://www.ine.gov.py';

const DATASET_URLS = [
  'https://www.ine.gov.py/microdatos/?cant=27&tema=Proyecciones+de+Población',
];

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 15000
    });
    return await res.text();
  } catch(e) {
    console.error('[INE] Failed to fetch ' + url + ':', e.message);
    return null;
  }
}

async function downloadXLS(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 30000
    });
    const buffer = await res.buffer();
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    return workbook;
  } catch(e) {
    console.error('[INE] Failed to download XLS ' + url + ':', e.message);
    return null;
  }
}

function parsePopulationWorkbook(workbook, sourceUrl) {
  const metrics = [];
  
  for (const sheetName of workbook.SheetNames.slice(0, 5)) {
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
    if (!data || data.length < 2) continue;

    let headerRowIdx = -1;
    let yearCols = {};
    
    for (let r = 0; r < Math.min(10, data.length); r++) {
      const row = data[r];
      if (!row) continue;
      let yearCount = 0;
      for (let c = 0; c < row.length; c++) {
        const val = row[c];
        if (typeof val === 'number' && val >= 2000 && val <= 2030) {
          yearCols[c] = Math.floor(val);
          yearCount++;
        }
      }
      if (yearCount >= 5) { headerRowIdx = r; break; }
    }

    if (headerRowIdx >= 0 && Object.keys(yearCols).length > 0) {
      for (let r = headerRowIdx + 1; r < Math.min(headerRowIdx + 20, data.length); r++) {
        const row = data[r];
        if (!row) continue;
        const label = String(row[0] || row[1] || '').toLowerCase();
        const isTotal = label.includes('total') || label.includes('ambos') || label === '' || r === headerRowIdx + 1;
        if (!isTotal) continue;

        for (const [col, year] of Object.entries(yearCols)) {
          const val = row[parseInt(col)];
          if (typeof val === 'number' && val > 500000 && val < 20000000) {
            metrics.push({
              source: SOURCE,
              dataset_name: 'population_projection',
              period_type: 'yearly',
              period_year: year,
              geography_type: 'national',
              geography_name: 'Paraguay',
              metric_name: 'population',
              metric_value: Math.round(val),
              unit: 'persons',
              confidence_level: 'high',
              source_url: sourceUrl,
              notes: 'Sheet: ' + sheetName
            });
          }
        }
        break;
      }
    } else {
      for (const row of data) {
        if (!row || row.length < 2) continue;
        for (let i = 0; i < row.length - 1; i++) {
          const cell = row[i];
          if (typeof cell === 'number' && cell >= 2000 && cell <= 2030) {
            const year = Math.floor(cell);
            const value = row[i + 1];
            if (typeof value === 'number' && value > 1000000 && value < 20000000) {
              metrics.push({
                source: SOURCE,
                dataset_name: 'population_projection',
                period_type: 'yearly',
                period_year: year,
                geography_type: 'national',
                geography_name: 'Paraguay',
                metric_name: 'population',
                metric_value: Math.round(value),
                unit: 'persons',
                confidence_level: 'high',
                source_url: sourceUrl,
                notes: 'Sheet: ' + sheetName + ' (fallback)'
              });
            }
          }
        }
      }
    }
  }
  
  const seen = new Set();
  return metrics.filter(m => {
    const key = m.period_year + '_' + m.geography_name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function scrapeINE() {
  console.log('[INE] Starting scrape...');
  let totalMetrics = 0;
  let filesDownloaded = 0;
  
  try {
    const html = await fetchPage(DATASET_URLS[0]);
    if (!html) throw new Error('Could not fetch INE page');
    
    const xlsLinks = [];
    const matches = html.matchAll(/href="([^"]*\.(xls|xlsx|csv)[^"]*)"/gi);
    for (const match of matches) {
      let url = match[1];
      if (!url.startsWith('http')) url = BASE_URL + url;
      xlsLinks.push(url);
    }
    
    console.log('[INE] Found ' + xlsLinks.length + ' data files');
    
    for (const url of xlsLinks.slice(0, 5)) {
      console.log('[INE] Downloading: ' + url);
      const workbook = await downloadXLS(url);
      if (!workbook) continue;
      
      filesDownloaded++;
      const metrics = parsePopulationWorkbook(workbook, url);
      
      if (metrics.length > 0) {
        const saved = await saveMetrics(metrics);
        totalMetrics += saved;
        console.log('[INE] Saved ' + saved + ' metrics from ' + url);
      }
      
      await new Promise(r => setTimeout(r, 1000));
    }
    
    await logScrapeRun(SOURCE, 'success', totalMetrics, filesDownloaded, null);
    console.log('[INE] Complete. Metrics: ' + totalMetrics + ', Files: ' + filesDownloaded);
    return { source: SOURCE, status: 'success', metrics: totalMetrics, files: filesDownloaded };
    
  } catch(e) {
    await logScrapeRun(SOURCE, 'error', 0, 0, e.message);
    console.error('[INE] Error:', e.message);
    return { source: SOURCE, status: 'error', error: e.message };
  }
}

module.exports = { scrapeINE };
