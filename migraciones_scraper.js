const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { saveMetrics, logScrapeRun } = require('./storage');

const SOURCE = 'migraciones';

const URLS = [
  'https://migraciones.gov.py/estadisticas/',
  'https://migraciones.gov.py/',
];

// Keywords that indicate residency-related content
const RESIDENCY_KEYWORDS = [
  'residencia', 'residencias', 'temporaria', 'permanente',
  'extranjeros', 'nacionalidades', 'inmigrantes', 'radicacion',
  'radicación', 'visas', 'permisos de residencia'
];

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 15000
    });
    return await res.text();
  } catch(e) {
    console.error(`[Migraciones] Failed to fetch ${url}:`, e.message);
    return null;
  }
}

function extractMetricsFromText(text, sourceUrl, pubDate) {
  const metrics = [];
  const textLower = text.toLowerCase();
  
  // Check if this content is residency-related
  const isResidency = RESIDENCY_KEYWORDS.some(kw => textLower.includes(kw));
  if (!isResidency) return [];
  
  // Extract year
  const yearMatch = text.match(/20(1[5-9]|2[0-9])/);
  const year = yearMatch ? parseInt(yearMatch[0]) : new Date().getFullYear();
  
  // Extract month
  const months = {
    'enero': 1, 'febrero': 2, 'marzo': 3, 'abril': 4,
    'mayo': 5, 'junio': 6, 'julio': 7, 'agosto': 8,
    'septiembre': 9, 'octubre': 10, 'noviembre': 11, 'diciembre': 12
  };
  let month = null;
  for (const [name, num] of Object.entries(months)) {
    if (textLower.includes(name)) { month = num; break; }
  }
  
  // Extract numbers near residency keywords
  const patterns = [
    { regex: /residencias?\s+(?:temporarias?|permanentes?)[\s:]*(\d[\d,.]+)/gi, name: 'residency_applications' },
    { regex: /(\d[\d,.]+)\s+residencias/gi, name: 'residency_applications' },
    { regex: /(\d[\d,.]+)\s+extranjeros/gi, name: 'foreign_nationals' },
    { regex: /movimientos?[\s:]*(\d[\d,.]+)/gi, name: 'border_movements' },
    { regex: /ingresos?[\s:]*(\d[\d,.]+)/gi, name: 'entries' },
    { regex: /egresos?[\s:]*(\d[\d,.]+)/gi, name: 'exits' },
  ];
  
  for (const { regex, name } of patterns) {
    const matches = text.matchAll(regex);
    for (const m of matches) {
      const value = parseFloat(m[1].replace(/[.,]/g, '').replace(',', '.'));
      if (value > 0 && value < 10000000) {
        metrics.push({
          source: SOURCE,
          dataset_name: 'residency_stats',
          period_type: month ? 'monthly' : 'yearly',
          period_year: year,
          period_month: month,
          geography_type: 'national',
          geography_name: 'Paraguay',
          metric_name: name,
          metric_value: value,
          unit: 'persons',
          confidence_level: 'low',
          source_url: sourceUrl,
          notes: `Extracted from text. Pub date: ${pubDate || 'unknown'}`
        });
      }
    }
  }
  
  return metrics;
}

async function scrapeMigraciones() {
  console.log('[Migraciones] Starting scrape...');
  let totalMetrics = 0;
  
  try {
    for (const url of URLS) {
      const html = await fetchPage(url);
      if (!html) continue;
      
      const $ = cheerio.load(html);
      
      // Extract text from main content
      const mainText = $('main, .content, article, .estadisticas, body').text();
      const metrics = extractMetricsFromText(mainText, url, null);
      
      // Look for links to statistical reports or PDFs
      const links = [];
      $('a[href]').each((i, el) => {
        const href = $(el).attr('href');
        const text = $(el).text().toLowerCase();
        const isRelevant = RESIDENCY_KEYWORDS.some(kw => text.includes(kw)) ||
                          href.includes('estadistic') || href.includes('pdf') ||
                          href.includes('residenc') || href.includes('informe');
        if (isRelevant && href) {
          let fullUrl = href.startsWith('http') ? href : 'https://migraciones.gov.py' + href;
          links.push({ url: fullUrl, text: $(el).text() });
        }
      });
      
      console.log(`[Migraciones] Found ${links.length} relevant links`);
      
      // Fetch linked pages
      for (const link of links.slice(0, 5)) {
        const linkedHtml = await fetchPage(link.url);
        if (!linkedHtml) continue;
        
        const $$ = cheerio.load(linkedHtml);
        const linkedText = $$('main, .content, article, body').text();
        const linkedMetrics = extractMetricsFromText(linkedText, link.url, null);
        
        if (linkedMetrics.length > 0) {
          const saved = await saveMetrics(linkedMetrics);
          totalMetrics += saved;
        }
        
        await new Promise(r => setTimeout(r, 1000));
      }
      
      if (metrics.length > 0) {
        const saved = await saveMetrics(metrics);
        totalMetrics += saved;
      }
      
      await new Promise(r => setTimeout(r, 1500));
    }
    
    await logScrapeRun(SOURCE, 'success', totalMetrics, 0, null);
    console.log(`[Migraciones] Complete. Metrics: ${totalMetrics}`);
    return { source: SOURCE, status: 'success', metrics: totalMetrics };
    
  } catch(e) {
    await logScrapeRun(SOURCE, 'error', 0, 0, e.message);
    console.error('[Migraciones] Error:', e.message);
    return { source: SOURCE, status: 'error', error: e.message };
  }
}

module.exports = { scrapeMigraciones };
