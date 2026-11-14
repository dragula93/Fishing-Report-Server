BEGIN;
ALTER TABLE operational_events ADD COLUMN IF NOT EXISTS notification_key text;
CREATE UNIQUE INDEX IF NOT EXISTS operational_events_notification_key ON operational_events(notification_key) WHERE notification_key IS NOT NULL;
CREATE OR REPLACE FUNCTION record_missed_schedule(c jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE loc jsonb; new_id bigint; affected integer:=0; period date;
BEGIN
 IF c->>'mode'!='production' THEN RETURN c||jsonb_build_object('notify_missed',false); END IF;
 period=(c->>'period_start')::date;
 FOR loc IN SELECT value FROM jsonb_array_elements(c#>'{config,locations}') WHERE value->>'enabled'='true' LOOP
  IF EXISTS(SELECT 1 FROM reports WHERE namespace='production' AND location_id=loc->>'id' AND period_start=period) THEN CONTINUE; END IF;
  INSERT INTO operational_events(kind,run_id,diagnostic,notification_key)
  VALUES('missed_schedule',c->>'run_id',jsonb_build_object('location_id',loc->>'id','period_start',period,'scheduled_for',c->>'scheduled_for'), 'missed_schedule:'||period||':'||(loc->>'id'))
  ON CONFLICT DO NOTHING RETURNING id INTO new_id;
  IF new_id IS NOT NULL THEN affected=affected+1; END IF;
 END LOOP;
 RETURN c||jsonb_build_object('notify_missed',affected>0);
END $$;
INSERT INTO schema_migrations(version) VALUES(4) ON CONFLICT DO NOTHING;
COMMIT;
