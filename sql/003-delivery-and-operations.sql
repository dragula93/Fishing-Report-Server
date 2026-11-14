BEGIN;
CREATE OR REPLACE FUNCTION begin_delivery(c jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE updated_id bigint;
BEGIN
 UPDATE deliveries SET status='sending',sending_at=now()
 WHERE delivery_id=(c->>'delivery_id')::bigint AND owner=c->>'run_id' AND status='claimed'
 RETURNING delivery_id INTO updated_id;
 RETURN c||jsonb_build_object('send_authorized',updated_id IS NOT NULL);
END $$;
CREATE OR REPLACE FUNCTION finish_delivery(c jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
 IF c->>'status' NOT IN ('accepted','failed','unknown') THEN RAISE EXCEPTION 'Invalid SMTP outcome'; END IF;
 UPDATE deliveries SET status=c->>'status',finished_at=now(),message_id=c->>'message_id',provider_response=c->'diagnostic'
 WHERE delivery_id=(c->>'delivery_id')::bigint AND owner=c->>'run_id' AND status='sending';
 RETURN jsonb_build_object('schema_version',c->>'schema_version','run_id',c->>'run_id','location_id',c->>'location_id','report_id',c->>'report_id','mode',c->>'mode','outcome',c->>'status','delivery_id',c->>'delivery_id');
END $$;
CREATE OR REPLACE FUNCTION reconcile_abandoned_deliveries() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE count_rows integer;
BEGIN
 UPDATE deliveries SET status='unknown',finished_at=now(),provider_response=jsonb_build_object('reason','Sending attempt abandoned; reconcile with provider before retry') WHERE status='sending' AND sending_at<now()-interval '15 minutes';
 GET DIAGNOSTICS count_rows=ROW_COUNT;RETURN count_rows;
END $$;
INSERT INTO schema_migrations(version) VALUES(3) ON CONFLICT DO NOTHING;
COMMIT;
