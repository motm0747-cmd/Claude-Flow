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

-- ══════════════════════════════════════════════════════════════════════
-- 동시 편집 안전장치 (compare-and-swap)
--
-- ⚠️ 이 함수가 없으면 두 기기가 같은 시점에서 저장할 때 한쪽 기록이 조용히 사라진다.
--    upsert 는 조건 없이 덮어쓰기 때문이다:
--      폰 rev 5 → 6 저장, PC 도 rev 5 → 6 저장 → 폰이 쓴 내용이 통째로 날아감.
--
-- 그래서 "내가 알고 있던 리비전일 때만 쓴다". 그 사이 누가 바꿨으면 쓰지 않고
-- 현재 값을 돌려주며, 합치는 일은 앱(sync.js)이 한다.
--
-- 기존 프로젝트에 이 블록만 따로 실행해도 안전하다 (앱은 함수가 없으면
-- 예전 방식으로 동작하되 경고를 띄운다).
-- ══════════════════════════════════════════════════════════════════════
create or replace function public.flow_state_cas(p_data jsonb, p_expected bigint)
returns table (ok boolean, rev bigint, data jsonb)
language plpgsql
security invoker                    -- RLS 를 그대로 적용받는다 (본인 행만)
set search_path = public
as $$
declare
  cur_rev bigint;
begin
  select fs.rev into cur_rev from public.flow_state fs where fs.user_id = auth.uid();

  -- 아직 행이 없다 → 처음 올리는 경우(expected 0)만 만든다
  if cur_rev is null then
    if coalesce(p_expected, 0) <> 0 then
      return query select false, 0::bigint, null::jsonb;   -- 누가 지웠다 → 앱이 판단
      return;
    end if;
    insert into public.flow_state(user_id, data, rev, updated_at)
      values (auth.uid(), p_data, 1, now());
    return query select true, 1::bigint, null::jsonb;
    return;
  end if;

  -- 그 사이 다른 기기가 바꿨다 → 쓰지 않고 현재 값을 돌려준다
  if cur_rev <> coalesce(p_expected, 0) then
    return query
      select false, cur_rev, fs.data from public.flow_state fs where fs.user_id = auth.uid();
    return;
  end if;

  update public.flow_state
     set data = p_data, rev = cur_rev + 1, updated_at = now()
   where user_id = auth.uid() and rev = p_expected;

  return query select true, cur_rev + 1, null::jsonb;
end;
$$;

revoke all on function public.flow_state_cas(jsonb, bigint) from public;
grant execute on function public.flow_state_cas(jsonb, bigint) to authenticated;
