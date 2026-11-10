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

/* ══════ ⑤-b 기준이 없을 때 "방금 친 값"이 사라지면 안 된다 ══════
   claudeflow_sync_base 는 새로 생긴 키라 예전부터 쓰던 기기에는 없다. 그 상태에서
   충돌하면 무조건 클라우드를 택하게 돼 있어서 — 통장 잔액에 310000 을 넣어도
   클라우드의 옛 0 으로 되돌아갔다. 실제로 사용자가 겪은 증상이다. */
{
  const log = [], srv = makeServer();
  const ACC = (bal) => ({
    accounts: [{ id: 'chk', type: 'checking', name: '생활비 통장', balance: bal, cur: 'KRW' }],
    tx: [], settings: {} });
  srv.row.data = ACC(0); srv.row.rev = 6;            // 클라우드엔 아직 0
  const pc = makeDevice('PC', srv, log, { data: ACC(310000), rev: 5 });   // base 없음
  await pc.Sync.push();
  ok('기준이 없어도 방금 입력한 잔액이 남음',
     srv.row.data.accounts[0].balance === 310000, `${srv.row.data.accounts[0].balance}원`);
  ok('  이 기기 화면에도 그대로', pc.read().accounts[0].balance === 310000,
     `${pc.read().accounts[0].balance}원`);
  ok('  기준 없이 부딪혔다는 사실을 알림',
     (pc.Sync.lastMerge || {}).clashed === 1 && (pc.Sync.lastMerge || {}).noBase === true,
     JSON.stringify(pc.Sync.lastMerge));
}

/* ══════ ⑤-c 리비전이 같으면 그 시점을 기준으로 삼는다 ══════
   (예전 버전에서 올라온 기기가 기준을 처음 확보하는 경로) */
{
  const log = [], srv = makeServer();
  const data = { tx: [TX('t1', '기존')], accounts: [], settings: {} };
  srv.row.data = data; srv.row.rev = 7;
  const phone = makeDevice('폰', srv, log, { data, rev: 7 });   // base 없음, rev 는 일치
  phone.Sync.dirty = false;
  await phone.Sync.pull();
  ok('리비전이 같으면 기준이 저장됨', !!phone.store['claudeflow_sync_base'],
     phone.store['claudeflow_sync_base'] ? '저장됨' : '없음');
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


/* ══════ ⑩ 왜 안 되는지 말해줘야 한다 ══════
 * 로그인·동기화는 설정·네트워크·서버·계정 어느 한 곳만 어긋나도 전부 '오류' 한 단어로만
 * 보였다. 프로젝트가 멈췄을 때는 lastError 가 "{}" 였다 — 사용자가 할 수 있는 게 없다. */
{
  const ctx2 = (() => {
    const store = {};
    const c = {
      console, setTimeout, clearTimeout, Promise, JSON, Date, Math, Array, Object, String, Error,
      localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
      document: { addEventListener() {}, visibilityState: 'visible' },
      navigator: { onLine: true }, addEventListener() {},
      atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    };
    c.window = c; c.globalThis = c; c.self = c;
    vm.createContext(c); vm.runInContext(SRC, c);
    return c;
  })();
  const M = ctx2.window.Sync._msg.bind(ctx2.window.Sync);
  const cases = [
    ['서버에 못 닿을 때', { message: 'Failed to fetch' }, /닿지 못했|멈춰/],
    ['비밀번호가 틀릴 때', { message: 'Invalid login credentials' }, /비밀번호/],
    ['이메일 인증 전', { message: 'Email not confirmed' }, /인증/],
    ['이미 가입된 이메일', { message: 'User already registered' }, /이미 가입/],
    ['프로젝트가 멈췄을 때(503)', { status: 503 }, /멈춰/],
    ['아무 정보도 없을 때', {}, /응답하지 않|점검/],
    ['테이블이 없을 때', { message: 'relation "flow_state" does not exist' }, /테이블|schema/],
  ];
  cases.forEach(([label, err, want]) => {
    const got = M(err);
    ok(`${label} 무엇을 하면 되는지 말한다`, want.test(got) && !/^\{?\}?$/.test(got), got);
  });
  ok('  영어 원문을 그대로 던지지 않는다',
    cases.every(([, e]) => !/^[\x00-\x7F]*$/.test(M(e))), M({ message: 'Failed to fetch' }));
}

/* ══════ ⑪ 기기에 남은 옛 프로젝트를 알아채고 되돌릴 수 있다 ══════
   프로젝트를 바꾼 적이 있으면 기기에 저장된 설정이 내장 설정을 가려 로그인이
   영영 실패하는데, 그 사실이 화면 어디에도 안 나왔다. */
{
  const store = {};
  const c = {
    console, setTimeout, clearTimeout, Promise, JSON, Date, Math, Array, Object, String, Error,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    document: { addEventListener() {}, visibilityState: 'visible' },
    navigator: { onLine: true }, addEventListener() {},
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    CLAUDE_FLOW_CONFIG: { supabaseUrl: 'https://builtin0000000000.supabase.co',
      supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' + 'x'.repeat(60) + '.yyyy' },
  };
  c.window = c; c.globalThis = c; c.self = c;
  vm.createContext(c); vm.runInContext(SRC, c);
  const S2 = c.window.Sync;

  S2.cfg = S2.loadCfg();
  const fresh = S2.where();
  ok('설정이 없으면 앱 기본을 쓴다', fresh.builtin === true && !fresh.overridden, fresh.url);

  store['claudeflow_sync_cfg'] = JSON.stringify({ url: 'https://oldproject000000.supabase.co', anonKey: 'eyJ.x.y' });
  S2.cfg = S2.loadCfg();
  const stale = S2.where();
  ok('옛 프로젝트가 남아 있으면 그걸 쓴다', stale.url.includes('oldproject'), stale.url);
  ok('  앱 기본과 다르다는 것을 알아챈다', stale.overridden === true);
  ok('  앱 기본 주소도 함께 알려준다', stale.builtinUrl.includes('builtin'), stale.builtinUrl);

  S2.client = null; S2._unsubscribeRealtime = () => {};
  S2.init = () => {};                       // 되돌린 뒤 실제 연결까지는 여기서 보지 않는다
  await S2.useBuiltin();
  const back = S2.where();
  ok('  되돌리면 앱 기본으로 돌아온다', back.builtin === true && !back.overridden, back.url);
  ok('  기기에 저장된 설정도 지워진다', !store['claudeflow_sync_cfg'], store['claudeflow_sync_cfg'] || '없음');
}

/* ═══════════════════════════════════════════════════════════════════════
 * 아래부터는 "받아올 때(pull)" 의 구멍.
 *
 * 위의 보호는 전부 '올릴 때' 만 걸려 있었다. 그런데 앱을 열면 먼저 **받아오고**,
 * 그 경로는 서버 리비전이 높기만 하면 이 기기 것을 통째로 덮었다.
 * 못 올린 기록이 있어도 — 오프라인에서 적었거나, 적자마자 앱을 닫아 업로드가
 * 끊겼거나(iOS 는 백그라운드로 가면 진행 중인 요청을 끊는다) — 묻지 않고 사라졌다.
 * '올릴 게 남았는지' 도 메모리에만 있어서 앱을 다시 켜면 잊었다.
 * ═══════════════════════════════════════════════════════════════════════ */
const ACC1 = (bal) => [{ id: 'a1', type: 'checking', name: '통장', balance: bal, cur: 'KRW' }];

/* ══════ ⑫ 못 올린 기록이 있는데 다른 기기가 먼저 올렸다 ══════ */
{
  const log = [], srv = makeServer();
  const start = { tx: [TX('t1', '기존')], accounts: ACC1(10000), settings: {} };
  // PC 가 먼저 올려 서버는 rev 6
  srv.row.data = { ...start, tx: [TX('t1', '기존'), TX('t3', 'PC에서 추가')], accounts: ACC1(9000) };
  srv.row.rev = 6;
  // 폰: rev 5 에서 한 건 적고 못 올린 채 앱이 닫혔다 → 다시 열면 dirty 는 false 다
  const phone = makeDevice('폰', srv, log, {
    data: { ...start, tx: [TX('t1', '기존'), TX('t2', '폰에서 추가')], accounts: ACC1(8000) },
    rev: 5, base: start });
  phone.Sync.dirty = false;
  let ctx = null, reloads = 0;
  phone.ctx.window.reloadStateFromStorage = (c) => { reloads++; ctx = c || null; };
  await phone.Sync.pull(true);

  const ids = phone.read().tx.map((t) => t.id).sort().join(',');
  ok('받아올 때 못 올린 기록이 사라지지 않는다', ids === 't1,t2,t3', ids);
  ok('  합친 결과가 서버에도 올라간다',
    srv.row.rev === 7 && srv.row.data.tx.map((t) => t.id).sort().join(',') === 't1,t2,t3',
    `rev=${srv.row.rev} ${srv.row.data.tx.map((t) => t.id).join(',')}`);
  ok('  잔액은 양쪽 변화를 모두 반영한다 (10000 −1000 −2000)',
    phone.read().accounts[0].balance === 7000, String(phone.read().accounts[0].balance));
  ok('  화면을 다시 그린다', reloads === 1, `reload ${reloads}회`);
  ok('  앱에 무엇을 합쳤는지 넘겨준다 (중복 자동기록 정리용)',
    !!ctx && !!ctx.base && !!ctx.mine && !!ctx.theirs
      && ctx.mine.tx.some((t) => t.id === 't2') && ctx.theirs.tx.some((t) => t.id === 't3'),
    ctx ? Object.keys(ctx).join(',') : '없음');
}

/* ══════ ⑫-b 올릴 게 없으면 그냥 받아온다 — 쓸데없이 다시 올리지 않는다 ══════ */
{
  const log = [], srv = makeServer();
  const start = { tx: [TX('t1', '기존')], accounts: ACC1(10000), settings: {} };
  srv.row.data = { ...start, tx: [TX('t1', '기존'), TX('t3', 'PC에서 추가')] }; srv.row.rev = 6;
  const phone = makeDevice('폰', srv, log, { data: start, rev: 5, base: start });
  phone.Sync.dirty = false;
  await phone.Sync.pull(true);
  ok('내 쪽 변경이 없으면 받아오기만 한다', phone.read().tx.length === 2 && srv.row.rev === 6,
    `거래 ${phone.read().tx.length}건 rev=${srv.row.rev}`);
  ok('  서버에 쓰지 않았다', !log.some((l) => /저장|생성/.test(l)), log.join(' | ') || '쓰기 없음');
}

/* ══════ ⑫-c 합쳤는데 결과가 서버 것과 같으면 올리지 않는다 (기기끼리 핑퐁 방지) ══════ */
{
  const log = [], srv = makeServer();
  const start = { tx: [TX('t1', '기존')], accounts: ACC1(10000), settings: {} };
  const both = { ...start, tx: [TX('t1', '기존'), TX('t3', '같은 변경')] };
  srv.row.data = both; srv.row.rev = 6;
  const phone = makeDevice('폰', srv, log, { data: both, rev: 5, base: start });
  phone.Sync.dirty = false;
  await phone.Sync.pull(true);
  ok('합친 결과가 서버와 같으면 쓰지 않는다', srv.row.rev === 6 && phone.Sync.knownRev === 6,
    `서버 rev=${srv.row.rev} · 기기 rev=${phone.Sync.knownRev}`);
}

/* ══════ ⑬ 리비전은 같은데 못 올린 기록이 남아 있다 ══════
   적자마자 앱을 닫으면 1.5초 뒤로 미뤄둔 업로드가 실행되지 못한다. 다시 열었을 때
   리비전이 같다고 '동기화됨' 을 띄우면, 다른 기기에는 영영 안 보인다. */
{
  const log = [], srv = makeServer();
  const start = { tx: [TX('t1', '기존')], accounts: ACC1(10000), settings: {} };
  srv.row.data = start; srv.row.rev = 5;
  const phone = makeDevice('폰', srv, log, {
    data: { ...start, tx: [TX('t1', '기존'), TX('t2', '올리다 만 것')] }, rev: 5, base: start });
  phone.Sync.dirty = false;                       // 앱을 다시 켰다
  await phone.Sync.pull(true);
  ok('다시 열면 못 올린 기록을 마저 올린다',
    srv.row.rev === 6 && srv.row.data.tx.some((t) => t.id === 't2'),
    `rev=${srv.row.rev} ${srv.row.data.tx.map((t) => t.id).join(',')}`);
}

/* ══════ ⑭ 두 기기가 같은 통장에서 각자 썼다 — 잔액이 한쪽 것만 남으면 안 된다 ══════
   예전엔 계좌 레코드를 통째로 비교해서, 둘 다 잔액을 바꿨으면 서버 쪽을 택했다.
   거래는 양쪽 다 남는데 잔액은 한쪽만 깎여, 내역과 잔액이 조용히 어긋났다. */
{
  const log = [], srv = makeServer();
  const start = { tx: [TX('t1', '기존')], accounts: ACC1(10000), settings: {} };
  srv.row.data = start; srv.row.rev = 5;
  const phone = makeDevice('폰', srv, log, {
    data: { ...start, tx: [TX('t1', '기존'), TX('t2', '폰 3천원')], accounts: ACC1(7000) }, rev: 5, base: start });
  const pc = makeDevice('PC', srv, log, {
    data: { ...start, tx: [TX('t1', '기존'), TX('t3', 'PC 5천원')], accounts: ACC1(5000) }, rev: 5, base: start });
  await phone.Sync.push();
  await pc.Sync.push();
  const bal = srv.row.data.accounts[0].balance;
  ok('같은 통장을 양쪽에서 쓰면 잔액 변화가 합쳐진다 (10000 −3000 −5000)', bal === 2000, String(bal));
  ok('  그건 충돌이 아니다', (pc.Sync.lastMerge || {}).clashed === 0, JSON.stringify(pc.Sync.lastMerge));
  // 한쪽은 이름을, 다른 쪽은 잔액을 바꿨다 — 서로 다른 칸이면 둘 다 살린다
  const log2 = [], srv2 = makeServer();
  srv2.row.data = start; srv2.row.rev = 5;
  const a = makeDevice('폰', srv2, log2, {
    data: { ...start, accounts: [{ ...ACC1(10000)[0], name: '생활비' }] }, rev: 5, base: start });
  const b = makeDevice('PC', srv2, log2, { data: { ...start, accounts: ACC1(4000) }, rev: 5, base: start });
  await a.Sync.push(); await b.Sync.push();
  const acc = srv2.row.data.accounts[0];
  ok('  서로 다른 칸을 고쳤으면 둘 다 남는다', acc.name === '생활비' && acc.balance === 4000,
    `${acc.name} · ${acc.balance}`);
}

/* ══════ ⑮ 설정은 항목별로 합친다 ══════
   설정을 한 덩어리로 비교하면, 폰에서 '남겨둘 돈' 을 바꾸고 PC 에서 화면 보기를
   바꾸기만 해도 한쪽이 통째로 사라졌다. */
{
  const log = [], srv = makeServer();
  const start = { tx: [], accounts: ACC1(1), settings: { buffer: 0, cardView: 'manage' } };
  srv.row.data = start; srv.row.rev = 5;
  const phone = makeDevice('폰', srv, log, {
    data: { ...start, settings: { buffer: 300000, cardView: 'manage' } }, rev: 5, base: start });
  const pc = makeDevice('PC', srv, log, {
    data: { ...start, settings: { buffer: 0, cardView: 'bill' } }, rev: 5, base: start });
  await phone.Sync.push(); await pc.Sync.push();
  const st = srv.row.data.settings;
  ok('서로 다른 설정을 바꿨으면 둘 다 남는다', st.buffer === 300000 && st.cardView === 'bill', JSON.stringify(st));
}

/* ══════ ⑯ 다른 기기에서 '전체 초기화' 했으면 되살리지 않는다 ══════
   못 올린 기록을 지키려고 받아올 때 합치게 됐지만, 서버가 일부러 비워진 경우까지 합치면
   지운 데이터가 이 기기에서 되살아나 다시 올라간다. 초기화는 초기화로 따른다. */
{
  const log = [], srv = makeServer();
  const start = { tx: [TX('t1', '기존')], accounts: ACC1(10000), settings: {} };
  srv.row.data = { accounts: [], cards: [], tx: [], fixed: [], invLogs: [], reports: {}, settings: {} };
  srv.row.rev = 6;                                // PC 가 모든 기기 초기화를 눌렀다
  const phone = makeDevice('폰', srv, log, {
    data: { ...start, accounts: ACC1(9000) }, rev: 5, base: start });   // 폰에는 못 올린 변경이 조금 있다
  phone.Sync.dirty = false;
  await phone.Sync.pull(true);
  ok('초기화된 클라우드를 받아오면 이 기기도 비워진다', phone.read().tx.length === 0 && phone.read().accounts.length === 0,
    `거래 ${phone.read().tx.length}건 · 계좌 ${phone.read().accounts.length}개`);
  ok('  지운 데이터를 다시 올리지 않는다', srv.row.rev === 6 && srv.row.data.tx.length === 0, `rev=${srv.row.rev}`);
  ok('  덮기 전 상태는 백업해 둔다', !!phone.store['claudeflow_conflict_backup']);
}
