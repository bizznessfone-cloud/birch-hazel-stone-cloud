-- Aether Transfer — Phase 4 booking engine
-- No occupancy changes. occupies remains trigger-maintained.
-- Idempotency uses existing idempotency_keys (scope, key).
--
-- Implementation decisions (NOT recovered historical fact):
--   human reference     PT- + 10 Crockford chars
--   confirmation token  32-byte base64url, unique, public credential
--   pricing             unpriced stub; historical formula UNKNOWN
--   duration            required 1..1440; no default
--   assignment          not in this phase (vehicle_id/driver_id stay null)

insert into aether_meta (key, value)
values
  ('schema_phase', '4'),
  ('checkpoint', '4')
on conflict (key) do update
set
  value = excluded.value,
  updated_at = now();
