-- SCAN / BOOK / GO — CP23 public hotel slugs
-- Public slug is presentation identity only. Hotel UUID and internal code remain authoritative.
-- Existing /book/{hotelCode} remains supported for compatibility.

alter table hotels
  add column if not exists public_slug text;

create or replace function sbg_slug_base(p_name text, p_code text)
returns text
language plpgsql
immutable
as $aether$
declare
  v text;
begin
  v := lower(regexp_replace(btrim(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g'));
  v := regexp_replace(v, '(^-+|-+$)', '', 'g');
  if v = '' then
    v := lower(regexp_replace(btrim(coalesce(p_code, 'hotel')), '[^a-z0-9]+', '-', 'g'));
    v := regexp_replace(v, '(^-+|-+$)', '', 'g');
  end if;
  if v = '' then v := 'hotel'; end if;
  return left(v, 80);
end;
$aether$;

create or replace function sbg_assign_public_slug()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $aether$
declare
  v_base text;
  v_slug text;
  v_suffix integer := 1;
begin
  if new.public_slug is not null and btrim(new.public_slug) <> '' then
    new.public_slug := lower(regexp_replace(btrim(new.public_slug), '[^a-z0-9]+', '-', 'g'));
    new.public_slug := regexp_replace(new.public_slug, '(^-+|-+$)', '', 'g');
  else
    v_base := sbg_slug_base(new.name, new.code);
    v_slug := v_base;
    while lower(v_slug) in ('app','api','ops','login','book','confirmed','favicon','robots','sitemap','assets') loop
      v_suffix := v_suffix + 1;
      v_slug := left(v_base, 70) || '-' || v_suffix::text;
    end loop;

    while exists (select 1 from hotels where public_slug = v_slug and id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid)) loop
      v_suffix := v_suffix + 1;
      v_slug := left(v_base, 70) || '-' || v_suffix::text;
    end loop;
    new.public_slug := v_slug;
  end if;

  if new.public_slug is null or new.public_slug !~ '^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$' then
    raise exception 'invalid public hotel slug' using errcode = '22023';
  end if;
  return new;
end;
$aether$;

drop trigger if exists hotels_public_slug_assign on hotels;
create trigger hotels_public_slug_assign
before insert or update of public_slug, name, code on hotels
for each row
execute function sbg_assign_public_slug();

update hotels
set public_slug = null
where public_slug is null or btrim(public_slug) = '';

alter table hotels
  alter column public_slug set not null;

create unique index if not exists hotels_public_slug_uidx
  on hotels (public_slug);

revoke all on function sbg_slug_base(text,text) from public;
revoke all on function sbg_assign_public_slug() from public;

insert into aether_meta (key, value)
values ('checkpoint', '23')
on conflict (key) do update set value = excluded.value, updated_at = now();
