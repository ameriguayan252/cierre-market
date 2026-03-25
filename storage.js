const supabase = require('./supabase');

// Save a scrape run log
async function logScrapeRun(source, status, rowsExtracted, filesDownloaded, errorMessage) {
  const { data, error } = await supabase.from('market_scrape_runs').insert({
    id: `run_${Date.now()}_${source}`,
    source,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    status,
    rows_extracted: rowsExtracted || 0,
    files_downloaded: filesDownloaded || 0,
    error_message: errorMessage || null
  });
  if (error) console.error('[Storage] Failed to log run:', error.message);
  return data;
}

// Save a market metric
async function saveMetric(metric) {
  const row = {
    id: `metric_${Date.now()}_${Math.random().toString(36).substr(2,6)}`,
    source: metric.source,
    dataset_name: metric.dataset_name,
    period_type: metric.period_type, // monthly, quarterly, yearly
    period_year: metric.period_year,
    period_month: metric.period_month || null,
    period_quarter: metric.period_quarter || null,
    period_date: metric.period_date || null,
    geography_type: metric.geography_type || 'national', // national, department, district
    geography_name: metric.geography_name || 'Paraguay',
    metric_name: metric.metric_name,
    metric_value: metric.metric_value,
    unit: metric.unit || null,
    confidence_level: metric.confidence_level || 'medium', // high, medium, low
    source_url: metric.source_url || null,
    scrape_run_id: metric.scrape_run_id || null,
    notes: metric.notes || null
  };

  // Upsert — avoid duplicates on same source/metric/period
  const { error } = await supabase
    .from('market_metrics')
    .upsert(row, {
      onConflict: 'source,metric_name,period_type,period_year,period_month,geography_name'
    });

  if (error) console.error('[Storage] Failed to save metric:', error.message);
  return !error;
}

// Save batch of metrics
async function saveMetrics(metrics) {
  let saved = 0;
  for (const m of metrics) {
    const ok = await saveMetric(m);
    if (ok) saved++;
  }
  return saved;
}

// Get metrics for dashboard
async function getMetrics(source, metricName, limit) {
  let query = supabase
    .from('market_metrics')
    .select('*')
    .order('period_year', { ascending: false })
    .order('period_month', { ascending: false });

  if (source) query = query.eq('source', source);
  if (metricName) query = query.eq('metric_name', metricName);
  if (limit) query = query.limit(limit);

  const { data, error } = await query;
  if (error) return [];
  return data || [];
}

// Get latest scrape runs
async function getLatestRuns() {
  const { data } = await supabase
    .from('market_scrape_runs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(20);
  return data || [];
}

module.exports = { logScrapeRun, saveMetric, saveMetrics, getMetrics, getLatestRuns };
