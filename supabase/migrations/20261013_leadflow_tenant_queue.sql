BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Retain every existing lead/message replay index and ownership trigger.
ALTER TABLE public.google_connections
  ADD COLUMN IF NOT EXISTS gmail_ingestion_enabled boolean NOT NULL DEFAULT true;

-- Never guess which company owns a shared mailbox.
DO $mailbox_check$
DECLARE conflicts text;
BEGIN
  SELECT string_agg(mailbox, ', ') INTO conflicts FROM (
    SELECT lower(btrim(google_account_email)) AS mailbox
    FROM public.google_connections
    WHERE gmail_ingestion_enabled AND google_account_email IS NOT NULL
      AND btrim(google_account_email) <> ''
    GROUP BY lower(btrim(google_account_email)) HAVING count(*) > 1
  ) duplicate_owners;
  IF conflicts IS NOT NULL THEN
    RAISE EXCEPTION 'Multiple enabled companies own these Gmail mailboxes: %. Choose the correct owner before applying this migration.', conflicts;
  END IF;
END;
$mailbox_check$;

CREATE UNIQUE INDEX IF NOT EXISTS google_connections_gmail_ingestion_owner_unique
ON public.google_connections (lower(btrim(google_account_email)))
WHERE gmail_ingestion_enabled AND google_account_email IS NOT NULL
  AND btrim(google_account_email) <> '';

CREATE UNIQUE INDEX IF NOT EXISTS leads_company_id_id_unique
  ON public.leads(company_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS prospect_conversations_company_id_id_unique
  ON public.prospect_conversations(company_id, id);
CREATE INDEX IF NOT EXISTS company_users_user_company_idx
  ON public.company_users(user_id, company_id);
CREATE INDEX IF NOT EXISTS background_jobs_tenant_due_idx
  ON public.background_jobs((data->>'companyId'), priority, created_at, id)
  WHERE status IN ('queued','retrying');
CREATE INDEX IF NOT EXISTS background_jobs_due_claim_idx
  ON public.background_jobs(run_at, priority, created_at, id)
  WHERE status IN ('queued','retrying');
CREATE UNIQUE INDEX IF NOT EXISTS background_jobs_one_running_per_company
  ON public.background_jobs((data->>'companyId')) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS background_jobs_tenant_status_idx
  ON public.background_jobs((data->>'companyId'), status);

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname='inbound_emails_tenant_lead_fk' AND conrelid='public.inbound_emails'::regclass) THEN
    ALTER TABLE public.inbound_emails ADD CONSTRAINT inbound_emails_tenant_lead_fk
      FOREIGN KEY(company_id,lead_id) REFERENCES public.leads(company_id,id)
      ON DELETE SET NULL(lead_id);
  END IF;
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname='prospects_tenant_lead_fk' AND conrelid='public.prospect_conversations'::regclass) THEN
    ALTER TABLE public.prospect_conversations ADD CONSTRAINT prospects_tenant_lead_fk
      FOREIGN KEY(company_id,promoted_lead_id) REFERENCES public.leads(company_id,id)
      ON DELETE SET NULL(promoted_lead_id);
  END IF;
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname='prospect_events_tenant_conversation_fk' AND conrelid='public.prospect_message_events'::regclass) THEN
    ALTER TABLE public.prospect_message_events ADD CONSTRAINT prospect_events_tenant_conversation_fk
      FOREIGN KEY(company_id,conversation_id) REFERENCES public.prospect_conversations(company_id,id)
      ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname='twilio_inbound_tenant_lead_fk' AND conrelid='public.twilio_inbound_messages'::regclass) THEN
    ALTER TABLE public.twilio_inbound_messages ADD CONSTRAINT twilio_inbound_tenant_lead_fk
      FOREIGN KEY(company_id,lead_id) REFERENCES public.leads(company_id,id)
      ON DELETE SET NULL(lead_id);
  END IF;
END;
$migration$;

CREATE TABLE IF NOT EXISTS public.leadflow_company_leases (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  holder text,
  expires_at timestamptz,
  last_claimed_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.leadflow_email_deliveries (
  operation_id text PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  rfc_message_id text NOT NULL UNIQUE,
  recipient text NOT NULL,
  request_body jsonb NOT NULL,
  status text NOT NULL DEFAULT 'reserved'
    CHECK(status IN ('reserved','sending','sent','uncertain')),
  provider_result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE SCHEMA IF NOT EXISTS leadflow_private;
REVOKE ALL ON SCHEMA leadflow_private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA leadflow_private TO authenticated;
CREATE OR REPLACE FUNCTION leadflow_private.is_company_member(p_company_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
  SELECT EXISTS(SELECT 1 FROM public.company_users
    WHERE user_id = (SELECT auth.uid()) AND company_id = p_company_id);
$function$;
REVOKE ALL ON FUNCTION leadflow_private.is_company_member(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION leadflow_private.is_company_member(uuid) TO authenticated;

-- Every customer-data table becomes closed to direct client writes.
DO $security$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'background_job_events','background_jobs','leads','dead_letter_jobs',
    'agent_jobs','appointments','job_events','jobs','gmail_tokens','emails',
    'company_users','job_logs','prospect_conversations','prospect_message_events',
    'company_knowledge','inbound_emails','google_connections','companies',
    'twilio_inbound_messages','leadflow_company_leases','leadflow_email_deliveries'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated',table_name);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role',table_name);
  END LOOP;
END;
$security$;
DO $view_security$
DECLARE view_name text;
BEGIN
  FOR view_name IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('v','m') LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated',view_name);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO service_role',view_name);
  END LOOP;
END;
$view_security$;
GRANT SELECT ON public.leads,public.appointments,public.companies,public.company_users TO authenticated;
DO $policies$
BEGIN
  IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename='leads' AND policyname='leadflow_member_read') THEN
    CREATE POLICY leadflow_member_read ON public.leads FOR SELECT TO authenticated
      USING(leadflow_private.is_company_member(company_id));
  END IF;
  IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename='companies' AND policyname='leadflow_member_read') THEN
    CREATE POLICY leadflow_member_read ON public.companies FOR SELECT TO authenticated
      USING(leadflow_private.is_company_member(id));
  END IF;
  IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename='company_users' AND policyname='leadflow_own_membership_read') THEN
    CREATE POLICY leadflow_own_membership_read ON public.company_users FOR SELECT TO authenticated
      USING(user_id=(SELECT auth.uid()));
  END IF;
  IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename='appointments' AND policyname='leadflow_member_read') THEN
    CREATE POLICY leadflow_member_read ON public.appointments FOR SELECT TO authenticated
      USING(EXISTS(SELECT 1 FROM public.leads l WHERE l.id=appointments.lead_id
        AND leadflow_private.is_company_member(l.company_id)));
  END IF;
END;
$policies$;

CREATE OR REPLACE FUNCTION public.leadflow_acquire_company(p_company_id uuid,p_holder text)
RETURNS boolean LANGUAGE plpgsql SET search_path = '' AS $function$
DECLARE acquired uuid;
BEGIN
  IF p_holder IS NULL OR btrim(p_holder)='' THEN RAISE EXCEPTION 'missing_lease_holder'; END IF;
  INSERT INTO public.leadflow_company_leases(company_id,holder,expires_at,last_claimed_at)
  VALUES(p_company_id,p_holder,now()+interval '120 seconds',now())
  ON CONFLICT(company_id) DO UPDATE SET holder=EXCLUDED.holder,
    expires_at=EXCLUDED.expires_at,last_claimed_at=EXCLUDED.last_claimed_at
  WHERE public.leadflow_company_leases.holder IS NULL
     OR public.leadflow_company_leases.expires_at < now()
  RETURNING company_id INTO acquired;
  RETURN acquired IS NOT NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.leadflow_release_company(p_company_id uuid,p_holder text)
RETURNS boolean LANGUAGE plpgsql SET search_path = '' AS $function$
DECLARE released uuid;
BEGIN
  UPDATE public.leadflow_company_leases SET holder=NULL,expires_at=NULL
  WHERE company_id=p_company_id AND holder=p_holder RETURNING company_id INTO released;
  RETURN released IS NOT NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.leadflow_assert_company(p_company_id uuid,p_holder text)
RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $function$
  SELECT EXISTS(SELECT 1 FROM public.leadflow_company_leases
    WHERE company_id=p_company_id AND holder=p_holder AND expires_at>now()+interval '30 seconds');
$function$;

CREATE OR REPLACE FUNCTION public.leadflow_heartbeat_company(p_company_id uuid,p_holder text)
RETURNS boolean LANGUAGE plpgsql SET search_path = '' AS $function$
DECLARE renewed uuid;
BEGIN
  UPDATE public.leadflow_company_leases SET expires_at=now()+interval '120 seconds'
  WHERE company_id=p_company_id AND holder=p_holder AND expires_at>now()
  RETURNING company_id INTO renewed;
  RETURN renewed IS NOT NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.leadflow_claim_background_job(p_worker_id text)
RETURNS SETOF public.background_jobs LANGUAGE plpgsql SET search_path = '' AS $function$
DECLARE candidate public.background_jobs; tenant uuid;
BEGIN
  -- Fairly consider the oldest due job per company, preferring least recently served companies.
  FOR candidate IN
    SELECT b.* FROM public.background_jobs b
    LEFT JOIN public.leadflow_company_leases lease ON lease.company_id::text=b.data->>'companyId'
    WHERE b.status IN ('queued','retrying') AND b.run_at<=now()
      AND EXISTS(SELECT FROM public.companies c WHERE c.id::text=b.data->>'companyId')
      AND (lease.holder IS NULL OR lease.expires_at<now())
      AND NOT EXISTS(SELECT FROM public.background_jobs r WHERE r.status='running'
        AND r.data->>'companyId'=b.data->>'companyId')
    ORDER BY lease.last_claimed_at NULLS FIRST,b.priority,b.created_at,b.id
    LIMIT 128 FOR UPDATE OF b SKIP LOCKED
  LOOP
    tenant := (candidate.data->>'companyId')::uuid;
    IF public.leadflow_acquire_company(tenant,p_worker_id) THEN
      RETURN QUERY UPDATE public.background_jobs SET status='running',locked_by=p_worker_id,
        locked_at=now(),heartbeat_at=now(),leased_until=now()+interval '120 seconds',updated_at=now()
      WHERE id=candidate.id AND status IN ('queued','retrying') AND run_at<=now() RETURNING *;
      RETURN;
    END IF;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.leadflow_heartbeat_background_job(p_job_id text,p_worker_id text)
RETURNS boolean LANGUAGE plpgsql SET search_path = '' AS $function$
DECLARE tenant uuid;
BEGIN
  SELECT (data->>'companyId')::uuid INTO tenant FROM public.background_jobs
  WHERE id=p_job_id AND status='running' AND locked_by=p_worker_id AND leased_until>now() FOR UPDATE;
  IF tenant IS NULL OR NOT public.leadflow_heartbeat_company(tenant,p_worker_id) THEN RETURN false; END IF;
  UPDATE public.background_jobs SET heartbeat_at=now(),leased_until=now()+interval '120 seconds',updated_at=now()
  WHERE id=p_job_id AND status='running' AND locked_by=p_worker_id;
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.leadflow_finish_background_job(
  p_job_id text,p_worker_id text,p_result jsonb DEFAULT NULL,p_error text DEFAULT NULL,p_terminal boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $function$
DECLARE job public.background_jobs; next_status text; next_attempts integer;
BEGIN
  SELECT * INTO job FROM public.background_jobs WHERE id=p_job_id AND status='running'
    AND locked_by=p_worker_id AND leased_until>now() FOR UPDATE;
  IF NOT FOUND OR NOT public.leadflow_assert_company((job.data->>'companyId')::uuid,p_worker_id)
    THEN RAISE EXCEPTION 'worker_lease_lost'; END IF;
  next_attempts := job.attempts + CASE WHEN p_error IS NULL THEN 0 ELSE 1 END;
  next_status := CASE WHEN p_error IS NULL THEN 'completed'
    WHEN p_terminal OR next_attempts>=job.max_attempts THEN 'dead_letter' ELSE 'retrying' END;
  UPDATE public.background_jobs SET status=next_status,result=p_result,error=p_error,
    attempts=next_attempts,locked_by=NULL,locked_at=NULL,heartbeat_at=NULL,leased_until=NULL,
    completed_at=CASE WHEN next_status='completed' THEN now() ELSE completed_at END,
    failed_at=CASE WHEN p_error IS NOT NULL THEN now() ELSE failed_at END,
    dead_lettered_at=CASE WHEN next_status='dead_letter' THEN now() ELSE dead_lettered_at END,
    run_at=CASE WHEN next_status='retrying' THEN now()+make_interval(secs=>least(300,5*power(2,least(next_attempts-1,8))::integer)+floor(random()*5)::integer) ELSE run_at END,
    updated_at=now() WHERE id=p_job_id;
  PERFORM public.leadflow_release_company((job.data->>'companyId')::uuid,p_worker_id);
  RETURN jsonb_build_object('status',next_status,'attempts',next_attempts);
END;
$function$;

CREATE OR REPLACE FUNCTION public.leadflow_recover_background_jobs()
RETURNS integer LANGUAGE plpgsql SET search_path = '' AS $function$
DECLARE job public.background_jobs; recovered integer:=0;
BEGIN
  FOR job IN SELECT * FROM public.background_jobs WHERE status='running'
    AND leased_until<now()-interval '30 seconds' FOR UPDATE SKIP LOCKED LIMIT 100
  LOOP
    UPDATE public.background_jobs SET status=CASE WHEN attempts+1>=max_attempts THEN 'dead_letter' ELSE 'retrying' END,
      attempts=attempts+1,error='stale_worker_recovered',run_at=now()+interval '10 seconds',
      dead_lettered_at=CASE WHEN attempts+1>=max_attempts THEN now() ELSE dead_lettered_at END,
      locked_by=NULL,locked_at=NULL,heartbeat_at=NULL,leased_until=NULL,updated_at=now()
    WHERE id=job.id;
    PERFORM public.leadflow_release_company((job.data->>'companyId')::uuid,job.locked_by);
    recovered:=recovered+1;
  END LOOP;
  RETURN recovered;
END;
$function$;

CREATE OR REPLACE FUNCTION public.leadflow_insert_lead(p_row jsonb)
RETURNS SETOF public.leads LANGUAGE plpgsql SET search_path = '' AS $function$
DECLARE candidate public.leads; inserted public.leads; existing_id uuid;
BEGIN
  candidate := jsonb_populate_record(NULL::public.leads,p_row);
  IF candidate.company_id IS NULL OR NULLIF(candidate.fingerprint,'') IS NULL THEN
    RAISE EXCEPTION 'missing_lead_company_or_fingerprint';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(candidate.company_id::text||':'||candidate.fingerprint,0));
  SELECT id INTO existing_id FROM public.leads WHERE company_id=candidate.company_id
    AND fingerprint=candidate.fingerprint AND created_at>=now()-interval '24 hours'
    AND status<>'duplicate' ORDER BY created_at,id LIMIT 1;
  INSERT INTO public.leads(company_id,input,message,reply,status,priority,type,email,phone,
    customer_name,address,city,state,zip,preferred_time,issue_summary,qualification,fingerprint,
    duplicate_of,duplicate_detected_at)
  VALUES(candidate.company_id,candidate.input,candidate.message,candidate.reply,
    CASE WHEN existing_id IS NOT NULL THEN 'duplicate' ELSE candidate.status END,
    candidate.priority,candidate.type,candidate.email,candidate.phone,candidate.customer_name,
    candidate.address,candidate.city,candidate.state,candidate.zip,candidate.preferred_time,
    candidate.issue_summary,candidate.qualification,candidate.fingerprint,existing_id,
    CASE WHEN existing_id IS NOT NULL THEN now() ELSE NULL END)
  RETURNING * INTO inserted;
  IF inserted.status='new' THEN
    INSERT INTO public.background_jobs(id,name,data,status,priority,run_at,max_attempts)
    VALUES('process_new_lead:'||inserted.company_id||':'||inserted.id,'process_new_lead',
      jsonb_build_object('companyId',inserted.company_id,'leadId',inserted.id),'queued',100,now(),5)
    ON CONFLICT(id) DO NOTHING;
  END IF;
  RETURN NEXT inserted;
END;
$function$;

-- RPCs for worker/global operations are never callable by browser roles.
DO $rpc_permissions$
DECLARE routine record;
BEGIN
  FOR routine IN SELECT p.oid::regprocedure AS signature FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prokind='f'
      AND (p.proname LIKE 'leadflow_%' OR p.proname IN ('claim_next_job','heartbeat_job','recover_stale_jobs','move_to_dead_letter'))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',routine.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',routine.signature);
  END LOOP;
END;
$rpc_permissions$;
CREATE OR REPLACE FUNCTION public.leadflow_fence_tenant_write()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $function$
DECLARE headers jsonb; tenant text; holder text; row_data jsonb; row_company text;
BEGIN
  headers := COALESCE(NULLIF(current_setting('request.headers',true),''),'{}')::jsonb;
  tenant := headers->>'x-leadflow-company'; holder := headers->>'x-leadflow-holder';
  row_data := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  row_company := row_data->>'company_id';
  IF TG_TABLE_NAME='background_jobs' THEN
    row_company := row_data->'data'->>'companyId';
    IF TG_OP<>'DELETE' THEN
      IF NOT EXISTS(SELECT FROM public.companies WHERE id::text=row_company) THEN
        RAISE EXCEPTION 'background_job_company_scope_mismatch';
      END IF;
      IF NULLIF(row_data->'data'->>'leadId','') IS NOT NULL AND
        NOT EXISTS(SELECT FROM public.leads WHERE id::text=row_data->'data'->>'leadId' AND company_id::text=row_company) THEN
        RAISE EXCEPTION 'background_job_lead_scope_mismatch';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME='appointments' THEN
    SELECT company_id::text INTO row_company FROM public.leads WHERE id::text=row_data->>'lead_id';
  ELSIF TG_TABLE_NAME='companies' THEN row_company := row_data->>'id';
  END IF;
  IF tenant IS NOT NULL THEN
    IF row_company IS DISTINCT FROM tenant OR holder IS NULL
      OR NOT public.leadflow_assert_company(tenant::uuid,holder) THEN
      RAISE EXCEPTION 'worker_lease_lost_or_tenant_mismatch';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.leadflow_fence_tenant_write() FROM PUBLIC,anon,authenticated;
DO $fences$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['leads','inbound_emails','prospect_conversations',
    'prospect_message_events','background_jobs','google_connections','appointments',
    'companies','company_knowledge','twilio_inbound_messages','leadflow_email_deliveries'] LOOP
    IF NOT EXISTS(SELECT FROM pg_trigger WHERE tgname='leadflow_execution_fence'
      AND tgrelid=format('public.%I',target)::regclass) THEN
      EXECUTE format('CREATE TRIGGER leadflow_execution_fence BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.leadflow_fence_tenant_write()',target);
    END IF;
  END LOOP;
END;
$fences$;
NOTIFY pgrst, 'reload schema';
COMMIT;
