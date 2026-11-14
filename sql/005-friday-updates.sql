BEGIN;
CREATE TABLE IF NOT EXISTS update_evaluations(
 evaluation_id text PRIMARY KEY,
 namespace text NOT NULL CHECK(namespace IN ('production','test')),
 location_id text NOT NULL, period_start date NOT NULL, update_kind text NOT NULL CHECK(update_kind='friday_decisions'),
 trigger_scheduled_for timestamptz NOT NULL, report_anchor_scheduled_for timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN ('evaluating','ready','no_change','baseline_missing','comparison_error','deferred','issued','delivery_failed','unissued')),
 lease_owner text, lease_until timestamptz, baseline_report_id text REFERENCES reports(report_id),
 candidate_report_id text REFERENCES reports(report_id), candidate_run_id text REFERENCES runs(run_id), edition integer,
 baseline_policy text NOT NULL DEFAULT 'highest-edition-archived-nonfixture-accepted-same-period-v1',
 policy_version text NOT NULL DEFAULT 'sat-mon-binary-v1', comparison jsonb, diagnostic jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 UNIQUE(namespace,location_id,period_start,update_kind,trigger_scheduled_for)
);
-- All edition allocations (weekly/manual as well as Friday) use the same lock.
CREATE OR REPLACE FUNCTION lock_report_period(c jsonb) RETURNS void LANGUAGE sql AS $$
 SELECT pg_advisory_xact_lock(hashtextextended((c->>'namespace')||':'||(c->>'location_id')||':'||(c#>>'{window,period_start}'),0));
$$;
CREATE OR REPLACE FUNCTION issued_baseline(ns text,loc text,period date) RETURNS reports LANGUAGE sql STABLE AS $$
 SELECT r FROM reports r WHERE r.namespace=ns AND r.location_id=loc AND r.period_start=period
 AND (ns='test' OR r.report->>'fixture'='false')
 AND EXISTS(SELECT 1 FROM deliveries d WHERE d.report_id=r.report_id AND d.status='accepted')
 ORDER BY r.edition DESC,r.report_id DESC LIMIT 1;
$$;
CREATE OR REPLACE FUNCTION unresolved_period(ns text,loc text,period date) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM deliveries WHERE namespace=ns AND location_id=loc AND period_start=period AND status IN ('sending','unknown'));
$$;
CREATE OR REPLACE FUNCTION update_diagnostic(e update_evaluations,why text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE added bigint;
BEGIN
 INSERT INTO operational_events(kind,run_id,diagnostic,notification_key)
 VALUES('friday_update_'||why,e.lease_owner,jsonb_build_object('evaluation_id',e.evaluation_id,'location_id',e.location_id,'period_start',e.period_start,'reason',why),
 'friday_update:'||e.evaluation_id||':'||why) ON CONFLICT DO NOTHING RETURNING id INTO added;
 RETURN added IS NOT NULL;
END $$;
DO $$ BEGIN
 IF to_regprocedure('claim_run_v4(jsonb)') IS NULL THEN ALTER FUNCTION claim_run(jsonb) RENAME TO claim_run_v4; END IF;
 IF to_regprocedure('archive_report_v4(jsonb)') IS NULL THEN ALTER FUNCTION archive_report(jsonb) RENAME TO archive_report_v4; END IF;
 IF to_regprocedure('claim_delivery_v4(jsonb)') IS NULL THEN ALTER FUNCTION claim_delivery(jsonb) RENAME TO claim_delivery_v4; END IF;
END $$;
CREATE OR REPLACE FUNCTION claim_run(c jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE e update_evaluations; b reports; r runs; result jsonb; eid text; next_edition integer; notify boolean;
BEGIN
 PERFORM lock_report_period(c);
 IF c->>'namespace'='production' AND COALESCE((c->>'use_fixtures')::boolean,false) THEN RAISE EXCEPTION 'Production fixture forbidden'; END IF;
 IF c->>'update_kind' IS DISTINCT FROM 'friday_decisions' THEN RETURN claim_run_v4(c); END IF;
 -- Timestamp identity must be Friday for the anchored Thursday; current due-time
 -- enforcement lives at the scheduler boundary (manual isolated tests use clocks).
 IF (c->>'trigger_scheduled_for')::timestamptz AT TIME ZONE (c#>>'{window,timezone}') < (c#>>'{window,period_start}')::date+interval '1 day'
 OR ((c->>'trigger_scheduled_for')::timestamptz AT TIME ZONE (c#>>'{window,timezone}'))::date <> (c#>>'{window,period_start}')::date+1
 THEN RAISE EXCEPTION 'Friday occurrence does not match anchored period'; END IF;
 eid='update_'||md5((c->>'namespace')||':'||(c->>'location_id')||':'||(c#>>'{window,period_start}')||':'||((c->>'trigger_scheduled_for')::timestamptz)::text);
 INSERT INTO update_evaluations(evaluation_id,namespace,location_id,period_start,update_kind,trigger_scheduled_for,report_anchor_scheduled_for,status)
 VALUES(eid,c->>'namespace',c->>'location_id',(c#>>'{window,period_start}')::date,'friday_decisions',(c->>'trigger_scheduled_for')::timestamptz,(c->>'scheduled_for')::timestamptz,'evaluating') ON CONFLICT DO NOTHING;
 SELECT * INTO STRICT e FROM update_evaluations WHERE namespace=c->>'namespace' AND location_id=c->>'location_id' AND period_start=(c#>>'{window,period_start}')::date AND trigger_scheduled_for=(c->>'trigger_scheduled_for')::timestamptz FOR UPDATE;
 IF e.status IN ('no_change','baseline_missing','comparison_error','issued','delivery_failed','unissued') THEN
  RETURN c||jsonb_build_object('claimed',false,'evaluation_id',e.evaluation_id,'outcome',e.status);
 END IF;
 IF e.lease_until>now() THEN RETURN c||jsonb_build_object('claimed',false,'outcome','evaluation_busy'); END IF;
 IF unresolved_period(e.namespace,e.location_id,e.period_start) THEN
  UPDATE update_evaluations SET status='deferred',lease_owner=c->>'run_id',lease_until=now()+interval '15 minutes',updated_at=now(),diagnostic='{"reason":"SMTP reconciliation required"}' WHERE evaluation_id=e.evaluation_id RETURNING * INTO e;
  notify=update_diagnostic(e,'reconciliation_required');
  RETURN c||jsonb_build_object('claimed',false,'outcome','deferred','evaluation_id',e.evaluation_id,'notify_update',notify);
 END IF;
 -- An archived candidate is immutable; recovery bypasses every collector/writer.
 IF e.candidate_report_id IS NOT NULL THEN
  SELECT * INTO STRICT b FROM reports WHERE report_id=e.candidate_report_id;
  UPDATE update_evaluations SET status='ready',lease_owner=c->>'run_id',lease_until=now()+interval '30 minutes',updated_at=now() WHERE evaluation_id=e.evaluation_id;
  UPDATE runs SET status='running',lease_owner=c->>'run_id',lease_until=now()+interval '30 minutes' WHERE run_id=e.candidate_run_id;
  RETURN b.evidence_packet||jsonb_build_object('config',c->'config','run_id',c->>'run_id','claimed',true,'resume_archive',true,'report_id',b.report_id,'rendered',jsonb_build_object('html',b.html,'text',b.plain_text,'subject',b.subject));
 END IF;
 SELECT * INTO b FROM issued_baseline(e.namespace,e.location_id,e.period_start);
 IF b.report_id IS NULL THEN
  UPDATE update_evaluations SET status='baseline_missing',lease_owner=c->>'run_id',lease_until=NULL,finished_at=now(),updated_at=now() WHERE evaluation_id=e.evaluation_id RETURNING * INTO e;
  notify=update_diagnostic(e,'baseline_missing');
  RETURN c||jsonb_build_object('claimed',false,'outcome','baseline_missing','evaluation_id',e.evaluation_id,'notify_update',notify);
 END IF;
 IF e.edition IS NOT NULL AND e.edition<=b.edition THEN
  -- A concurrently issued higher correction supersedes this reserved edition.
  -- Never silently renumber it, or send a lower edition against a newer one.
  UPDATE update_evaluations SET status='deferred',lease_owner=c->>'run_id',lease_until=now()+interval '15 minutes',updated_at=now(),diagnostic='{"reason":"Reserved edition superseded by an issued correction"}' WHERE evaluation_id=e.evaluation_id RETURNING * INTO e;
  notify=update_diagnostic(e,'reserved_edition_superseded');
  RETURN c||jsonb_build_object('claimed',false,'outcome','deferred','evaluation_id',e.evaluation_id,'notify_update',notify);
 END IF;
 IF e.candidate_run_id IS NULL THEN
  SELECT COALESCE(max(edition),0)+1 INTO next_edition FROM (SELECT edition FROM runs WHERE namespace=e.namespace AND location_id=e.location_id AND period_start=e.period_start UNION ALL SELECT edition FROM reports WHERE namespace=e.namespace AND location_id=e.location_id AND period_start=e.period_start) x;
  c=c||jsonb_build_object('edition',next_edition);
  result=claim_run_v4(c);
  IF result->>'claimed'<>'true' THEN RAISE EXCEPTION 'Atomic edition allocation failed'; END IF;
 ELSE
  UPDATE runs SET status='running',lease_owner=c->>'run_id',lease_until=now()+interval '30 minutes',error=NULL,finished_at=NULL WHERE run_id=e.candidate_run_id RETURNING * INTO r;
  result=c||jsonb_build_object('edition',e.edition,'db_run_id',r.run_id,'claimed',true);
 END IF;
 result=result||jsonb_build_object('evaluation_id',e.evaluation_id,'baseline_report',to_jsonb(b),'baseline_report_id',b.report_id,'baseline_policy',e.baseline_policy,'report_id',(result->>'db_run_id')||'_edition_'||(result->>'edition'));
 UPDATE update_evaluations SET status='evaluating',lease_owner=c->>'run_id',lease_until=now()+interval '30 minutes',baseline_report_id=b.report_id,candidate_run_id=result->>'db_run_id',edition=(result->>'edition')::integer,updated_at=now() WHERE evaluation_id=e.evaluation_id;
 UPDATE runs SET context=result WHERE run_id=result->>'db_run_id';
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION decision_snapshot(r jsonb,period date) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE result jsonb='[]'; d jsonb; day date; n integer; verdict text; decision_binary text;
BEGIN
 FOR i IN 2..4 LOOP
  day=period+i;
  SELECT count(*) INTO n FROM jsonb_array_elements(r->'daily_outlook') x WHERE x->>'date'=day::text;
  IF n<>1 THEN RAISE EXCEPTION 'Missing or duplicated decision for %',day; END IF;
  SELECT x INTO d FROM jsonb_array_elements(r->'daily_outlook') x WHERE x->>'date'=day::text;
  verdict=d->>'verdict';
  decision_binary=CASE WHEN verdict IN ('go','go_conditions_only') THEN 'GO' WHEN verdict IN ('dont_go','hold') THEN 'NO_GO' ELSE NULL END;
  IF decision_binary IS NULL OR jsonb_typeof(d->'reason')<>'string' OR COALESCE(trim(d->>'reason'),'')='' THEN RAISE EXCEPTION 'Malformed decision for %',day; END IF;
  result=result||jsonb_build_array(jsonb_build_object('date',day,'raw_verdict',verdict,'binary',decision_binary,'reason',d->>'reason'));
 END LOOP;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION finalize_update(c jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE e update_evaluations; b reports; before_days jsonb; after_days jsonb; changed jsonb='[]'; meta jsonb; error_text text; notify boolean=false;
BEGIN
 IF c->>'update_kind' IS DISTINCT FROM 'friday_decisions' THEN RETURN c; END IF;
 PERFORM lock_report_period(c);
 SELECT * INTO STRICT e FROM update_evaluations WHERE evaluation_id=c->>'evaluation_id' FOR UPDATE;
 IF e.status<>'evaluating' OR e.lease_owner<>c->>'run_id' OR e.lease_until<=now() THEN RAISE EXCEPTION 'Update evaluation lease lost'; END IF;
 SELECT * INTO b FROM issued_baseline(e.namespace,e.location_id,e.period_start);
 IF b.report_id IS DISTINCT FROM e.baseline_report_id OR unresolved_period(e.namespace,e.location_id,e.period_start) THEN
  UPDATE update_evaluations SET status='deferred',lease_until=now()+interval '15 minutes',updated_at=now() WHERE evaluation_id=e.evaluation_id RETURNING * INTO e;
  notify=update_diagnostic(e,'baseline_or_delivery_changed');
  RETURN c||jsonb_build_object('finalization_blocked',true,'outcome','deferred','notify_update',notify);
 END IF;
 BEGIN
  IF jsonb_typeof(b.report->'daily_outlook') IS DISTINCT FROM 'array' OR jsonb_typeof(c#>'{report,daily_outlook}') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Missing daily decisions'; END IF;
  before_days=decision_snapshot(b.report,e.period_start);after_days=decision_snapshot(c->'report',e.period_start);
  FOR i IN 0..2 LOOP IF before_days->i->>'binary'<>after_days->i->>'binary' THEN changed=changed||jsonb_build_array(after_days->i->>'date'); END IF; END LOOP;
 EXCEPTION WHEN OTHERS THEN error_text=SQLERRM; END;
 meta=jsonb_build_object('evaluation_id',e.evaluation_id,'candidate_report_id',c->>'report_id','baseline_report_id',e.baseline_report_id,'baseline_policy',e.baseline_policy,'policy_version',e.policy_version,'before',before_days,'after',after_days,'changed_dates',changed,'eligibility',CASE WHEN error_text IS NOT NULL THEN 'comparison_error' WHEN jsonb_array_length(changed)>0 THEN 'changed' ELSE 'no_change' END,'trigger_scheduled_for',e.trigger_scheduled_for,'report_anchor_scheduled_for',e.report_anchor_scheduled_for);
 UPDATE update_evaluations SET comparison=meta,diagnostic=CASE WHEN error_text IS NULL THEN NULL ELSE jsonb_build_object('reason',error_text) END,updated_at=now() WHERE evaluation_id=e.evaluation_id;
 IF error_text IS NOT NULL THEN notify=update_diagnostic(e,'comparison_error'); END IF;
 RETURN jsonb_set(c,'{report,update}',meta)||jsonb_build_object('notify_update',notify);
END $$;
CREATE OR REPLACE FUNCTION archive_report(c jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result jsonb; e update_evaluations;
BEGIN
 PERFORM lock_report_period(c);
 IF EXISTS(SELECT 1 FROM runs WHERE run_id=c->>'db_run_id' AND context->>'update_kind'='friday_decisions') AND c->>'update_kind' IS DISTINCT FROM 'friday_decisions' THEN RAISE EXCEPTION 'Friday archive metadata required'; END IF;
 IF c->>'update_kind'='friday_decisions' THEN
  SELECT * INTO STRICT e FROM update_evaluations WHERE evaluation_id=c->>'evaluation_id' FOR UPDATE;
  IF e.lease_owner<>c->>'run_id' OR e.lease_until<=now() OR e.status<>'evaluating' OR e.comparison IS NULL OR e.comparison IS DISTINCT FROM c#>'{report,update}' OR e.comparison->>'candidate_report_id'<>c->>'report_id' THEN RAISE EXCEPTION 'Unvalidated update archive'; END IF;
  IF unresolved_period(e.namespace,e.location_id,e.period_start) OR (SELECT report_id FROM issued_baseline(e.namespace,e.location_id,e.period_start)) IS DISTINCT FROM e.baseline_report_id THEN RAISE EXCEPTION 'Baseline/delivery changed before archive; defer and reconcile'; END IF;
 END IF;
 result=archive_report_v4(c);
 IF c->>'update_kind'='friday_decisions' THEN
  UPDATE update_evaluations SET candidate_report_id=result->>'report_id',status=CASE WHEN comparison->>'eligibility'='changed' THEN 'ready' ELSE comparison->>'eligibility' END,finished_at=CASE WHEN comparison->>'eligibility'='changed' THEN NULL ELSE now() END,updated_at=now() WHERE evaluation_id=e.evaluation_id;
 END IF;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION eligible_update_delivery(r reports) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE e update_evaluations; b reports; u jsonb=r.report->'update'; actual jsonb; changed jsonb='[]';
BEGIN
 IF u IS NULL THEN RETURN r.evidence_packet->>'update_kind' IS DISTINCT FROM 'friday_decisions' AND NOT EXISTS(SELECT 1 FROM runs WHERE run_id=r.run_id AND context->>'update_kind'='friday_decisions'); END IF;
 SELECT * INTO e FROM update_evaluations WHERE evaluation_id=u->>'evaluation_id';
 IF e.evaluation_id IS NULL OR e.status NOT IN ('ready','issued','delivery_failed','deferred') OR e.namespace<>r.namespace OR e.location_id<>r.location_id OR e.period_start<>r.period_start OR e.edition<>r.edition OR e.candidate_report_id<>r.report_id OR e.baseline_report_id<>u->>'baseline_report_id' OR e.comparison IS DISTINCT FROM u OR u->>'eligibility'<>'changed' OR u->>'policy_version'<>'sat-mon-binary-v1' OR u->>'baseline_policy'<>'highest-edition-archived-nonfixture-accepted-same-period-v1' THEN RETURN false; END IF;
 SELECT * INTO b FROM reports WHERE report_id=e.baseline_report_id;
 IF b.namespace<>r.namespace OR b.location_id<>r.location_id OR b.period_start<>r.period_start OR (r.namespace='production' AND b.report->>'fixture' IS DISTINCT FROM 'false') OR NOT EXISTS(SELECT 1 FROM deliveries WHERE report_id=b.report_id AND status='accepted') THEN RETURN false; END IF;
 IF decision_snapshot(b.report,r.period_start) IS DISTINCT FROM u->'before' THEN RETURN false; END IF;
 actual=decision_snapshot(r.report,r.period_start);
 IF actual IS DISTINCT FROM u->'after' THEN RETURN false; END IF;
 FOR i IN 0..2 LOOP IF u->'before'->i->>'binary'<>actual->i->>'binary' THEN changed=changed||jsonb_build_array(actual->i->>'date'); END IF; END LOOP;
 IF jsonb_array_length(changed)=0 OR changed IS DISTINCT FROM u->'changed_dates' THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE OR REPLACE FUNCTION claim_delivery(c jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r reports; d deliveries;
BEGIN
 SELECT * INTO STRICT r FROM reports WHERE report_id=c->>'report_id';
 IF c->>'namespace' IS DISTINCT FROM r.namespace OR c->>'location_id' IS DISTINCT FROM r.location_id THEN RAISE EXCEPTION 'Delivery namespace/location mismatch'; END IF;
 PERFORM lock_report_period(jsonb_build_object('namespace',r.namespace,'location_id',r.location_id,'window',jsonb_build_object('period_start',r.period_start)));
 IF NOT eligible_update_delivery(r) THEN RETURN c||jsonb_build_object('delivery_claimed',false,'outcome','update_suppressed'); END IF;
 IF EXISTS(SELECT 1 FROM update_evaluations WHERE candidate_report_id=r.report_id AND status IN ('delivery_failed','deferred')) AND c->>'mode' IS DISTINCT FROM 'retry_failed_deliveries' THEN RETURN c||jsonb_build_object('delivery_claimed',false,'outcome','update_requires_failed_retry'); END IF;
 IF r.report ? 'update' AND c->>'mode' IS DISTINCT FROM 'retry_failed_deliveries' AND EXISTS(SELECT 1 FROM issued_baseline(r.namespace,r.location_id,r.period_start) b WHERE b.report_id NOT IN (r.report#>>'{update,baseline_report_id}',r.report_id)) THEN RETURN c||jsonb_build_object('delivery_claimed',false,'outcome','deferred'); END IF;
 IF r.report ? 'update' AND EXISTS(SELECT 1 FROM deliveries WHERE namespace=r.namespace AND location_id=r.location_id AND period_start=r.period_start AND status IN ('sending','unknown')) THEN RETURN c||jsonb_build_object('delivery_claimed',false,'outcome','deferred'); END IF;
 -- A claimed attempt has never entered SMTP. Expired claims alone can be
 -- recovered; changing owner fences the old begin_delivery call.
 UPDATE deliveries SET owner=c->>'run_id',claimed_at=now() WHERE report_id=r.report_id AND recipient=c->>'recipient' AND status='claimed' AND claimed_at<now()-interval '30 minutes' RETURNING * INTO d;
 IF d.delivery_id IS NOT NULL THEN RETURN c||jsonb_build_object('delivery_claimed',true,'delivery_id',d.delivery_id); END IF;
 RETURN claim_delivery_v4(c);
END $$;
CREATE OR REPLACE FUNCTION finish_update(c jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE e update_evaluations; result text; notify boolean=false;
BEGIN
 IF c->>'update_kind' IS DISTINCT FROM 'friday_decisions' THEN RETURN c; END IF;
 SELECT * INTO STRICT e FROM update_evaluations WHERE evaluation_id=c->>'evaluation_id' FOR UPDATE;
 IF e.lease_owner<>c->>'run_id' THEN RAISE EXCEPTION 'Update owner lost'; END IF;
 IF e.status='ready' THEN
  result=CASE WHEN unresolved_period(e.namespace,e.location_id,e.period_start) OR EXISTS(SELECT 1 FROM issued_baseline(e.namespace,e.location_id,e.period_start) b WHERE b.report_id NOT IN (e.baseline_report_id,e.candidate_report_id)) OR EXISTS(SELECT 1 FROM deliveries WHERE report_id=e.candidate_report_id AND status='claimed') THEN 'deferred'
   WHEN EXISTS(SELECT 1 FROM deliveries WHERE report_id=e.candidate_report_id AND status='accepted') THEN 'issued'
   WHEN EXISTS(SELECT 1 FROM deliveries WHERE report_id=e.candidate_report_id AND status='failed') THEN 'delivery_failed' ELSE 'unissued' END;
  UPDATE update_evaluations SET status=result,lease_until=CASE WHEN result='deferred' THEN now()+interval '15 minutes' ELSE NULL END,finished_at=CASE WHEN result='deferred' THEN NULL ELSE now() END,updated_at=now() WHERE evaluation_id=e.evaluation_id;
  IF result='deferred' THEN notify=update_diagnostic(e,'delivery_deferred'); END IF;
 ELSE result=e.status; END IF;
 RETURN c||jsonb_build_object('update_outcome',result,'notify_update',notify OR COALESCE((c->>'notify_update')::boolean,false));
END $$;
CREATE OR REPLACE FUNCTION finish_delivery(c jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE updated_id bigint;
BEGIN
 IF c->>'status' NOT IN ('accepted','failed','unknown') THEN RAISE EXCEPTION 'Invalid SMTP outcome'; END IF;
 UPDATE deliveries SET status=c->>'status',finished_at=now(),message_id=c->>'message_id',provider_response=c->'diagnostic'
 WHERE delivery_id=(c->>'delivery_id')::bigint AND owner=c->>'run_id' AND status='sending' RETURNING delivery_id INTO updated_id;
 IF updated_id IS NOT NULL AND c->>'status'='accepted' THEN
  UPDATE update_evaluations SET status='issued',finished_at=now(),updated_at=now() WHERE candidate_report_id=c->>'report_id' AND status IN ('delivery_failed','deferred');
 END IF;
 RETURN jsonb_build_object('schema_version',c->>'schema_version','run_id',c->>'run_id','location_id',c->>'location_id','report_id',c->>'report_id','mode',c->>'mode','outcome',c->>'status','delivery_id',c->>'delivery_id');
END $$;
-- Separate identities prevent a weekly missed notice masking Friday's notice.
CREATE OR REPLACE FUNCTION record_missed_schedule(c jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE loc jsonb; added bigint; affected integer=0; job text=COALESCE(c->>'update_kind','weekly'); period date=(c->>'period_start')::date;
BEGIN
 IF c->>'mode'<>'production' OR c->>'notice_due' IS DISTINCT FROM 'true' THEN RETURN c||jsonb_build_object('notify_missed',false); END IF;
 FOR loc IN SELECT value FROM jsonb_array_elements(c#>'{config,locations}') WHERE value->>'enabled'='true' LOOP
  IF job='weekly' AND EXISTS(SELECT 1 FROM reports WHERE namespace='production' AND location_id=loc->>'id' AND period_start=period) THEN CONTINUE; END IF;
  IF job='friday_decisions' AND EXISTS(SELECT 1 FROM update_evaluations WHERE namespace='production' AND location_id=loc->>'id' AND period_start=period AND trigger_scheduled_for=(c->>'trigger_scheduled_for')::timestamptz AND status IN ('no_change','issued','baseline_missing','comparison_error','delivery_failed','unissued')) THEN CONTINUE; END IF;
  INSERT INTO operational_events(kind,run_id,diagnostic,notification_key) VALUES('missed_schedule',c->>'run_id',jsonb_build_object('job',job,'location_id',loc->>'id','period_start',period,'trigger_scheduled_for',c->>'trigger_scheduled_for'),'missed_schedule:'||job||':'||period||':'||(loc->>'id')) ON CONFLICT DO NOTHING RETURNING id INTO added;
  IF added IS NOT NULL THEN affected=affected+1; END IF;
 END LOOP;
 RETURN c||jsonb_build_object('notify_missed',affected>0);
END $$;
INSERT INTO schema_migrations(version) VALUES(5) ON CONFLICT DO NOTHING;
COMMIT;
