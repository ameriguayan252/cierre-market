const fetch = require('node-fetch');
const XLSX = require('xlsx');
const { saveMetrics, logScrapeRun } = require('./storage');

const SOURCE = 'bcp';

const BCP_URLS = [
  { url: 'https://www.bcp.gov.py/anexo-estadistico-del-informe-economico-i365', type: 'page', name: 'economic_annex' },
  { url: 'https://www.bcp.gov.py/serie-historica-del-pib-base-2014-i643', type: 'page', name: 'pib_historical' },
  { url: 'https://www.bcp.gov.py/anexo-estadistico-informes-inflacion-i366', type: 'page', name: 'inflation_annex' },
  { url: 'https://www.bcp.gov.py/web/institucional/estadisticas1', type: 'page', name: 'stats_main' },
];

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 20000
    });
    return await res.text();
  } catch(e) {
    console.error(`[BCP] Failed to fetch ${url}:`, e.message);
    return null;
  }
}

async function downloadXLS(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 30000
    });
    if (!res.ok) return null;
    const buffer = await res.buffer();
    return XLSX.read(buffer, { type: 'buffer' });
  } catch(e) {
    console.error(`[BCP] XLS download failed ${url}:`, e.message);
    return null;
  }
}

function parseBCPWorkbook(workbook, datasetName, sourceUrl) {
  const metrics = [];
  
  // Key metrics we care about for real estate
  const metricKeywords = {
    'pib': { name: 'gdp_growth', unit: 'percent' },
    'crecimiento': { name: 'gdp_growth', unit: 'percent' },
    'inflacion': { name: 'inflation', unit: 'percent' },
    'inflación': { name: 'inflation', unit: 'percent' },
    'ipc': { name: 'cpi', unit: 'index' },
    'credito': { name: 'credit_total', unit: 'million_usd' },
    'crédito': { name: 'credit_total', unit: 'million_usd' },
    'construccion': { name: 'construction_credit', unit: 'million_usd' },
    'construcción': { name: 'construction_credit', unit: 'million_usd' },
    'tipo de cambio': { name: 'exchange_rate', unit: 'pyg_per_usd' },
    'cambio': { name: 'exchange_rate', unit: 'pyg_per_usd' },
  };
  
  for (const sheetName of workbook.SheetNames.slice(0, 10)) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
    const sheetLower = sheetName.toLowerCase();
    
    // Determine metric type from sheet name
    let metricInfo = null;
    for (const [keyword, info] of Object.entries(metricKeywords)) {
      if (sheetLower.includes(keyword)) {
        metricInfo = info;
        break;
      }
    }
    if (!metricInfo) metricInfo = { name: sheetName.toLowerCase().replace(/\s+/g, '_').slice(0, 40), unit: 'value' };
    
    // Parse rows looking for year/quarter/month + value
    for (const row of data) {
      if (!row || !Array.isArray(row)) continue;
      
      for (let i = 0; i < row.length - 1; i++) {
        const cell = row[i];
        
        // Year detection
        if (typeof cell === 'number' && cell >= 2015 && cell <= 2030) {
          const year = Math.floor(cell);
          const value = row[i + 1];
          
          if (typeof value === 'number' && isFinite(value) && value !== 0) {
            metrics.push({
              source: SOURCE,
              dataset_name: datasetName,
              period_type: 'yearly',
              period_year: year,
              geography_type: 'national',
              geography_name: 'Paraguay',
              metric_name: metricInfo.name,
              metric_value: value,
              unit: metricInfo.unit,
              confidence_level: 'high',
              source_url: sourceUrl,
              notes: `Sheet: ${sheetName}`
            });
          }
        }
        
        // String year detection
        if (typeof cell === 'string' && /^20(1[5-9]|2[0-9])$/.test(cell.trim())) {
          const year = parseInt(cell.trim());
          const value = row[i + 1];
          
          if (typeof value === 'number' && isFinite(value) && value !== 0) {
            metrics.push({
              source: SOURCE,
              dataset_name: datasetName,
              period_type: 'yearly',
              period_year: year,
              geography_type: 'national',
              geography_name: 'Paraguay',
              metric_name: metricInfo.name,
              metric_value: value,
              unit: metricInfo.unit,
              confidence_level: 'high',
              source_url: sourceUrl
            });
          }
        }
      }
    }
  }
  
  // Deduplicate
  const seen = new Set();
  return metrics.filter(m => {
    const key = `${m.metric_name}_${m.period_year}_${m.period_month || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function extractNumbersFromHTML(html, pageName, sourceUrl) {
  const metrics = [];
  
  // Look for percentage patterns (GDP growth, inflation)
  const pctMatches = html.matchAll(/(\d{4})[^\d]*?([+-]?\d+\.?\d*)\s*%/g);
  for (const m of pctMatches) {
    const year = parseInt(m[1]);
    const value = parseFloat(m[2]);
    if (year >= 2015 && year <= 2030 && Math.abs(value) < 100) {
      metrics.push({
        source: SOURCE,
        dataset_name: pageName,
        period_type: 'yearly',
        period_year: year,
        geography_type: 'national',
        geography_name: 'Paraguay',
        metric_name: 'growth_rate',
        metric_value: value,
        unit: 'percent',
        confidence_level: 'low',
        source_url: sourceUrl,
        notes: 'Extracted from HTML text'
      });
    }
  }
  
  return metrics;
}

async function scrapeBCP() {
  console.log('[BCP] Starting scrape...');
  let totalMetrics = 0;
  let filesDownloaded = 0;
  
  try {
    for (const { url, name } of BCP_URLS) {
      console.log(`[BCP] Fetching: ${url}`);
      const html = await fetchPage(url);
      if (!html) continue;
      
      // Find XLS/XLSX download links
      const xlsLinks = [];
      const matches = html.matchAll(/href="([^"]*\.(xls|xlsx)[^"]*)"/gi);
      for (const m of matches) {
        let link = m[1];
        if (!link.startsWith('http')) link = 'https://www.bcp.gov.py' + link;
        xlsLinks.push(link);
      }
      
      console.log(`[BCP] Found ${xlsLinks.length} XLS files on ${name}`);
      
      // Download XLS files
      for (const xlsUrl of xlsLinks.slice(0, 3)) {
        console.log(`[BCP] Downloading: ${xlsUrl}`);
        const workbook = await downloadXLS(xlsUrl);
        if (!workbook) continue;
        
        filesDownloaded++;
        const metrics = parseBCPWorkbook(workbook, name, xlsUrl);
        
        if (metrics.length > 0) {
          const saved = await saveMetrics(metrics);
          totalMetrics += saved;
          console.log(`[BCP] Saved ${saved} metrics from ${xlsUrl}`);
        }
        
        await new Promise(r => setTimeout(r, 1000));
      }
      
      // Also extract from HTML
      if (xlsLinks.length === 0) {
        const htmlMetrics = await extractNumbersFromHTML(html, name, url);
        if (htmlMetrics.length > 0) {
          const saved = await saveMetrics(htmlMetrics);
          totalMetrics += saved;
        }
      }
      
      await new Promise(r => setTimeout(r, 1500));
    }
    
    await logScrapeRun(SOURCE, 'success', totalMetrics, filesDownloaded, null);
    console.log(`[BCP] Complete. Metrics: ${totalMetrics}, Files: ${filesDownloaded}`);
    return { source: SOURCE, status: 'success', metrics: totalMetrics, files: filesDownloaded };
    
  } catch(e) {
    await logScrapeRun(SOURCE, 'error', 0, 0, e.message);
    console.error('[BCP] Error:', e.message);
    return { source: SOURCE, status: 'error', error: e.message };
  }
}

module.exports = { scrapeBCP };
