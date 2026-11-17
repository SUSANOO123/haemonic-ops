-- 해모닉 ERP — 매입 사진 자동 입력용 확인 표 + 매장 인터넷 주소 확인 보강 (2026-11-17)
-- supabase_nets.sql 다음에 한 번 실행. (함수 교체 포함 → 경고 창이 뜨면 Run query)

-- 1) 매장 인터넷 주소 확인 보강
--    지금까지 req_ip() 는 x-forwarded-for 의 첫 값을 믿었다. 그런데 이 머리글은 요청하는 쪽이 직접 써서 보낼 수 있어,
--    매장의 공인 IP 를 아는 사람이 그 값을 붙이면 매장 인터넷인 척할 수 있었다(11/17 점검에서 확인).
--    Supabase 앞단(Cloudflare)이 넣어 주는 cf-connecting-ip 는 요청자가 바꿀 수 없으므로 그것을 먼저 쓴다.
create or replace function public.req_ip() returns text
language plpgsql stable security definer set search_path = public as $$
declare h json; v text;
begin
  begin h := current_setting('request.headers', true)::json; exception when others then h := null; end;
  if h is null then return null; end if;
  v := nullif(trim(h->>'cf-connecting-ip'), '');
  if v is not null then return v; end if;
  v := nullif(trim(h->>'x-real-ip'), '');
  if v is not null then return v; end if;
  v := h->>'x-forwarded-for';
  if coalesce(v, '') = '' then return null; end if;
  return nullif(trim(split_part(v, ',', 1)), '');
end $$;
grant execute on function public.req_ip() to authenticated;

-- 2) 사진 자동 입력 확인 표 — 앱이 사진을 올리기 직전에 표를 한 장 받고, 서버 함수(Vercel)가 그 표가 진짜인지 되묻는다.
--    표는 등록된 기기·매장 인터넷에서만 나오고(device_ok), 한 번 쓰면 끝, 5분 뒤 무효. 한 시간에 60장까지(남용 방지).
create table if not exists public.ai_tickets (
  id text primary key,
  created_at timestamptz not null default now(),
  used boolean not null default false
);
alter table public.ai_tickets enable row level security;   -- 정책 없음: 아래 함수로만 드나든다

create or replace function public.ai_ticket() returns text
language plpgsql security definer set search_path = public as $$
declare v text;
begin
  if not public.device_ok() then raise exception '등록된 기기에서만 쓸 수 있습니다'; end if;
  delete from public.ai_tickets where created_at < now() - interval '1 day';
  if (select count(*) from public.ai_tickets where created_at > now() - interval '1 hour') >= 60 then
    raise exception '사진 자동 입력은 한 시간에 60장까지입니다. 잠시 뒤 다시 해 주세요';
  end if;
  v := encode(extensions.gen_random_bytes(18), 'hex');
  insert into public.ai_tickets(id) values (v);
  return v;
end $$;
grant execute on function public.ai_ticket() to authenticated;

create or replace function public.ai_ticket_check(p_ticket text) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.ai_tickets set used = true
    where id = p_ticket and not used and created_at > now() - interval '5 minutes';
  get diagnostics n = row_count;
  return n = 1;
end $$;
grant execute on function public.ai_ticket_check(text) to authenticated;

-- 확인
select 'req_ip(지금 요청)' as what, coalesce(public.req_ip(), '(SQL Editor 는 없음)') as value
union all select 'ai_tickets', count(*)::text from public.ai_tickets
union all select 'functions', string_agg(proname, ', ') from pg_proc where proname in ('ai_ticket', 'ai_ticket_check', 'req_ip');
