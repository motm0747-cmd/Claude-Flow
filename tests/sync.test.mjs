/* 동기화 동시 편집 — 두 기기가 같은 시점에서 저장했을 때.
 *
 * 예전에는 upsert 가 조건 없이 덮어써서 나중에 저장한 쪽이 상대 기록을 통째로 지웠고,
 * realtime 도 'rev 가 같으면 내 것' 으로 단정해 상대 변경을 영영 받지 못했다.
 * 이제 서버가 조건부로만 쓰고(flow_state_cas), 부딪히면 앱이 3-way 로 합친다.
 *
 * 서버는 flow_state_cas 의 의미를 그대로 흉내 낸다 — 진짜 sync.js 를 두 벌 띄워서 돌린다. */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { ROOT, makeOk } from './lib/env.mjs';

const ok = makeOk();
const SRC = fs.readFileSync(path.join(ROOT, 'sync.js'), 'utf8');

/* ── 가짜 서버 ── */
function makeServer({ cas = true } = {}) {
  const row = { data: null, rev: 0 };
  return {
    row,
    client(name, log) {
      return {
        rpc(fn, args) {
          if (!cas || fn !== 'flow_state_cas') {
            return Promise.resolve({ error: { code: 'PGRST202', message: 'Could not find the function' } });
          }
          const expected = args.p_expected || 0;
          if (row.rev !== expected) {           // 그 사이 누가 바꿨다 → 거절 + 현재 값
            log.push(`${name} 거절 (expected ${expected} ≠ 서버 ${row.rev})`);
            return Promise.resolve({ data: [{ ok: false, rev: row.rev, data: row.data }], error: null });
          }
          row.data = args.p_data; row.rev = expected + 1;
          log.push(`${name} 저장 rev=${row.rev}`);
          return Promise.resolve({ data: [{ ok: true, rev: row.rev, data: null }], error: null });
        },
        from() {
          const q = {
            select: () => q, eq: () => q,
            maybeSingle: () => Promise.resolve({ data: row.rev ? { data: row.data, rev: row.rev } : null, error: null }),
            upsert(r) {                          // 예전 방식 — 조건 없이 덮어쓴다
              const over = row.rev >= r.rev && row.data !== null;
              log.push(`${name} upsert rev=${r.rev}${over ? ' ← 덮어씀' : ''}`);
              row.data = r.data; row.rev = r.rev;
              return Promise.resolve({ error: null });
            },
          };
          return q;
        },
        channel: () => ({ on() { return this; }, subscribe() { return this; } }),
        removeChannel() {},
        auth: { getSession: () => Promise.resolve({ data: { session: null } }),
                onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
      };
    },
  };
}

/* ── 기기 한 대 ── */
function makeDevice(name, server, log, { data, rev, base, realStatus }) {
  const store = {};
  const ctx = {
    console, setTimeout, clearTimeout, Promise, JSON, Date, Math, Array, Object, String, Error,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    document: { addEventListener() {}, visibilityState: 'visible' },
    navigator: { onLine: true },
    addEventListener() {},
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const Sync = ctx.window.Sync;
  store['claudeflow_v1'] = JSON.stringify(data);
  store['claudeflow_sync_rev'] = String(rev);
  if (base !== undefined) store['claudeflow_sync_base'] = JSON.stringify(base);
  Sync.client = server.client(name, log);
  Sync.session = { user: { id: 'u1' } };
  Sync.knownRev = rev;
  Sync.dirty = true;
  if (!realStatus) Sync.setStatus = () => {};   // 대부분의 테스트는 상태 표시에 관심 없다
  Sync.emit = () => {};
  ctx.window.toast = () => {};
  return { Sync, store, ctx, read: () => JSON.parse(store['claudeflow_v1']) };
}

const TX = (id, memo) => ({ id, type: 'expense', date: '2026-09-15', amount: 1000, cat: '식비', memo, payKind: 'cash' });

/* ══════ ① 동시 저장 — 아무것도 사라지면 안 된다 ══════ */
{
  const log = [], srv = makeServer();
  const start = { tx: [TX('t1', '기존')], accounts: [{ id: 'a1', name: '통장', balance: 1000 }], settings: {} };
  srv.row.data = start; srv.row.rev = 5;

  const phone = makeDevice('폰', srv, log, {
    data: { ...start, tx: [TX('t1', '기존'), TX('t2', '폰에서 추가')] }, rev: 5, base: start });
  const pc = makeDevice('PC', srv, log, {
    data: { ...start, tx: [TX('t1', '기존'), TX('t3', 'PC에서 추가')] }, rev: 5, base: start });

  await phone.Sync.push();
  await pc.Sync.push();

  const ids = (srv.row.data.tx || []).map((t) => t.id).sort();
  ok('동시 저장 — 양쪽 기록이 모두 남음', ids.join(',') === 't1,t2,t3', ids.join(','));
  ok('  서버가 두 번째 저장을 거절했음', log.some((l) => /거절/.test(l)), log.join(' | '));
  ok('  합친 결과가 다시 올라감', srv.row.rev === 7, `rev=${srv.row.rev}`);
  ok('  합친 기기의 로컬에도 반영됨',
     pc.read().tx.map((t) => t.id).sort().join(',') === 't1,t2,t3',
     pc.read().tx.map((t) => t.id).join(','));
}

/* ══════ ② 삭제가 되살아나면 안 된다 ══════ */
{
  const log = [], srv = makeServer();
  const start = { tx: [TX('t1', '기존'), TX('t2', '지울 것')], accounts: [], settings: {} };
  srv.row.data = start; srv.row.rev = 5;

  // 폰: t2 를 지움 / PC: t3 를 추가
  const phone = makeDevice('폰', srv, log, { data: { ...start, tx: [TX('t1', '기존')] }, rev: 5, base: start });
  const pc = makeDevice('PC', srv, log, {
    data: { ...start, tx: [TX('t1', '기존'), TX('t2', '지울 것'), TX('t3', 'PC 추가')] }, rev: 5, base: start });

  await phone.Sync.push();   // 삭제가 먼저 올라감
  await pc.Sync.push();      // 충돌 → 합침

  const ids = (srv.row.data.tx || []).map((t) => t.id).sort();
  ok('내가 지운 항목이 되살아나지 않음', !ids.includes('t2'), ids.join(','));
  ok('  상대가 추가한 항목은 남음', ids.includes('t3'), ids.join(','));
}

/* ══════ ③ 같은 항목을 양쪽이 고쳤을 때 ══════ */
{
  const log = [], srv = makeServer();
  const start = { tx: [TX('t1', '원본')], accounts: [], settings: {} };
  srv.row.data = start; srv.row.rev = 5;

  const phone = makeDevice('폰', srv, log, { data: { tx: [TX('t1', '폰이 고침')], accounts: [], settings: {} }, rev: 5, base: start });
  const pc = makeDevice('PC', srv, log, { data: { tx: [TX('t1', 'PC가 고침')], accounts: [], settings: {} }, rev: 5, base: start });

  await phone.Sync.push();
  await pc.Sync.push();
  ok('같은 항목을 둘 다 고치면 서버 쪽을 따름', srv.row.data.tx[0].memo === '폰이 고침', srv.row.data.tx[0].memo);
  ok('  합쳤다는 사실이 요약에 남음', (pc.Sync.lastMerge || {}).clashed === 1, JSON.stringify(pc.Sync.lastMerge));
}

/* ══════ ④ 한쪽만 고쳤으면 그 변경이 이겨야 한다 ══════ */
{
  const log = [], srv = makeServer();
  const start = { tx: [TX('t1', '원본')], accounts: [], settings: { buffer: 0 } };
  srv.row.data = { ...start, tx: [TX('t1', '원본')], settings: { buffer: 500000 } };  // PC가 이미 올린 설정 변경
  srv.row.rev = 6;

  // 폰은 rev5 기준으로 거래만 추가 (설정은 안 건드림)
  const phone = makeDevice('폰', srv, log, {
    data: { ...start, tx: [TX('t1', '원본'), TX('t9', '폰 추가')] }, rev: 5, base: start });
  await phone.Sync.push();
  ok('상대만 바꾼 설정은 유지됨', srv.row.data.settings.buffer === 500000, String(srv.row.data.settings.buffer));
  ok('  내가 추가한 거래도 살아 있음', srv.row.data.tx.some((t) => t.id === 't9'), srv.row.data.tx.map((t) => t.id).join(','));
}

/* ══════ ⑤ 기준(base)이 없을 때도 데이터를 잃지 않는다 ══════ */
{
  const log = [], srv = makeServer();
  const start = { tx: [TX('t1', '기존')], accounts: [], settings: {} };
  srv.row.data = { tx: [TX('t1', '기존'), TX('t5', '클라우드')], accounts: [], settings: {} };
  srv.row.rev = 6;
  // base 를 저장한 적 없는 기기(예전 버전에서 올라온 경우)
  const phone = makeDevice('폰', srv, log, {
    data: { tx: [TX('t1', '기존'), TX('t6', '폰')], accounts: [], settings: {} }, rev: 5 });
  await phone.Sync.push();
  const ids = srv.row.data.tx.map((t) => t.id).sort();
  ok('기준이 없어도 양쪽이 합쳐짐(합집합)', ids.join(',') === 't1,t5,t6', ids.join(','));
}

/* ══════ ⑥ CAS 함수가 없는 프로젝트 — 동작은 하되 사실대로 알린다 ══════ */
{
  const log = [], srv = makeServer({ cas: false });
  srv.row.data = { tx: [TX('t1', '기존')], accounts: [], settings: {} }; srv.row.rev = 5;
  let status = null;
  const phone = makeDevice('폰', srv, log, {
    data: { tx: [TX('t1', '기존'), TX('t2', '폰')], accounts: [], settings: {} }, rev: 5, base: null });
  phone.Sync.setStatus = (s, m) => { status = { s, m }; };
  await phone.Sync.push();
  ok('스키마 업데이트 전이어도 저장은 됨', srv.row.rev === 6 && srv.row.data.tx.length === 2, `rev=${srv.row.rev}`);
  ok('  보호가 꺼져 있다고 알림', /동시 편집 보호가 꺼져/.test((status && status.m) || ''), (status && status.m) || '없음');
}

/* ══════ ⑦ realtime — 같은 rev 를 내 것으로 단정하던 구멍 ══════ */
{
  // 예전 조건 (r > knownRev) 와 지금 조건 (r !== knownRev) 을 나란히 본다
  const oldCond = (r, known) => r > known;
  const newCond = (r, known) => r !== known;
  ok('예전 조건: 같은 rev 면 상대 변경을 놓쳤음', oldCond(6, 6) === false);
  ok('지금 조건: 내 것(같은 rev)만 무시', newCond(6, 6) === false);
  ok('  상대 것(다른 rev)은 받아옴', newCond(7, 6) === true);
}

/* ══════ ⑧ 진짜 sync.js 안의 조건을 확인 ══════ */
{
  ok('sync.js 가 조건부 저장(RPC)을 쓴다', /rpc\(CAS_FN/.test(SRC));
  ok('  realtime 조건이 !== 로 바뀌었다', /r !== self\.knownRev/.test(SRC));
  ok('  병합 기준(base)을 저장한다', /BASE_KEY/.test(SRC) && /localStorage\.setItem\(BASE_KEY/.test(SRC));
  const sql = fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8');
  ok('schema.sql 에 CAS 함수가 있다', /create or replace function public\.flow_state_cas/.test(sql));
  ok('  RLS 를 우회하지 않는다 (security invoker)', /security invoker/.test(sql));
  ok('  리비전이 맞을 때만 쓴다', /where user_id = auth\.uid\(\) and rev = p_expected/.test(sql));
}

/* ══════ ⑨ 성공하면 지난 오류 문구가 남지 않는다 ══════
   (남겨두면 다 나은 뒤에도 '동시 편집 보호 꺼짐' 경고가 계속 붙는다) */
{
  const log = [], srv = makeServer();
  srv.row.data = { tx: [TX('t1', '기존')], accounts: [], settings: {} }; srv.row.rev = 5;
  const phone = makeDevice('폰', srv, log, {
    data: { tx: [TX('t1', '기존'), TX('t2', '폰')], accounts: [], settings: {} },
    rev: 5, base: null, realStatus: true });
  phone.Sync.status = 'error'; phone.Sync.lastError = '지난 오류';
  await phone.Sync.push();
  ok('저장에 성공하면 지난 오류가 지워짐',
     phone.Sync.lastError === '' && phone.Sync.status === 'synced',
     `status=${phone.Sync.status} err="${phone.Sync.lastError}"`);
}

/* ══════ ⑩ 보호가 꺼진 상태는 계속 보여야 한다 ══════ */
{
  const log = [], srv = makeServer({ cas: false });
  srv.row.data = { tx: [TX('t1', '기존')], accounts: [], settings: {} }; srv.row.rev = 5;
  const phone = makeDevice('폰', srv, log, {
    data: { tx: [TX('t1', '기존'), TX('t2', '폰')], accounts: [], settings: {} },
    rev: 5, base: null, realStatus: true });
  await phone.Sync.push();
  ok('CAS 가 없으면 성공해도 경고가 남음',
     phone.Sync.status === 'synced' && /동시 편집 보호가 꺼져/.test(phone.Sync.lastError),
     `"${phone.Sync.lastError}"`);
}
