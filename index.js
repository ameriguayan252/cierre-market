require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Allow browser preflight
app.options('*', cors());

let scrapeINE, scrapeBCP, scrapeMigraciones, scrapeAsuncion, scrapeVaultMetrics;
try { ({ scrapeINE } = require('./scrapers/ine_scraper')); } catch(e) { try { ({ scrapeINE } = require('./ine_scraper')); } catch(e2) { scrapeINE = async () => ({ source:'ine', status:'skipped', error:'not found' }); } }
try { ({ scrapeBCP } = require('./scrapers/bcp_scraper')); } catch(e) { try { ({ scrapeBCP } = require('./bcp_scraper')); } catch(e2) { scrapeBCP = async () => ({ source:'bcp', status:'skipped', error:'not found' }); } }
try { ({ scrapeMigraciones } = require('./scrapers/migraciones_scraper')); } catch(e) { try { ({ scrapeMigraciones } = require('./migraciones_scraper')); } catch(e2) { scrapeMigraciones = async () => ({ source:'migraciones', status:'skipped', error:'not found' }); } }
try { ({ scrapeAsuncion } = require('./scrapers/asuncion_scraper')); } catch(e) { try { ({ scrapeAsuncion } = require('./asuncion_scraper')); } catch(e2) { scrapeAsuncion = async () => ({ source:'asuncion', status:'skipped', error:'not found' }); } }
try { ({ scrapeVaultMetrics } = require('./scrapers/vault_metrics')); } catch(e) { try { ({ scrapeVaultMetrics } = require('./vault_metrics')); } catch(e2) { scrapeVaultMetrics = async () => ({ source:'vault', status:'skipped', error:'not found' }); } }
const { getMetrics, getLatestRuns } = require('./storage');

// Run all scrapers
async function runAllScrapers() {
  console.log('[Market Watcher] Starting weekly scrape...');
  const results = [];
  
  // Phase 1: High confidence sources first
  results.push(await scrapeINE());
  await new Promise(r => setTimeout(r, 2000));
  
  results.push(await scrapeBCP());
  await new Promise(r => setTimeout(r, 2000));
  
  // Phase 2: Semi-structured sources
  results.push(await scrapeMigraciones());
  await new Promise(r => setTimeout(r, 2000));
  
  results.push(await scrapeAsuncion());
  await new Promise(r => setTimeout(r, 2000));
  
  // Always run vault metrics (internal data)
  results.push(await scrapeVaultMetrics());
  
  console.log('[Market Watcher] Weekly scrape complete:', results);
  return results;
}

// API Routes
app.get('/health', (req, res) => res.json({ 
  status: 'ok', 
  service: 'CIERRE Market Watcher',
  time: new Date().toISOString() 
}));

// Manual trigger
app.post('/scrape', async (req, res) => {
  try {
    const results = await runAllScrapers();
    res.json({ ok: true, results });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Trigger specific source
app.post('/scrape/:source', async (req, res) => {
  try {
    let result;
    switch(req.params.source) {
      case 'ine': result = await scrapeINE(); break;
      case 'bcp': result = await scrapeBCP(); break;
      case 'migraciones': result = await scrapeMigraciones(); break;
      case 'asuncion': result = await scrapeAsuncion(); break;
      case 'vault': result = await scrapeVaultMetrics(); break;
      default: return res.status(400).json({ error: 'Unknown source' });
    }
    res.json({ ok: true, result });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Get metrics for dashboard
app.get('/metrics', async (req, res) => {
  try {
    const { source, metric, limit } = req.query;
    const data = await getMetrics(source, metric, parseInt(limit) || 100);
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Get scrape run history
app.get('/runs', async (req, res) => {
  try {
    const runs = await getLatestRuns();
    res.json(runs);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Dashboard summary endpoint
app.get('/dashboard', async (req, res) => {
  try {
    const [population, gdp, residency, permits, vaultPricing, vaultInventory] = await Promise.all([
      getMetrics('ine', 'population', 10),
      getMetrics('bcp', 'gdp_growth', 10),
      getMetrics('migraciones', 'residency_applications', 12),
      getMetrics('asuncion_municipal', 'construction_permits', 12),
      getMetrics('cierre_vault', 'avg_price_per_sqm', 12),
      getMetrics('cierre_vault', 'total_listings', 12),
    ]);
    
    res.json({
      population: population.slice(0, 10),
      gdp: gdp.slice(0, 10),
      residency: residency.slice(0, 12),
      permits: permits.slice(0, 12),
      vaultPricing: vaultPricing.slice(0, 12),
      vaultInventory: vaultInventory.slice(0, 12),
      lastUpdated: new Date().toISOString()
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Weekly cron — runs every Sunday at 2am
cron.schedule('0 2 * * 0', async () => {
  console.log('[CRON] Weekly market data scrape starting...');
  await runAllScrapers();
});

// Also run vault metrics daily at midnight
cron.schedule('0 0 * * *', async () => {
  console.log('[CRON] Daily vault metrics update...');
  await scrapeVaultMetrics();
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`CIERRE Market Watcher running on port ${PORT}`);
  console.log('Weekly scrape: Every Sunday at 2am');
  console.log('Vault metrics: Daily at midnight');
});
