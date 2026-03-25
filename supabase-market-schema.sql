-- Run this in Supabase SQL Editor
-- Market Watcher Tables for CIERRE

-- Scrape run logs
create table if not exists market_scrape_runs (
  id text primary key,
  source text not null,
  started_at timestamp default now(),
  finished_at timestamp,
  status text default 'running',
  rows_extracted integer default 0,
  files_downloaded integer default 0,
  error_message text
);

-- Market metrics (all data goes here)
create table if not exists market_metrics (
  id text primary key,
  source text not null,
  dataset_name text,
  period_type text not null, -- monthly, quarterly, yearly
  period_year integer not null,
  period_month integer,       -- 1-12, null if not monthly
  period_quarter integer,     -- 1-4, null if not quarterly
  period_date date,           -- standardized date
  geography_type text default 'national', -- national, department, district, city, neighborhood
  geography_name text default 'Paraguay',
  metric_name text not null,
  metric_value numeric,
  unit text,
  confidence_level text default 'medium', -- high, medium, low
  source_url text,
  scrape_run_id text,
  notes text,
  created_at timestamp default now(),
  unique(source, metric_name, period_type, period_year, period_month, geography_name)
);

-- Enable RLS
alter table market_scrape_runs enable row level security;
alter table market_metrics enable row level security;

-- Public access
create policy "public" on market_scrape_runs for all using (true) with check (true);
create policy "public" on market_metrics for all using (true) with check (true);

-- Indexes for fast queries
create index if not exists idx_market_metrics_source on market_metrics(source);
create index if not exists idx_market_metrics_metric on market_metrics(metric_name);
create index if not exists idx_market_metrics_year on market_metrics(period_year);
create index if not exists idx_market_metrics_geo on market_metrics(geography_name);
