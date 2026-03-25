const supabase = require('./supabase');
const { saveMetrics, logScrapeRun } = require('./storage');

const SOURCE = 'cierre_vault';

async function scrapeVaultMetrics() {
  console.log('[Vault] Calculating internal market metrics...');
  let totalMetrics = 0;
  
  try {
    // Get all properties from vault
    const { data: properties } = await supabase
      .from('properties')
      .select('*')
      .not('price', 'is', null)
      .not('sqm', 'is', null);
    
    if (!properties || !properties.length) {
      console.log('[Vault] No properties found');
      return { source: SOURCE, status: 'success', metrics: 0 };
    }
    
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const metrics = [];
    
    // Overall stats
    const validProps = properties.filter(p => p.price > 0 && p.sqm > 0);
    if (validProps.length > 0) {
      const avgPricePerSqm = validProps.reduce((s, p) => s + (p.price / p.sqm), 0) / validProps.length;
      const avgPrice = validProps.reduce((s, p) => s + p.price, 0) / validProps.length;
      
      metrics.push({
        source: SOURCE, dataset_name: 'vault_pricing',
        period_type: 'monthly', period_year: year, period_month: month,
        geography_type: 'city', geography_name: 'Asunción',
        metric_name: 'avg_price_per_sqm', metric_value: Math.round(avgPricePerSqm),
        unit: 'usd_per_m2', confidence_level: 'high',
        source_url: 'internal', notes: `Based on ${validProps.length} properties`
      });
      
      metrics.push({
        source: SOURCE, dataset_name: 'vault_pricing',
        period_type: 'monthly', period_year: year, period_month: month,
        geography_type: 'city', geography_name: 'Asunción',
        metric_name: 'avg_price', metric_value: Math.round(avgPrice),
        unit: 'usd', confidence_level: 'high',
        source_url: 'internal', notes: `Based on ${validProps.length} properties`
      });
      
      metrics.push({
        source: SOURCE, dataset_name: 'vault_inventory',
        period_type: 'monthly', period_year: year, period_month: month,
        geography_type: 'city', geography_name: 'Asunción',
        metric_name: 'total_listings', metric_value: properties.length,
        unit: 'count', confidence_level: 'high', source_url: 'internal'
      });
      
      // By neighborhood
      const byNeighborhood = {};
      for (const p of validProps) {
        const hood = p.neighborhood || 'Unknown';
        if (!byNeighborhood[hood]) byNeighborhood[hood] = [];
        byNeighborhood[hood].push(p.price / p.sqm);
      }
      
      for (const [hood, prices] of Object.entries(byNeighborhood)) {
        if (prices.length < 2) continue; // Need at least 2 data points
        const avg = prices.reduce((s, v) => s + v, 0) / prices.length;
        metrics.push({
          source: SOURCE, dataset_name: 'vault_pricing_by_hood',
          period_type: 'monthly', period_year: year, period_month: month,
          geography_type: 'neighborhood', geography_name: hood,
          metric_name: 'avg_price_per_sqm', metric_value: Math.round(avg),
          unit: 'usd_per_m2', confidence_level: 'high',
          source_url: 'internal', notes: `${prices.length} properties`
        });
      }
      
      // Status breakdown
      const statusCounts = {};
      for (const p of properties) {
        const s = p.status || 'unknown';
        statusCounts[s] = (statusCounts[s] || 0) + 1;
      }
      
      for (const [status, count] of Object.entries(statusCounts)) {
        metrics.push({
          source: SOURCE, dataset_name: 'vault_inventory',
          period_type: 'monthly', period_year: year, period_month: month,
          geography_type: 'city', geography_name: 'Asunción',
          metric_name: `listings_${status}`, metric_value: count,
          unit: 'count', confidence_level: 'high', source_url: 'internal'
        });
      }
      
      // Source breakdown
      const sourceCounts = {};
      for (const p of properties) {
        const s = p.source || 'unknown';
        sourceCounts[s] = (sourceCounts[s] || 0) + 1;
      }
      
      for (const [src, count] of Object.entries(sourceCounts)) {
        metrics.push({
          source: SOURCE, dataset_name: 'vault_sources',
          period_type: 'monthly', period_year: year, period_month: month,
          geography_type: 'city', geography_name: 'Asunción',
          metric_name: `source_${src}`, metric_value: count,
          unit: 'count', confidence_level: 'high', source_url: 'internal'
        });
      }
    }
    
    totalMetrics = await saveMetrics(metrics);
    await logScrapeRun(SOURCE, 'success', totalMetrics, 0, null);
    console.log(`[Vault] Complete. Metrics: ${totalMetrics}`);
    return { source: SOURCE, status: 'success', metrics: totalMetrics };
    
  } catch(e) {
    await logScrapeRun(SOURCE, 'error', 0, 0, e.message);
    console.error('[Vault] Error:', e.message);
    return { source: SOURCE, status: 'error', error: e.message };
  }
}

module.exports = { scrapeVaultMetrics };
