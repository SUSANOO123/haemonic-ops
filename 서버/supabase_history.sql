-- 해모닉 ERP — 문서 이력 보관 (2026-10-13, 안산점 지난 날짜 체크 풀림 사고 뒤 추가)
-- docs 가 바뀔 때마다 바뀌기 전 문서를 docs_history 에 남긴다 (14일 보관). 어떤 기기가 잘못 덮어써도 되돌릴 수 있다.
-- supabase_coach.sql 다음에 한 번 실행. (create trigger 포함 → "Potential issue detected" 창이 뜨면 Run query)

create table if not exists public.docs_history (
  id bigserial primary key,
  key text not null,
  saved_at bigint,                 -- 덮이기 전 문서의 savedAt
  doc jsonb not null,
  replaced_at timestamptz not null default now(),
  new_saved_at bigint              -- 덮어쓴 문서의 savedAt
);
create index if not exists docs_history_key_idx on public.docs_history(key, replaced_at desc);
alter table public.docs_history enable row level security;
-- 앱(브라우저)은 이력을 읽기만 한다 — 통과된 기기에서
drop policy if exists hist_read on public.docs_history;
create policy hist_read on public.docs_history for select to authenticated using (public.device_ok());

create or replace function public.docs_keep_history() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.doc is not null and old.doc is distinct from new.doc then
    insert into public.docs_history(key, saved_at, doc, new_saved_at) values (old.key, old.saved_at, old.doc, new.saved_at);
    -- 14일 지난 이력은 정리 (문서당 최근 것은 남긴다)
    delete from public.docs_history h where h.key = old.key and h.replaced_at < now() - interval '14 days'
      and h.id <> (select max(id) from public.docs_history where key = old.key);
  end if;
  return new;
end $$;
drop trigger if exists docs_keep_history on public.docs;
create trigger docs_keep_history before update on public.docs for each row execute function public.docs_keep_history();

-- 되돌리기 예시 (SQL Editor 에서 직접):
--   select id, replaced_at, saved_at, new_saved_at, length(doc::text) from public.docs_history where key = 'state:ansan' order by id desc limit 20;
--   -- 특정 날짜의 할 일 기록만 이전 판에서 가져오기 (다른 날짜·매출 등은 그대로):
--   update public.docs d set doc = jsonb_set(d.doc, '{days,2026-10-11}', (select h.doc->'days'->'2026-10-11' from public.docs_history h where h.id = <이력 id>)),
--          saved_at = (extract(epoch from now())*1000)::bigint, updated_at = now() where d.key = 'state:ansan';

-- 확인
select 'docs_history' as what, count(*)::text as value from public.docs_history
union all select 'trigger', count(*)::text from pg_trigger where tgname = 'docs_keep_history';
