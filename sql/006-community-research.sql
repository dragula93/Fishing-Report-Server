BEGIN;
CREATE TABLE IF NOT EXISTS research_jobs (
 job_id text PRIMARY KEY,namespace text NOT NULL CHECK(namespace IN ('production','test')),location_id text NOT NULL,
 occurrence timestamptz NOT NULL,report_anchor timestamptz NOT NULL,trigger text NOT NULL,
 status text NOT NULL DEFAULT 'pending',attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),model_reservations integer NOT NULL DEFAULT 0 CHECK(model_reservations BETWEEN 0 AND 1),
 lease_owner text,lease_until timestamptz,next_attempt_at timestamptz,
 plan jsonb NOT NULL,policy jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS research_attempts (
 job_id text REFERENCES research_jobs(job_id),attempt integer CHECK(attempt BETWEEN 1 AND 3),
 started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,status text NOT NULL,
 model_reservations integer NOT NULL DEFAULT 1 CHECK(model_reservations BETWEEN 0 AND 1),budget jsonb NOT NULL,audit jsonb,
 PRIMARY KEY(job_id,attempt)
);
CREATE TABLE IF NOT EXISTS research_batches (
 batch_id text PRIMARY KEY,job_id text NOT NULL REFERENCES research_jobs(job_id),attempt integer NOT NULL,
 namespace text NOT NULL,location_id text NOT NULL,status text NOT NULL,finished_at timestamptz NOT NULL DEFAULT now(),
 providers jsonb NOT NULL DEFAULT '[]',leads jsonb NOT NULL DEFAULT '[]',diagnostic jsonb,
 UNIQUE(job_id,attempt)
);
CREATE INDEX IF NOT EXISTS research_cache_lookup ON research_batches(namespace,location_id,finished_at DESC);
CREATE TABLE IF NOT EXISTS research_observations (
 batch_id text REFERENCES research_batches(batch_id) ON DELETE CASCADE,identity text NOT NULL,url text NOT NULL,
 evidence jsonb NOT NULL,expires_at timestamptz NOT NULL,PRIMARY KEY(batch_id,identity),CHECK(octet_length(evidence::text)<=16000)
);
ALTER TABLE research_jobs ADD COLUMN IF NOT EXISTS model_reservations integer NOT NULL DEFAULT 0 CHECK(model_reservations BETWEEN 0 AND 1);
-- Migration 006 is rerunnable in the isolated implementation workspace.
ALTER TABLE research_attempts DROP CONSTRAINT IF EXISTS research_attempts_model_reservations_check;
ALTER TABLE research_attempts ADD CONSTRAINT research_attempts_model_reservations_check CHECK(model_reservations BETWEEN 0 AND 1);
UPDATE research_jobs j SET model_reservations=1 WHERE EXISTS(SELECT 1 FROM research_attempts a WHERE a.job_id=j.job_id AND a.model_reservations=1);
CREATE OR REPLACE FUNCTION prune_research() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM research_observations WHERE expires_at<=now();
 DELETE FROM research_batches WHERE finished_at<now()-interval '30 days';
 DELETE FROM research_attempts a USING research_jobs q WHERE a.job_id=q.job_id AND q.updated_at<now()-interval '30 days';
 DELETE FROM research_jobs WHERE updated_at<now()-interval '30 days';
 DELETE FROM fishing_evidence WHERE evidence->>'provenance_type'='verified_public_community' AND (evidence->>'expires_at')::timestamptz<=now();
END $$;
CREATE OR REPLACE FUNCTION claim_research(c jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE j research_jobs; ceiling integer;
BEGIN
 PERFORM prune_research();
 IF NOT COALESCE((c->>'enabled')::boolean,false) THEN RETURN c||jsonb_build_object('claimed',false,'status','disabled'); END IF;
 IF c->>'namespace' NOT IN ('production','test') OR length(c->>'job_id')>250 OR c->>'lease_owner' IS NULL THEN RAISE EXCEPTION 'invalid research identity'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('research:'||(c->>'job_id'),0));
 INSERT INTO research_jobs(job_id,namespace,location_id,occurrence,report_anchor,trigger,plan,policy)
 VALUES(c->>'job_id',c->>'namespace',c->>'location_id',(c->>'occurrence')::timestamptz,(c->>'report_anchor')::timestamptz,c->>'trigger',c->'plan',c->'policy') ON CONFLICT DO NOTHING;
 SELECT * INTO j FROM research_jobs WHERE job_id=c->>'job_id' FOR UPDATE;
 IF j.namespace<>c->>'namespace' OR j.location_id<>c->>'location_id' THEN RAISE EXCEPTION 'research identity mismatch';END IF;
 ceiling=LEAST(3,GREATEST(1,COALESCE((j.policy->>'max_attempts')::integer,3)));
 IF j.status IN ('completed','completed_empty','disabled') OR j.attempts>=ceiling OR j.lease_until>now() OR j.next_attempt_at>now()
 OR now()>j.occurrence+LEAST(6,GREATEST(1,COALESCE((j.policy->>'catch_up_hours')::integer,6)))*interval '1 hour' THEN
  RETURN c||jsonb_build_object('claimed',false,'status',j.status,'attempt',j.attempts);
 END IF;
 UPDATE research_attempts SET status='lease_expired',finished_at=now() WHERE job_id=j.job_id AND finished_at IS NULL;
 IF j.model_reservations>=1 THEN
  UPDATE research_jobs SET status='failed',lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE job_id=j.job_id;
  RETURN c||jsonb_build_object('claimed',false,'status','failed','error','model_budget_exhausted');
 END IF;
 UPDATE research_jobs SET attempts=attempts+1,model_reservations=1,status='running',lease_owner=c->>'lease_owner',lease_until=now()+interval '5 minutes',updated_at=now() WHERE job_id=j.job_id RETURNING * INTO j;
 INSERT INTO research_attempts(job_id,attempt,status,budget) VALUES(j.job_id,j.attempts,'running',j.policy);
 RETURN c||jsonb_build_object('claimed',true,'attempt',j.attempts,'policy',j.policy,'plan',j.plan);
END $$;
CREATE OR REPLACE FUNCTION finish_research(c jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE j research_jobs;r jsonb; b text;state text; item jsonb;
BEGIN
 SELECT * INTO j FROM research_jobs WHERE job_id=c->>'job_id' FOR UPDATE;
 IF j.job_id IS NULL OR j.status<>'running' OR j.lease_owner<>c->>'lease_owner' OR j.attempts<>(c->>'attempt')::integer OR j.lease_until<=now() THEN RETURN jsonb_build_object('status','lease_lost','job_id',c->>'job_id'); END IF;
 r=c->'result';state=r->>'status';
 IF state NOT IN ('completed','completed_empty','partial','access_unavailable','rate_limited','failed','skipped','disabled') OR octet_length(r::text)>120000 OR jsonb_array_length(COALESCE(r->'records','[]'))>40 THEN RAISE EXCEPTION 'invalid research response';END IF;
 b=j.job_id||':'||j.attempts;
 INSERT INTO research_batches(batch_id,job_id,attempt,namespace,location_id,status,providers,leads,diagnostic)
 VALUES(b,j.job_id,j.attempts,j.namespace,j.location_id,state,COALESCE(r->'providers','[]'),COALESCE(r->'leads','[]'),jsonb_build_object('error',r->'error'));
 FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(r->'records','[]')) LOOP
  IF item->>'provenance_type'<>'verified_public_community' OR item->>'provider' NOT IN ('hulltruth','spacefish') OR item->>'location_id'<>j.location_id OR item->>'evidence_id' IS NULL THEN RAISE EXCEPTION 'invalid observation provenance';END IF;
  INSERT INTO research_observations(batch_id,identity,url,evidence,expires_at) VALUES(b,item->>'evidence_id',item->>'url',item,LEAST((item->>'expires_at')::timestamptz,now()+interval '30 days')) ON CONFLICT DO NOTHING;
 END LOOP;
 -- A known removal must also remove matching cached content. Unavailable pages
 -- are never re-confirmed: retain only their original timestamps until expiry.
 DELETE FROM research_observations o WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(r#>'{audit,page_outcomes}','[]')) x WHERE x->>'status'='deleted_or_unavailable' AND split_part(o.url,'#',1)=split_part(x->>'url','#',1));
 UPDATE research_attempts SET status=state,finished_at=now(),audit=COALESCE(r->'audit','{}') WHERE job_id=j.job_id AND attempt=j.attempts;
 -- Retry busy/missing-auth/pre-start cancellation only when the trusted service
 -- explicitly confirms zero model calls. Unknown/expired workers consume the
 -- reservation; they cannot launch a second model invocation for this job.
 IF r#>>'{audit,model_calls}'='0' AND r->>'error' IN ('writer_busy','authentication_failed','preempted_for_report') THEN
  UPDATE research_jobs SET model_reservations=0 WHERE job_id=j.job_id;
  UPDATE research_attempts SET model_reservations=0 WHERE job_id=j.job_id AND attempt=j.attempts;
 END IF;
 UPDATE research_jobs SET status=state,lease_owner=NULL,lease_until=NULL,next_attempt_at=now()+interval '15 minutes',updated_at=now() WHERE job_id=j.job_id;
 PERFORM prune_research();
 RETURN jsonb_build_object('status',state,'batch_id',b,'records',jsonb_array_length(COALESCE(r->'records','[]')),'attempt',j.attempts,'email_sent',false);
END $$;
CREATE OR REPLACE FUNCTION cached_research(ns text,loc text) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('batch',(SELECT to_jsonb(b)||jsonb_build_object('records',COALESCE((SELECT jsonb_agg(o.evidence) FROM research_observations o WHERE o.batch_id=b.batch_id AND o.expires_at>now()),'[]')) FROM research_batches b WHERE namespace=ns AND location_id=loc AND (status='completed_empty' OR status IN ('completed','partial') AND EXISTS(SELECT 1 FROM research_observations o WHERE o.batch_id=b.batch_id AND o.expires_at>now())) ORDER BY finished_at DESC LIMIT 1),
 'latest',(SELECT to_jsonb(b) FROM research_batches b WHERE namespace=ns AND location_id=loc ORDER BY finished_at DESC LIMIT 1));
$$;
INSERT INTO schema_migrations(version) VALUES(6) ON CONFLICT DO NOTHING;
COMMIT;
