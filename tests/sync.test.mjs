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

/* ── 가짜 서버 ──
   PostgREST 의 의미를 그대로 흉내 낸다.
     update(...).eq('user_id',u).eq('rev',N).select()  →  조건이 맞는 행만 바뀌고 그 행이 돌아온다
   `legacy:true` 면 예전처럼 조건 없이 덮어쓰는 서버가 된다(고치기 전 동작 재현용). */
function makeServer({ legacy = false } = {}) {
  const row = { data: null, rev: 0 };
  return {
    row,
    client(name, log) {
      return {
        from() {
          const q = { _upd: null, _eq: {} };
          q.select = () => {
            if (!q._upd) return q;                       // 읽기용 체인
            // ── 조건부 UPDATE 실행 ──
            const wantRev = q._eq.rev;
            const exists = row.data !== null || row.rev > 0;
            if (legacy) {                                // 예전: 조건 무시하고 덮어씀
              const over = exists && row.rev >= q._upd.rev;
              log.push(`${name} 덮어쓰기 rev=${q._upd.rev}${over ? ' ← 상대 것 지움' : ''}`);
              row.data = q._upd.data; row.rev = q._upd.rev;
              return Promise.resolve({ data: [{ rev: row.rev }], error: null });
            }
            if (exists && row.rev === wantRev) {
              row.data = q._upd.data; row.rev = q._upd.rev;
              log.push(`${name} 저장 rev=${row.rev}`);
              return Promise.resolve({ data: [{ rev: row.rev }], error: null });
            }
            log.push(`${name} 거절 (내가 알던 rev ${wantRev} ≠ 서버 ${row.rev})`);
            return Promise.resolve({ data: [], error: null });   // 0행 = 조건 불일치
          };
          q.update = (v) => { q._upd = v; return q; };
          q.insert = (v) => {
            if (row.data !== null || row.rev > 0) {
              return { select: () => Promise.resolve({ error: { code: '23505' } }) };
            }
            row.data = v.data; row.rev = v.rev;
            log.push(`${name} 생성 rev=${row.rev}`);
            return { select: () => Promise.resolve({ data: [{ rev: row.rev }], error: null }) };
          };
          q.eq = (k, v) => { q._eq[k] = v; return q; };
          q.maybeSingle = () => Promise.resolve({
            data: (row.data !== null || row.rev > 0) ? { data: row.data, rev: row.rev } : null, error: null });
          q.upsert = (r) => {                            // 예전 경로(강제 덮어쓰기)에서만 쓰인다
            log.push(`${name} upsert rev=${r.rev}`);
            row.data = r.data; row.rev = r.rev;
            return Promise.resolve({ error: null });
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

/* ══════ ①-b 조건 없이 덮어쓰는 서버였다면 어떻게 되는가 (대조) ══════ */
{
  const log = [], srv = makeServer({ legacy: true });
  const start = { tx: [TX('t1', '기존')], accounts: [], settings: {} };
  srv.row.data = start; srv.row.rev = 5;
  const phone = makeDevice('폰', srv, log, {
    data: { ...start, tx: [TX('t1', '기존'), TX('t2', '폰')] }, rev: 5, base: start });
  const pc = makeDevice('PC', srv, log, {
    data: { ...start, tx: [TX('t1', '기존'), TX('t3', 'PC')] }, rev: 5, base: start });
  await phone.Sync.push();
  await pc.Sync.push();
  const ids = srv.row.data.tx.map((t) => t.id).sort();
  ok('(대조) 조건이 없으면 한쪽이 사라진다', !ids.includes('t2'), ids.join(','));
  ok('  그래서 지금은 조건을 건다', log.some((l) => /상대 것 지움/.test(l)), log.join(' | '));
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

/* ══════ ⑥ 따로 설정하지 않아도 보호가 켜져 있다 ══════
   예전엔 DB 함수를 직접 실행해야 했고, 안 한 사람은 조용히 위험한 상태였다.
   지금은 UPDATE 조건만으로 하므로 테이블만 있으면 바로 동작한다. */
{
  const log = [], srv = makeServer();
  srv.row.data = { tx: [TX('t1', '기존')], accounts: [], settings: {} }; srv.row.rev = 5;
  let status = null;
  const phone = makeDevice('폰', srv, log, {
    data: { tx: [TX('t1', '기존'), TX('t2', '폰')], accounts: [], settings: {} },
    rev: 5, base: null, realStatus: true });
  phone.Sync.emit = () => { status = { s: phone.Sync.status, m: phone.Sync.lastError }; };
  await phone.Sync.push();
  ok('추가 설정 없이 저장됨', srv.row.rev === 6, `rev=${srv.row.rev}`);
  ok('  경고 문구가 뜨지 않음', !((status && status.m) || ''), (status && status.m) || '(없음)');
  ok('  SQL 함수를 부르지 않음', !/rpc\(/.test(SRC), 'sync.js 에 rpc 호출 없음');
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
  // 조건부 저장을 UPDATE 의 WHERE 로 건다 — DB 함수가 없어도 원자적이다
  ok('저장할 때 리비전 조건을 건다', /\.eq\('rev', expected\)/.test(SRC));
  ok('  바뀐 행을 돌려받아 성공을 판정한다', /\.select\('rev'\)/.test(SRC) && /res\.data\.length/.test(SRC));
  ok('  realtime 조건이 !== 로 바뀌었다', /r !== self\.knownRev/.test(SRC));
  ok('  병합 기준(base)을 저장한다', /BASE_KEY/.test(SRC) && /localStorage\.setItem\(BASE_KEY/.test(SRC));
  const sql = fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8');
  ok('스키마에 rev 컬럼과 RLS 가 있다',
     /rev\s+bigint/.test(sql) && /auth\.uid\(\) = user_id/.test(sql));
  ok('  따로 실행할 함수가 없다', !/create or replace function public\.flow_state_cas/.test(sql));
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

