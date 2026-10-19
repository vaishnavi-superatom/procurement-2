-- Market benchmark storage for the procurement source (Neon).
-- Verified external commodity prices, kept apart from the synthetic commodity_prices seed.
-- Idempotent; the refresh-market-benchmarks tool runs the same statements when the source allows DDL.
-- Generated from BENCHMARK_DDL in backend/src/tools/direct/procurement/market-benchmarks.ts.

CREATE TABLE IF NOT EXISTS public.market_benchmark_observations (
	id bigserial PRIMARY KEY,
	provider text NOT NULL,
	benchmark_id text NOT NULL,
	commodity text NOT NULL,
	benchmark_name text NOT NULL,
	specification text,
	source_url text NOT NULL,
	dataset_version text,
	observation_date date NOT NULL,
	frequency text NOT NULL,
	period_label text,
	price numeric NOT NULL,
	currency text NOT NULL,
	unit text NOT NULL,
	location text,
	delivery_basis text,
	data_status text NOT NULL,
	fx_inr_per_unit numeric,
	fx_basis text,
	price_inr_per_mt numeric,
	retrieved_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT uq_market_benchmark_observation UNIQUE (provider, benchmark_id, observation_date)
);

CREATE INDEX IF NOT EXISTS idx_market_benchmark_obs_bench ON public.market_benchmark_observations (benchmark_id, observation_date);

CREATE TABLE IF NOT EXISTS public.market_benchmark_refreshes (
	id bigserial PRIMARY KEY,
	provider text NOT NULL,
	status text NOT NULL,
	message text,
	dataset_url text,
	dataset_version text,
	rows_upserted integer,
	started_at timestamptz NOT NULL DEFAULT now(),
	finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_market_benchmark_refreshes_provider ON public.market_benchmark_refreshes (provider, started_at);
