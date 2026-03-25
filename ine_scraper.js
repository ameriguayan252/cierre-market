const fetch = require('node-fetch');
const XLSX = require('xlsx');
const { saveMetrics, logScrapeRun } = require('./storage');

const SOURCE = 'ine';
const BASE_URL = 'https://www.ine.gov.py';

// Known INE dataset URLs for population projections
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
    console.error(`[INE] Failed to fetch ${url}:`, e.message);
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
    console.error(`[INE] Failed to download XLS ${url}:`, e.message);
    return null;
  }
}

function parsePopulationWorkbook(workbook, sourceUrl) {
  const metrics = [];
  
  for (const sheetName of workbook.SheetNames.slice(0, 5)) {
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
    
    // Look for rows with year + population data
    for (const row of data) {
      if (!row || row.length < 2) continue;
      
      // Try to find year column and value column
      for (let i = 0; i < row.length; i++) {
        const cell = row[i];
        if (typeof cell === 'number' && cell >= 2000 && cell <= 2030) {
          // This looks like a year
          const year = Math.floor(cell);
          const value = row[i + 1];
          
          if (typeof value === 'number' && value > 1000) {
            // Determine geography from sheet name
            const geoName = sheetName.includes('Paraguay') ? 'Paraguay' :
                           sheetName.includes('Central') ? 'Central' :
                           sheetName.includes('Asunción') || sheetName.includes('Asuncion') ? 'Asunción' :
                           sheetName;
            
            metrics.push({
              source: SOURCE,
              dataset_name: 'population_projection',
              period_type: 'yearly',
              period_year: year,
              geography_type: geoName === 'Paraguay' ? 'national' : 'department',
              geography_name: geoName,
              metric_name: 'population',
              metric_value: value,
              unit: 'persons',
              confidence_level: 'high',
              source_url: sourceUrl,
              notes: `Sheet: ${sheetName}`
            });
          }
        }
      }
    }
  }
  
  return metrics;
}

async function scrapeINE() {
  console.log('[INE] Starting scrape...');
  const runId = `run_${Date.now()}_ine`;
  let totalMetrics = 0;
  let filesDownloaded = 0;
  
  try {
    // Fetch the main INE population page
    const html = await fetchPage(DATASET_URLS[0]);
    if (!html) throw new Error('Could not fetch INE page');
    
    // Find XLS/CSV download links
    const xlsLinks = [];
    const matches = html.matchAll(/href="([^"]*\.(xls|xlsx|csv)[^"]*)"/gi);
    for (const match of matches) {
      let url = match[1];
      if (!url.startsWith('http')) url = BASE_URL + url;
      xlsLinks.push(url);
    }
    
    console.log(`[INE] Found ${xlsLinks.length} data files`);
    
    // Download and parse each file
    for (const url of xlsLinks.slice(0, 5)) {
      console.log(`[INE] Downloading: ${url}`);
      const workbook = await downloadXLS(url);
      if (!workbook) continue;
      
      filesDownloaded++;
      const metrics = parsePopulationWorkbook(workbook, url);
      
      if (metrics.length > 0) {
        const saved = await saveMetrics(metrics);
        totalMetrics += saved;
        console.log(`[INE] Saved ${saved} metrics from ${url}`);
      }
      
      await new Promise(r => setTimeout(r, 1000));
    }
    
    // If no XLS found, try to extract numbers from the page
    if (xlsLinks.length === 0 && html) {
      console.log('[INE] No XLS found, extracting from page...');
      // Look for population numbers in the HTML
      const popMatches = html.matchAll(/(\d{4}).*?(\d{1,3}(?:[.,]\d{3})+)/g);
      const metrics = [];
      for (const m of popMatches) {
        const year = parseInt(m[1]);
        if (year >= 2015 && year <= 2030) {
          const value = parseFloat(m[2].replace(/[.,]/g, '').slice(0, -3));
          if (value > 1000000) {
            metrics.push({
              source: SOURCE,
              dataset_name: 'population_page',
              period_type: 'yearly',
              period_year: year,
              geography_type: 'national',
              geography_name: 'Paraguay',
              metric_name: 'population',
              metric_value: value,
              unit: 'persons',
              confidence_level: 'medium',
              source_url: DATASET_URLS[0]
            });
          }
        }
      }
      if (metrics.length) {
        totalMetrics = await saveMetrics(metrics);
      }
    }
    
    await logScrapeRun(SOURCE, 'success', totalMetrics, filesDownloaded, null);
    console.log(`[INE] Complete. Metrics: ${totalMetrics}, Files: ${filesDownloaded}`);
    return { source: SOURCE, status: 'success', metrics: totalMetrics, files: filesDownloaded };
    
  } catch(e) {
    await logScrapeRun(SOURCE, 'error', 0, 0, e.message);
    console.error('[INE] Error:', e.message);
    return { source: SOURCE, status: 'error', error: e.message };
  }
}

module.exports = { scrapeINE };
