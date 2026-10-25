BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.leadflow_enqueue_authenticated_intake(
  p_user_id uuid,
  p_message text,
  p_request_key text DEFAULT NULL,
  p_request_day bigint DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $function$
DECLARE
  tenant uuid;
  request_key text;
  job_id text;
  inserted_id text;
  existing_name text;
  existing_company text;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'missing_user_id'; END IF;
  IF p_message IS NULL OR length(p_message) < 10 OR length(p_message) > 5000 THEN
    RAISE EXCEPTION 'invalid_lead_message';
  END IF;

  -- Same oldest-membership selection as the existing authenticated-company helper.
  SELECT company_id INTO tenant FROM public.company_users
  WHERE user_id = p_user_id ORDER BY created_at ASC LIMIT 1;
  IF tenant IS NULL THEN RAISE EXCEPTION 'company_not_found'; END IF;

  request_key := NULLIF(btrim(p_request_key), '');
  IF request_key IS NULL THEN
    IF p_request_day IS NULL THEN RAISE EXCEPTION 'missing_request_day'; END IF;
    -- Preserve the previous company/day/message SHA-256 fallback exactly.
    request_key := encode(sha256(convert_to(
      tenant::text || ':' || p_request_day::text || ':' || p_message, 'UTF8'
    )), 'hex');
  END IF;
  IF length(request_key) > 200 THEN RAISE EXCEPTION 'invalid_idempotency_key'; END IF;
  job_id := 'ingest_lead_request:' || tenant::text || ':' || request_key;

  INSERT INTO public.background_jobs(id, name, data, status, attempts,
    max_attempts, priority, run_at, updated_at)
  VALUES(job_id, 'ingest_lead_request',
    jsonb_build_object('companyId', tenant, 'message', p_message),
    'queued', 0, 5, 100, now(), now())
  ON CONFLICT(id) DO NOTHING RETURNING id INTO inserted_id;

  IF inserted_id IS NULL THEN
    SELECT name, data->>'companyId' INTO existing_name, existing_company
    FROM public.background_jobs WHERE id = job_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'background_job_duplicate_but_missing'; END IF;
    IF existing_name IS DISTINCT FROM 'ingest_lead_request'
      OR existing_company IS DISTINCT FROM tenant::text THEN
      RAISE EXCEPTION 'background_job_company_scope_mismatch';
    END IF;
  END IF;

  INSERT INTO public.background_job_events(job_id, event_type, message, metadata)
  VALUES(job_id, CASE WHEN inserted_id IS NULL THEN 'deduplicated' ELSE 'queued' END,
    CASE WHEN inserted_id IS NULL THEN 'Duplicate enqueue request returned the existing background job.'
      ELSE 'Background job queued.' END,
    jsonb_build_object('name', 'ingest_lead_request', 'priority', 100, 'maxAttempts', 5));

  RETURN jsonb_build_object('companyId', tenant, 'jobId', job_id,
    'deduplicated', inserted_id IS NULL);
END;
$function$;

REVOKE ALL ON FUNCTION public.leadflow_enqueue_authenticated_intake(uuid,text,text,bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leadflow_enqueue_authenticated_intake(uuid,text,text,bigint)
  TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
