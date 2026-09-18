/* 폰을 바꿨을 때 — 새 기기에서 로그인하면 클라우드 데이터가 그대로 돌아와야 한다.
 *
 * 이 경로는 한 번 잘못되면 되돌릴 수 없다. 새 기기는 localStorage 가 비어 있는데,
 * 그 빈 상태를 클라우드에 올려버리면 원래 기록이 통째로 사라진다.
 * 그래서 '빈 기기 + 기록이 있는 클라우드' 조합을 여기서 못박아 둔다.
 *
 * 진짜 sync.js 를 vm 에 띄우고 PostgREST 의미를 흉내 낸 서버에 붙여 돌린다. */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { ROOT, makeOk } from './lib/env.mjs';

const ok = makeOk();
const SRC = fs.readFileSync(path.join(ROOT, 'sync.js'), 'utf8');

/* ── 가짜 서버 (sync.test.mjs 와 같은 의미) ── */
function makeServer() {
  const row = { data: null, rev: 0 };
  return {
    row,
    client(name, log) {
      return {
        from() {
          const q = { _upd: null, _eq: {} };
          q.select = () => {
            if (!q._upd) return q;
            const exists = row.data !== null || row.rev > 0;
            if (exists && row.rev === q._eq.rev) {
              row.data = q._upd.data; row.rev = q._upd.rev;
              log.push(`${name} 저장 rev=${row.rev}`);
              return Promise.resolve({ data: [{ rev: row.rev }], error: null });
            }
            log.push(`${name} 거절 (내가 알던 rev ${q._eq.rev} ≠ 서버 ${row.rev})`);
            return Promise.resolve({ data: [], error: null });
          };
          q.update = (v) => { q._upd = v; return q; };
          q.insert = (v) => {
            if (row.data !== null || row.rev > 0) return { select: () => Promise.resolve({ error: { code: '23505' } }) };
            row.data = v.data; row.rev = v.rev;
            log.push(`${name} 생성 rev=${row.rev}`);
            return { select: () => Promise.resolve({ data: [{ rev: row.rev }], error: null }) };
          };
          q.eq = (k, v) => { q._eq[k] = v; return q; };
          q.maybeSingle = () => Promise.resolve({
            data: (row.data !== null || row.rev > 0) ? { data: row.data, rev: row.rev } : null, error: null });
          return q;
        },
        channel: () => ({ on() { return this; }, subscribe() { return this; } }),
        removeChannel() {},
        auth: {
          getSession: () => Promise.resolve({ data: { session: null } }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
          signOut: () => Promise.resolve({ error: null }),
        },
      };
    },
  };
}

/* ── 기기 한 대. data 를 주지 않으면 '방금 산 폰'(저장된 것이 아무것도 없음) ── */
function makeDevice(name, server, log, { data, rev = 0, base } = {}) {
  const store = {};
  let reloaded = 0;
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
  if (data !== undefined) store['claudeflow_v1'] = JSON.stringify(data);
  if (rev) store['claudeflow_sync_rev'] = String(rev);
  if (base !== undefined) store['claudeflow_sync_base'] = JSON.stringify(base);
  Sync.client = server.client(name, log);
  Sync.session = { user: { id: 'u1' } };
  Sync.knownRev = rev;
  Sync.setStatus = () => {};
  Sync.emit = () => {};
  ctx.window.toast = () => {};
  ctx.window.reloadStateFromStorage = () => { reloaded++; };
  return {
    Sync, store,
    reloads: () => reloaded,
    read: () => (store['claudeflow_v1'] ? JSON.parse(store['claudeflow_v1']) : null),
  };
}

const TX = (id, memo) => ({ id, type: 'expense', date: '2026-09-15', amount: 12000, cat: '식비', memo, payKind: 'cash' });
const REAL = {
  accounts: [{ id: 'chk', type: 'checking', name: '하나 나라사랑통장', balance: 310000, cur: 'KRW' }],
  cards: [{ id: 'c1', type: 'credit', name: '하나 MOVING', accountId: 'chk', payDay: 14, tiers: [], exclCats: [], perks: [] }],
  tx: [TX('t1', '점심'), TX('t2', '커피')],
  settings: { buffer: 200000 },
};

/* ══════ ① 새 폰에서 로그인 — 클라우드 기록이 그대로 돌아온다 ══════ */
{
  const log = [], srv = makeServer();
  srv.row.data = REAL; srv.row.rev = 7;                     // 예전 폰이 올려둔 상태

  const neo = makeDevice('새폰', srv, log, {});             // 저장된 것이 아무것도 없다
  await neo.Sync.pull(true);

  const got = neo.read();
  ok('새 폰이 클라우드 기록을 받아온다', !!got && got.tx.length === 2, got ? `거래 ${got.tx.length}건` : '없음');
  ok('  계좌·잔액도 그대로', !!got && got.accounts[0].balance === 310000, got ? String(got.accounts[0].balance) : '-');
  ok('  카드도 그대로', !!got && got.cards.length === 1);
  ok('  설정도 그대로', !!got && got.settings.buffer === 200000);
  ok('  화면을 다시 그린다', neo.reloads() === 1, `reload ${neo.reloads()}회`);
  ok('  리비전을 이어받는다', neo.Sync.knownRev === 7, String(neo.Sync.knownRev));
  ok('  다음 병합 기준도 함께 저장', !!neo.store['claudeflow_sync_base']);
  ok('  클라우드는 건드리지 않았다', srv.row.rev === 7 && srv.row.data.tx.length === 2,
    `rev=${srv.row.rev} 거래 ${srv.row.data.tx.length}건`);
  ok('  빈 상태를 올리지 않았다', !log.some((l) => /저장|생성/.test(l)), log.join(' | ') || '쓰기 없음');
}

/* ══════ ② 빈 기기가 저장을 시도해도 클라우드를 비우지 않는다 ══════
   자동 저장 타이머가 pull 보다 먼저 돌 수도 있다. 그때 빈 로컬이 올라가면 끝이다. */
{
  const log = [], srv = makeServer();
  srv.row.data = REAL; srv.row.rev = 7;

  const neo = makeDevice('새폰', srv, log, {});
  neo.Sync.dirty = true;
  await neo.Sync.push();                                    // 로그인 직후 빈 상태로 push 시도

  ok('빈 기기의 저장은 클라우드를 지우지 않는다',
    srv.row.rev === 7 && srv.row.data.tx.length === 2, `rev=${srv.row.rev} 거래 ${srv.row.data.tx.length}건`);
}

/* ══════ ③ 리비전이 어긋나도(옛 폰 백업 복원 등) 빈 쪽이 이기지 않는다 ══════ */
{
  const log = [], srv = makeServer();
  srv.row.data = REAL; srv.row.rev = 3;

  // 로컬은 비었는데 rev 만 높은 상태 (앱을 지웠다 다시 깔면 생길 수 있다)
  const neo = makeDevice('새폰', srv, log, { data: { accounts: [], cards: [], tx: [] }, rev: 9 });
  await neo.Sync.pull(true);

  const got = neo.read();
  ok('로컬이 비었으면 리비전이 높아도 클라우드를 받아온다', !!got && got.tx.length === 2,
    got ? `거래 ${got.tx.length}건` : '없음');
  ok('  클라우드가 지워지지 않았다', srv.row.data.tx.length === 2, `거래 ${srv.row.data.tx.length}건`);
}

/* ══════ ④ 로그인 전에 새 폰에서 뭔가 입력했다면 — 덮기 전에 백업 ══════ */
{
  const log = [], srv = makeServer();
  srv.row.data = REAL; srv.row.rev = 7;

  const mine = { accounts: [{ id: 'x', type: 'checking', name: '새로 만든 통장', balance: 5000, cur: 'KRW' }], cards: [], tx: [TX('n1', '새 폰에서 적은 것')] };
  const neo = makeDevice('새폰', srv, log, { data: mine, rev: 0 });
  await neo.Sync.pull(true);

  const got = neo.read();
  const bak = neo.store['claudeflow_conflict_backup'] ? JSON.parse(neo.store['claudeflow_conflict_backup']) : null;
  ok('클라우드 쪽을 채택하고', !!got && got.tx.length === 2, got ? `거래 ${got.tx.length}건` : '없음');
  ok('  덮기 전 상태를 백업해 둔다', !!bak && bak.data.tx[0].memo === '새 폰에서 적은 것',
    bak ? bak.data.tx.map((t) => t.memo).join(',') : '백업 없음');
}

/* ══════ ⑤ 받아온 뒤 새 폰에서 입력하면 정상적으로 올라간다 ══════ */
{
  const log = [], srv = makeServer();
  srv.row.data = REAL; srv.row.rev = 7;

  const neo = makeDevice('새폰', srv, log, {});
  await neo.Sync.pull(true);

  const now = neo.read();
  now.tx.push(TX('t3', '새 폰에서 첫 기록'));
  neo.store['claudeflow_v1'] = JSON.stringify(now);
  neo.Sync.dirty = true;
  await neo.Sync.push();

  ok('새 폰의 첫 기록이 클라우드에 올라간다', srv.row.rev === 8 && srv.row.data.tx.length === 3,
    `rev=${srv.row.rev} 거래 ${srv.row.data.tx.length}건`);
  ok('  예전 기록도 그대로 남아 있다',
    srv.row.data.tx.some((t) => t.id === 't1') && srv.row.data.tx.some((t) => t.id === 't2'),
    srv.row.data.tx.map((t) => t.id).join(','));
}

/* ══════ ⑥ 옛 폰과 새 폰을 같이 써도 서로 지우지 않는다 ══════ */
{
  const log = [], srv = makeServer();
  srv.row.data = REAL; srv.row.rev = 7;

  const old = makeDevice('옛폰', srv, log, { data: REAL, rev: 7, base: REAL });
  const neo = makeDevice('새폰', srv, log, {});
  await neo.Sync.pull(true);                                // 새 폰이 받아옴 (rev 7)

  // 두 기기가 같은 시점에서 각자 기록
  const a = old.read(); a.tx.push(TX('old1', '옛 폰 기록')); old.store['claudeflow_v1'] = JSON.stringify(a);
  const b = neo.read(); b.tx.push(TX('new1', '새 폰 기록')); neo.store['claudeflow_v1'] = JSON.stringify(b);
  old.Sync.dirty = true; neo.Sync.dirty = true;

  await old.Sync.push();
  await neo.Sync.push();

  const ids = srv.row.data.tx.map((t) => t.id);
  ok('두 기기의 기록이 모두 남는다', ids.includes('old1') && ids.includes('new1'), ids.join(','));
  ok('  예전 기록도 그대로', ids.includes('t1') && ids.includes('t2'), ids.join(','));
}

/* ══════ ⑦ 로그아웃은 이 기기의 데이터를 지우지 않는다 ══════ */
{
  const log = [], srv = makeServer();
  srv.row.data = REAL; srv.row.rev = 7;
  const neo = makeDevice('새폰', srv, log, {});
  await neo.Sync.pull(true);
  await neo.Sync.signOut();
  const got = neo.read();
  ok('로그아웃해도 이 기기의 기록은 남는다', !!got && got.tx.length === 2, got ? `거래 ${got.tx.length}건` : '없음');
}
