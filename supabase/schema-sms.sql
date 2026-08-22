-- ══════════════════════════════════════════════════════════════════════
-- Claude Flow — 문자 자동 기록 (SMS → 거래)
-- Supabase 대시보드 → SQL Editor 에 그대로 붙여넣고 "Run" 하세요.
--
-- 동작 개요
--   폰이 카드 결제 문자를 받으면 → 단축어/자동화가 sms 함수로 문자 원문을 보냄
--   → 서버는 원문만 sms_inbox 에 쌓아둠(해석은 하지 않음)
--   → 앱이 켜지면 원문을 가져와 직접 해석하고, 확신이 서는 것만 자동 기록.
--
-- 왜 서버에서 해석하지 않나?
--   해석 결과를 서버가 직접 가계부에 써 넣으면 기기에서 편집 중인 내용과
--   충돌할 수 있다. 원문만 전달하고 판단·기록은 앱이 하면 기존 동기화 규칙
--   (로컬 우선 + rev 비교)을 그대로 유지할 수 있다.
-- ══════════════════════════════════════════════════════════════════════

-- ── 1. 수신 토큰 ──────────────────────────────────────────────────────
-- 폰의 단축어는 로그인 세션이 없다. 대신 사용자마다 발급되는 긴 무작위
-- 토큰으로 자신을 증명한다. (앱 설정에서 언제든 새로 발급 = 기존 토큰 무효)
create table if not exists public.sms_tokens (
  user_id    uuid        primary key references auth.users(id) on delete cascade,
  token      text        not null unique,
  created_at timestamptz not null default now()
);

alter table public.sms_tokens enable row level security;

drop policy if exists "sms_tokens are private to owner" on public.sms_tokens;
create policy "sms_tokens are private to owner"
  on public.sms_tokens
  for all
  to authenticated
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── 2. 받은 문자함 ────────────────────────────────────────────────────
-- hash 는 원문의 sha-256. 같은 문자가 두 번 들어와도 한 건만 남는다.
create table if not exists public.sms_inbox (
  id          bigint generated always as identity primary key,
  user_id     uuid        not null references auth.users(id) on delete cascade,
  raw         text        not null,
  sender      text        not null default '',
  hash        text        not null,
  received_at timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  unique (user_id, hash)
);

create index if not exists sms_inbox_user_idx on public.sms_inbox (user_id, id);

alter table public.sms_inbox enable row level security;

drop policy if exists "sms_inbox is private to owner" on public.sms_inbox;
create policy "sms_inbox is private to owner"
  on public.sms_inbox
  for all
  to authenticated
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── 3. 실시간 알림 ────────────────────────────────────────────────────
-- 앱이 켜져 있을 때 문자가 도착하면 즉시 반영되도록 realtime 에 등록.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sms_inbox'
  ) then
    execute 'alter publication supabase_realtime add table public.sms_inbox';
  end if;
end $$;

-- ── 4. 오래된 문자 정리 ───────────────────────────────────────────────
-- 앱이 처리하면 바로 지우지만, 앱을 오래 안 열면 쌓일 수 있다.
-- 30일 지난 원문은 자동으로 버린다. (pg_cron 이 켜져 있을 때만)
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('claude-flow-sms-cleanup')
      where exists (select 1 from cron.job where jobname = 'claude-flow-sms-cleanup');
    perform cron.schedule(
      'claude-flow-sms-cleanup', '30 4 * * *',
      $sql$ delete from public.sms_inbox where created_at < now() - interval '30 days' $sql$
    );
  end if;
end $$;
