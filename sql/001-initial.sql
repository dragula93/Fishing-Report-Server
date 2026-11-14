BEGIN;
CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS configuration(key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS runs(
 run_id text PRIMARY KEY, scheduler_run_id text NOT NULL, namespace text NOT NULL CHECK(namespace IN ('test','production')),
 location_id text NOT NULL, period_start date NOT NULL, period_end date NOT NULL, edition integer NOT NULL CHECK(edition>0),
 scheduled_for timestamptz NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 status text NOT NULL CHECK(status IN ('running','complete','partial','failed')), lease_owner text, lease_until timestamptz,
 mode text NOT NULL, context jsonb NOT NULL, error jsonb, UNIQUE(namespace,location_id,period_start,edition)
);
CREATE TABLE IF NOT EXISTS source_documents(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, run_id text NOT NULL REFERENCES runs(run_id),
 location_id text NOT NULL, source_id text NOT NULL, original_url text, published_at timestamptz, updated_at timestamptz,
 fishing_date date, retrieved_at timestamptz NOT NULL, status text NOT NULL, snapshot jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS source_documents_run ON source_documents(run_id);
CREATE TABLE IF NOT EXISTS observations_forecasts(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, run_id text NOT NULL REFERENCES runs(run_id),location_id text NOT NULL,
 source_id text NOT NULL, issued_at timestamptz, retrieved_at timestamptz NOT NULL, normalized jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS fishing_evidence(
 evidence_id text PRIMARY KEY,run_id text NOT NULL REFERENCES runs(run_id),location_id text NOT NULL,
 document_id bigint REFERENCES source_documents(id),fishing_date date,age_label text NOT NULL,evidence jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS target_rules(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,species text NOT NULL,jurisdiction text NOT NULL,
 effective_start date NOT NULL,effective_end date NOT NULL,targeting_status text NOT NULL,retention_status text NOT NULL,
 official_url text NOT NULL,verified_at timestamptz NOT NULL,details jsonb NOT NULL DEFAULT '{}',
 CHECK(effective_end>=effective_start)
);
CREATE TABLE IF NOT EXISTS reports(
 report_id text PRIMARY KEY,run_id text NOT NULL REFERENCES runs(run_id),namespace text NOT NULL,
 location_id text NOT NULL,period_start date NOT NULL,edition integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 report jsonb NOT NULL,evidence_packet jsonb NOT NULL,html text NOT NULL,plain_text text NOT NULL,markdown text NOT NULL,
 subject text NOT NULL,UNIQUE(namespace,location_id,period_start,edition)
);
CREATE TABLE IF NOT EXISTS subscribers(
 subscriber_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,email text NOT NULL UNIQUE,
 enabled boolean NOT NULL DEFAULT false,locations text[] NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS deliveries(
 delivery_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,report_id text NOT NULL REFERENCES reports(report_id),
 namespace text NOT NULL CHECK(namespace IN ('test','production')),location_id text NOT NULL,period_start date NOT NULL,edition integer NOT NULL,
 recipient text NOT NULL,status text NOT NULL CHECK(status IN ('claimed','sending','accepted','failed','unknown')),
 owner text NOT NULL,claimed_at timestamptz NOT NULL DEFAULT now(),sending_at timestamptz,finished_at timestamptz,
 message_id text,provider_response jsonb,UNIQUE(namespace,location_id,period_start,edition,recipient)
);
CREATE TABLE IF NOT EXISTS scheduler_runs(
 run_id text PRIMARY KEY,scheduled_for timestamptz NOT NULL,mode text NOT NULL,status text NOT NULL,
 summary jsonb NOT NULL,finished_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS operational_events(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now(),kind text NOT NULL,
 run_id text,diagnostic jsonb NOT NULL,notification_status text NOT NULL DEFAULT 'pending'
);

CREATE OR REPLACE FUNCTION claim_run(c jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE claimed runs; key_id text := (c->>'run_id') || '_' || (c->>'location_id');
BEGIN
 INSERT INTO runs(run_id,scheduler_run_id,namespace,location_id,period_start,period_end,edition,scheduled_for,status,
  lease_owner,lease_until,mode,context)
 VALUES(key_id,c->>'run_id',c->>'namespace',c->>'location_id',(c#>>'{window,period_start}')::date,
  (c#>>'{window,period_end}')::date,(c->>'edition')::integer,(c->>'scheduled_for')::timestamptz,'running',
  c->>'run_id',now()+interval '30 minutes',c->>'mode',c)
 ON CONFLICT(namespace,location_id,period_start,edition) DO UPDATE SET
  status='running',lease_owner=excluded.lease_owner,lease_until=excluded.lease_until,context=excluded.context
 WHERE runs.status='running' AND runs.lease_until<now()
 RETURNING * INTO claimed;
 IF claimed.run_id IS NULL THEN RETURN c || jsonb_build_object('claimed',false,'outcome','duplicate_skipped'); END IF;
 RETURN c || jsonb_build_object('claimed',true,'db_run_id',claimed.run_id);
END $$;

CREATE OR REPLACE FUNCTION archive_report(c jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE collector jsonb; report_key text := (c->>'db_run_id') || '_edition_' || (c->>'edition');
BEGIN
 IF NOT EXISTS(SELECT 1 FROM runs WHERE run_id=c->>'db_run_id' AND lease_owner=c->>'run_id' AND status='running' AND lease_until>now()) THEN
  RAISE EXCEPTION 'Run lease lost before archive';
 END IF;
 FOR collector IN SELECT value FROM jsonb_array_elements(c->'collectors') LOOP
  INSERT INTO source_documents(run_id,location_id,source_id,original_url,retrieved_at,status,snapshot)
   VALUES(c->>'db_run_id',c->>'location_id',collector->>'source_id',collector->>'url',
   (collector->>'retrieved_at')::timestamptz,collector->>'status',collector);
  INSERT INTO observations_forecasts(run_id,location_id,source_id,issued_at,retrieved_at,normalized)
   VALUES(c->>'db_run_id',c->>'location_id',collector->>'source_id',
    NULLIF(collector->>'issued_at','')::timestamptz,(collector->>'retrieved_at')::timestamptz,collector-'raw');
 END LOOP;
 INSERT INTO reports(report_id,run_id,namespace,location_id,period_start,edition,report,evidence_packet,html,plain_text,markdown,subject)
 VALUES(report_key,c->>'db_run_id',c->>'namespace',c->>'location_id',(c#>>'{window,period_start}')::date,(c->>'edition')::integer,
 c->'report',c-'config'-'rendered',c#>>'{rendered,html}',c#>>'{rendered,text}',c#>>'{rendered,markdown}',c#>>'{rendered,subject}');
 RETURN c || jsonb_build_object('report_id',report_key);
END $$;

CREATE OR REPLACE FUNCTION claim_delivery(c jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE d deliveries; r reports;
BEGIN
 SELECT * INTO STRICT r FROM reports WHERE report_id=c->>'report_id';
 IF (c->>'namespace') != r.namespace THEN RAISE EXCEPTION 'Delivery namespace mismatch'; END IF;
 INSERT INTO deliveries(report_id,namespace,location_id,period_start,edition,recipient,status,owner,message_id)
 VALUES(r.report_id,r.namespace,r.location_id,r.period_start,r.edition,c->>'recipient','claimed',c->>'run_id',c->>'message_id')
 ON CONFLICT(namespace,location_id,period_start,edition,recipient) DO UPDATE SET
  status='claimed',owner=excluded.owner,claimed_at=now(),finished_at=NULL
 WHERE deliveries.status='failed' AND c->>'mode'='retry_failed_deliveries'
 RETURNING * INTO d;
 IF d.delivery_id IS NULL THEN RETURN c || jsonb_build_object('delivery_claimed',false); END IF;
 RETURN c || jsonb_build_object('delivery_claimed',true,'delivery_id',d.delivery_id);
END $$;

INSERT INTO schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
COMMIT;
