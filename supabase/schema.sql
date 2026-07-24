-- ══════════════════════════════════════════════════════════════════════
-- Claude Flow — Supabase 스키마
-- Supabase 대시보드 → SQL Editor 에 그대로 붙여넣고 "Run" 하세요.
-- ══════════════════════════════════════════════════════════════════════

-- 사용자별로 앱 상태(S 객체) 전체를 JSON 한 덩어리로 보관하는 테이블.
-- 앱이 단일 상태 객체를 쓰므로, 정규화 대신 blob 한 행으로 동기화한다.
create table if not exists public.flow_state (
  user_id    uuid        primary key references auth.users(id) on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  rev        bigint      not null default 0,      -- 단조 증가 리비전(충돌 판정용)
  updated_at timestamptz not null default now()
);

-- 행 수준 보안(RLS): 로그인한 본인 행만 읽고 쓸 수 있게 한다.
alter table public.flow_state enable row level security;

drop policy if exists "flow_state is private to owner" on public.flow_state;
create policy "flow_state is private to owner"
  on public.flow_state
  for all
  to authenticated
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ══════════════════════════════════════════════════════════════════════
-- (선택) 안전망: 저장할 때마다 이전 버전을 히스토리로 남겨 두면
--        만약의 덮어쓰기에도 과거 데이터를 되살릴 수 있다.
--        필요 없으면 이 블록은 건너뛰어도 된다.
-- ══════════════════════════════════════════════════════════════════════
create table if not exists public.flow_state_history (
  id         bigint generated always as identity primary key,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  data       jsonb       not null,
  rev        bigint      not null,
  saved_at   timestamptz not null default now()
);

alter table public.flow_state_history enable row level security;

drop policy if exists "flow_state_history is private to owner" on public.flow_state_history;
create policy "flow_state_history is private to owner"
  on public.flow_state_history
  for all
  to authenticated
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- flow_state 가 갱신될 때 이전 값을 히스토리에 적재하고, 최근 30개만 유지.
create or replace function public.flow_state_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.flow_state_history(user_id, data, rev)
  values (new.user_id, new.data, new.rev);

  delete from public.flow_state_history
  where user_id = new.user_id
    and id not in (
      select id from public.flow_state_history
      where user_id = new.user_id
      order by id desc
      limit 30
    );
  return new;
end;
$$;

drop trigger if exists trg_flow_state_snapshot on public.flow_state;
create trigger trg_flow_state_snapshot
  after insert or update on public.flow_state
  for each row execute function public.flow_state_snapshot();

-- ══════════════════════════════════════════════════════════════════════
-- 실시간 동기화(Realtime) 켜기
-- 다른 기기가 저장하면 그 즉시 이 기기로 받아오게 하려면
-- flow_state 테이블을 realtime 발행 목록에 넣어야 한다. (한 번만 실행, 중복 안전)
-- ══════════════════════════════════════════════════════════════════════
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'flow_state'
  ) then
    execute 'alter publication supabase_realtime add table public.flow_state';
  end if;
end $$;

-- ══════════════════════════════════════════════════════════════════════
-- 서버 자동화: 오늘의 리마인더 저장소 (digest Edge Function 이 매일 채움)
-- 사용자는 본인 것만 읽을 수 있고, 쓰기는 서버(service_role)만 한다.
-- ══════════════════════════════════════════════════════════════════════
create table if not exists public.daily_digest (
  user_id     uuid        primary key references auth.users(id) on delete cascade,
  digest      jsonb       not null default '{}'::jsonb,
  computed_at timestamptz not null default now()
);
alter table public.daily_digest enable row level security;

drop policy if exists "daily_digest owner can read" on public.daily_digest;
create policy "daily_digest owner can read"
  on public.daily_digest
  for select
  to authenticated
  using (auth.uid() = user_id);

-- ══════════════════════════════════════════════════════════════════════
-- 푸시 알림 구독 저장소. 기기(브라우저)마다 endpoint 하나.
-- 사용자는 본인 구독을 추가/삭제, 발송은 서버(service_role)가 읽어서 처리.
-- ══════════════════════════════════════════════════════════════════════
create table if not exists public.push_subscriptions (
  id           bigint generated always as identity primary key,
  user_id      uuid        not null references auth.users(id) on delete cascade,
  endpoint     text        not null,
  subscription jsonb       not null,
  created_at   timestamptz not null default now(),
  unique (user_id, endpoint)
);
alter table public.push_subscriptions enable row level security;

drop policy if exists "push_subscriptions are private to owner" on public.push_subscriptions;
create policy "push_subscriptions are private to owner"
  on public.push_subscriptions
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
