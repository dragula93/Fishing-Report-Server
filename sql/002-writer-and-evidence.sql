BEGIN;
CREATE TABLE IF NOT EXISTS writer_calls(
 run_id text NOT NULL REFERENCES runs(run_id), attempt integer NOT NULL CHECK(attempt IN (1,2)),
 reserved_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,status text NOT NULL DEFAULT 'reserved',
 usage jsonb,diagnostic jsonb,PRIMARY KEY(run_id,attempt)
);
CREATE OR REPLACE FUNCTION reserve_writer(c jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE reserved integer; a integer := (c->>'writer_attempt')::integer;
BEGIN
 IF a NOT IN (1,2) OR a>COALESCE((c#>>'{config,llm,max_calls_per_run}')::integer,0) THEN RETURN c||jsonb_build_object('writer_reserved',false); END IF;
 INSERT INTO writer_calls(run_id,attempt) SELECT c->>'db_run_id',a
 WHERE EXISTS(SELECT 1 FROM runs WHERE run_id=c->>'db_run_id' AND status='running' AND lease_owner=c->>'run_id' AND lease_until>now())
 ON CONFLICT DO NOTHING RETURNING attempt INTO reserved;
 RETURN c||jsonb_build_object('writer_reserved',reserved IS NOT NULL);
END $$;
CREATE OR REPLACE FUNCTION archive_fishing_evidence(c jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE e jsonb; s jsonb; d jsonb; document_key bigint;
BEGIN
 FOR s IN SELECT value FROM jsonb_array_elements(c->'collectors') LOOP
  FOR d IN SELECT value FROM jsonb_array_elements(COALESCE(s->'documents','[]'::jsonb)) LOOP
   IF d='null'::jsonb THEN CONTINUE; END IF;
   INSERT INTO source_documents(run_id,location_id,source_id,original_url,published_at,updated_at,retrieved_at,status,snapshot)
   VALUES(c->>'db_run_id',c->>'location_id',s->>'source_id',d->>'url',NULLIF(d->>'published_at','')::timestamptz,NULLIF(d->>'updated_at','')::timestamptz,(d->>'retrieved_at')::timestamptz,s->>'status',d);
  END LOOP;
 END LOOP;
 FOR e IN SELECT value FROM jsonb_array_elements(c->'evidence') LOOP
  SELECT id INTO document_key FROM source_documents WHERE run_id=c->>'db_run_id' AND original_url=e->>'url' ORDER BY id DESC LIMIT 1;
  INSERT INTO fishing_evidence(evidence_id,run_id,location_id,document_id,fishing_date,age_label,evidence)
  VALUES(e->>'evidence_id',c->>'db_run_id',c->>'location_id',document_key,NULLIF(e->>'fishing_date','')::date,e->>'age_label',e) ON CONFLICT DO NOTHING;
 END LOOP;
END $$;
INSERT INTO schema_migrations(version) VALUES(2) ON CONFLICT DO NOTHING;
COMMIT;
