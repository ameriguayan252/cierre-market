const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { saveMetrics, logScrapeRun } = require('./storage');

const SOURCE = 'asuncion_municipal';

const URLS = [
  'https://www.asuncion.gov.py/formularios-y-requisitos/construcciones',
  'https://www.asuncion.gov.py',
];

const CONSTRUCTION_KEYWORDS = [
  'permisos', 'aprobación', 'aprobacion', 'planos', 'obras',
  'metros cuadrados', 'edificios', 'barrio', 'construccion',
  'construcción', 'obras particulares', 'niveles', 'pisos',
  'viviendas', 'departamentos', 'proyecto'
];

const BARRIOS_ASUNCION = [
  'Villa Morra', 'Recoleta', 'Carmelitas', 'Las Mercedes',
  'Barrio Jara', 'Mariscal López', 'San Vicente', 'Sajonia',
  'Trinidad', 'Santísima Trinidad', 'Herrera', 'Zeballos Cué',
  'Villa Aurelia', 'Loma Pyta', 'Ycuá Bolaños'
];

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 15000
    });
    return await res.text();
  } catch(e) {
    console.error(`[Asuncion] Failed to fetch ${url}:`, e.message);
    return null;
  }
}

function extractConstructionMetrics(text, sourceUrl, articleDate) {
  const metrics = [];
  const textLower = text.toLowerCase();
  
  const isConstruction = CONSTRUCTION_KEYWORDS.some(kw => textLower.includes(kw));
  if (!isConstruction) return [];
  
  const yearMatch = text.match(/20(1[5-9]|2[0-9])/);
  const year = yearMatch ? parseInt(yearMatch[0]) : new Date().getFullYear();
  
  const months = {
    'enero': 1, 'febrero': 2, 'marzo': 3, 'abril': 4,
    'mayo': 5, 'junio': 6, 'julio': 7, 'agosto': 8,
    'septiembre': 9, 'octubre': 10, 'noviembre': 11, 'diciembre': 12
  };
  let month = null;
  for (const [name, num] of Object.entries(months)) {
    if (textLower.includes(name)) { month = num; break; }
  }
  
  // Extract permit counts
  const permitPatterns = [
    { regex: /(\d[\d,.]+)\s+permisos/gi, name: 'construction_permits' },
    { regex: /permisos?[\s:]*(\d[\d,.]+)/gi, name: 'construction_permits' },
    { regex: /(\d[\d,.]+)\s+(?:planos|proyectos)/gi, name: 'approved_plans' },
    { regex: /(\d[\d,.]+)\s+metros?\s+cuadrados?/gi, name: 'approved_sqm' },
    { regex: /(\d[\d,.]+)\s+m²/gi, name: 'approved_sqm' },
    { regex: /(\d[\d,.]+)\s+(?:obras|construcciones)/gi, name: 'construction_projects' },
    { regex: /(\d[\d,.]+)\s+(?:viviendas|departamentos|unidades)/gi, name: 'housing_units' },
  ];
  
  for (const { regex, name } of permitPatterns) {
    const matches = text.matchAll(regex);
    for (const m of matches) {
      const value = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
      if (value > 0 && value < 100000000) {
        metrics.push({
          source: SOURCE,
          dataset_name: 'construction_activity',
          period_type: month ? 'monthly' : 'yearly',
          period_year: year,
          period_month: month,
          geography_type: 'city',
          geography_name: 'Asunción',
          metric_name: name,
          metric_value: value,
          unit: name.includes('sqm') ? 'm2' : 'count',
          confidence_level: 'low',
          source_url: sourceUrl,
          notes: `Semi-structured extraction. Article date: ${articleDate || 'unknown'}`
        });
      }
    }
  }
  
  // Check for barrio mentions
  for (const barrio of BARRIOS_ASUNCION) {
    if (text.includes(barrio)) {
      metrics.push({
        source: SOURCE,
        dataset_name: 'barrio_activity',
        period_type: month ? 'monthly' : 'yearly',
        period_year: year,
        period_month: month,
        geography_type: 'neighborhood',
        geography_name: barrio,
        metric_name: 'construction_mention',
        metric_value: 1,
        unit: 'mention',
        confidence_level: 'low',
        source_url: sourceUrl,
        notes: `Barrio mentioned in construction context`
      });
    }
  }
  
  return metrics;
}

async function scrapeAsuncion() {
  console.log('[Asuncion] Starting scrape...');
  let totalMetrics = 0;
  
  try {
    for (const url of URLS) {
      const html = await fetchPage(url);
      if (!html) continue;
      
      const $ = cheerio.load(html);
      
      // Get main content
      const mainText = $('main, .content, article, body').text();
      const metrics = extractConstructionMetrics(mainText, url, null);
      
      if (metrics.length > 0) {
        const saved = await saveMetrics(metrics);
        totalMetrics += saved;
      }
      
      // Find news/article links about construction
      const links = [];
      $('a[href]').each((i, el) => {
        const href = $(el).attr('href') || '';
        const text = $(el).text().toLowerCase();
        const isRelevant = CONSTRUCTION_KEYWORDS.some(kw => text.includes(kw)) ||
                          href.includes('obras') || href.includes('construccion') ||
                          href.includes('permis') || href.includes('noticias');
        if (isRelevant) {
          let fullUrl = href.startsWith('http') ? href : 'https://www.asuncion.gov.py' + href;
          links.push(fullUrl);
        }
      });
      
      // Scrape linked pages
      for (const link of [...new Set(links)].slice(0, 8)) {
        const linkedHtml = await fetchPage(link);
        if (!linkedHtml) continue;
        
        const $$ = cheerio.load(linkedHtml);
        const linkedText = $$('main, .content, article, body').text();
        const linkedMetrics = extractConstructionMetrics(linkedText, link, null);
        
        if (linkedMetrics.length > 0) {
          const saved = await saveMetrics(linkedMetrics);
          totalMetrics += saved;
        }
        
        await new Promise(r => setTimeout(r, 800));
      }
      
      await new Promise(r => setTimeout(r, 1500));
    }
    
    await logScrapeRun(SOURCE, 'success', totalMetrics, 0, null);
    console.log(`[Asuncion] Complete. Metrics: ${totalMetrics}`);
    return { source: SOURCE, status: 'success', metrics: totalMetrics };
    
  } catch(e) {
    await logScrapeRun(SOURCE, 'error', 0, 0, e.message);
    console.error('[Asuncion] Error:', e.message);
    return { source: SOURCE, status: 'error', error: e.message };
  }
}

module.exports = { scrapeAsuncion };
