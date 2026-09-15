/* 새로 추가한 3개 푸시 신호(스트릭 임박·현금흐름 위험·투자 기간 만료)가
   실제 digest/index.ts 를 통해 정확히 계산되는지 확인한다.
   기존 digest.test.mjs 와 달리 tsc(transpileModule)로 타입을 지워서 정규식 유지보수를 피한다. */
import fs from 'node:fs';
import { loadTypeScript, TMP, readRepo } from './lib/env.mjs';
const ts = await loadTypeScript();

const SCRATCH = TMP;
let src = readRepo('supabase/functions/digest/index.ts');
src = src.replace('import { createClient } from "https://esm.sh/@supabase/supabase-js@2";', '');
src = src.replace('Deno.serve(async (req: Request) => {', 'globalThis.__h = (async (req) => {');
const out = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
fs.writeFileSync(`${SCRATCH}/_digest2.gen.mjs`, out);

// ── 가짜 Supabase (daily_digest 저장 결과만 확인 — VAPID 없이 push는 건너뜀) ──
const db = { flow_state: [], daily_digest: [], push_subscriptions: [] };
globalThis.createClient = () => ({
  from(t) {
    const q = { _eq: {} };
    q.select = () => q;
    q.eq = (k, v) => { q._eq[k] = v; return q; };
    q.upsert = (row) => {
      const i = db[t].findIndex((r) => r.user_id === row.user_id);
      i >= 0 ? (db[t][i] = row) : db[t].push(row);
      return Promise.resolve({ error: null });
    };
    q.delete = () => { q._del = true; return q; };
    q.then = (res) => {
      let rows = db[t].filter((r) => Object.entries(q._eq).every(([k, v]) => r[k] === v));
      if (q._del) { db[t] = db[t].filter((r) => !rows.includes(r)); return Promise.resolve({ error: null }).then(res); }
      return Promise.resolve({ data: rows, error: null }).then(res);
    };
    return q;
  },
});
const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc' }; // VAPID는 비워둠 — digest 계산만 검증
globalThis.Deno = { env: { get: (k) => env[k] || '' } };
globalThis.fetch = async () => ({ status: 500, ok: false, text: async () => '' });

await import(`file://${SCRATCH}/_digest2.gen.mjs`);
const H = globalThis.__h;
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const tok = (p) => `Bearer x.${b64u(p)}.y`;
const call = (body, authPayload) => H(new Request('https://x.supabase.co/functions/v1/digest', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: tok(authPayload) },
  body: JSON.stringify(body),
}));
const ok = (n, v, x = '') => { console.log(`${v ? '✅' : '❌'} ${n}${x ? ' — ' + x : ''}`); if (!v) process.exitCode = 1; };
const items = (uid) => db.daily_digest.find((d) => d.user_id === uid)?.digest.items || [];

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const yst = addDays(today, -1);

// ── u1: 카드 연속결제 스트릭 — 어제까지 2일 연속, 오늘 한 번만 더 쓰면 3일 달성 ──
db.flow_state.push({ user_id: 'u1', data: {
  tx: [
    { type: 'expense', date: addDays(today, -2), amount: 20000, cat: '식비', payKind: 'card', payId: 'c1' },
    { type: 'expense', date: yst, amount: 20000, cat: '식비', payKind: 'card', payId: 'c1' },
  ],
  fixed: [], accounts: [], budgets: {}, notify: {},
  cards: [{ id: 'c1', type: 'credit', name: '테스트카드', tiers: [], exclCats: [],
    perks: [{ name: '기본적립', cat: '전체', kind: 'percent', value: 1, boost: 2, streakDays: 3, tier: 0 }] }],
} });

// ── u2: 현금흐름 위험 — 체크 잔액 10만원인데 3일 뒤 90만원 고정비 ──
db.flow_state.push({ user_id: 'u2', data: {
  tx: [], fixed: [{ name: '월세', kind: 'expense', amount: 900000, day: +addDays(today, 3).slice(8, 10), active: true }],
  accounts: [{ id: 'a1', type: 'checking', balance: 100000, cur: 'KRW' }],
  cards: [], budgets: {}, notify: {},
} });

// ── u3: 투자 계좌 수수료 우대 기간 D-5 ──
db.flow_state.push({ user_id: 'u3', data: {
  tx: [], fixed: [],
  accounts: [{ id: 'i1', type: 'invest', name: '서학개미 계좌', cur: 'USD', balance: 1000,
    fees: { buy: 0.1, sell: 0.1, etc: 0, min: 0, from: addDays(today, -30), to: addDays(today, 5) } }],
  cards: [], budgets: {}, notify: {},
} });

// ── u4: 기존 신호(예산 초과) 회귀 확인 ──
db.flow_state.push({ user_id: 'u4', data: {
  tx: [{ type: 'expense', date: today, amount: 600000, cat: '식비', payKind: 'cash' }],
  fixed: [], accounts: [], budgets: { [today.slice(0, 7)]: { total: 500000 } }, cards: [], notify: {},
} });

// ── u5: 투자 계좌 환전우대 D-8 — 7일 밖이라 아직 안 떠야 함 ──
db.flow_state.push({ user_id: 'u5', data: {
  tx: [], fixed: [],
  accounts: [{ id: 'i1', type: 'invest', name: 'A', cur: 'KRW', balance: 1000000,
    fxPref: { spread: 1, pref: 50, from: addDays(today, -10), to: addDays(today, 8) } }],
  cards: [], budgets: {}, notify: {},
} });

// ── u6: 전월 실적 미달로 잠긴 혜택은 스트릭 알림도 안 떠야 함 ──
db.flow_state.push({ user_id: 'u6', data: {
  tx: [
    { type: 'expense', date: addDays(today, -2), amount: 20000, cat: '식비', payKind: 'card', payId: 'c1' },
    { type: 'expense', date: yst, amount: 20000, cat: '식비', payKind: 'card', payId: 'c1' },
  ],
  fixed: [], accounts: [], budgets: {}, notify: {},
  cards: [{ id: 'c1', type: 'credit', name: '실적잠김카드', tiers: [500000], exclCats: [],
    perks: [{ name: '기본적립', cat: '전체', kind: 'percent', value: 1, boost: 2, streakDays: 3, tier: 1 }] }],
} });

// ── u7: 실적 미달이지만 '발급 첫 달' 이라 면제 → 스트릭 알림이 떠야 한다 ──
db.flow_state.push({ user_id: 'u7', data: {
  tx: [
    { type: 'expense', date: addDays(today, -2), amount: 20000, cat: '식비', payKind: 'card', payId: 'c1' },
    { type: 'expense', date: yst, amount: 20000, cat: '식비', payKind: 'card', payId: 'c1' },
  ],
  fixed: [], accounts: [], budgets: {}, notify: {},
  cards: [{ id: 'c1', type: 'credit', name: '신규카드', tiers: [500000], exclCats: [],
    issued: today.slice(0, 7) + '-01', exemptM: 1,
    perks: [{ name: '기본적립', cat: '전체', kind: 'percent', value: 1, boost: 2, streakDays: 3, tier: 1 }] }],
} });

const r = await (await call({ action: 'run' }, { role: 'service_role' })).json();
ok('run: 7명 모두 계산됨', r.updated === 7, JSON.stringify(r));
ok('발급 첫 달 면제 → 서버도 혜택 열린 것으로 봄(u7)',
   items('u7').some((i) => i.kind === 'streak'), JSON.stringify(items('u7').map((i) => i.kind)));

ok('스트릭 임박 신호(u1)', items('u1').some((i) => i.kind === 'streak' && /한 번만 더/.test(i.detail)), JSON.stringify(items('u1').map((i) => i.kind)));
ok('현금흐름 위험 신호(u2)', items('u2').some((i) => i.kind === 'flowrisk'), JSON.stringify(items('u2').map((i) => i.kind)));
ok('투자 기간 만료 D-5 신호(u3)', items('u3').some((i) => i.kind === 'invperiod' && /D-5/.test(i.title)), JSON.stringify(items('u3').map((i) => i.title)));
ok('기존 예산 신호 회귀 없음(u4)', items('u4').some((i) => i.kind === 'budget'), JSON.stringify(items('u4').map((i) => i.kind)));
ok('D-8은 7일 밖이라 안 떠야 함(u5)', !items('u5').some((i) => i.kind === 'invperiod'), JSON.stringify(items('u5').map((i) => i.title)));
ok('실적 미달로 잠긴 혜택은 스트릭도 안 떠야 함(u6)', !items('u6').some((i) => i.kind === 'streak'), JSON.stringify(items('u6').map((i) => i.kind)));

console.log(r.errors?.length ? 'errors: ' + JSON.stringify(r.errors) : '오류 없음');
