/* 실제 digest/index.ts 를 읽어 Deno·supabase·fetch 를 가짜로 갈아끼우고,
   푸시 요청이 정말 만들어지는지 + 그 본문이 구독자 키로 복호화되는지 확인한다. */
import fs from 'node:fs';
import { loadTypeScript, TMP, readRepo } from './lib/env.mjs';
const ts = await loadTypeScript();
import { cat, te, b64uToBytes, bytesToB64u } from './webpush.mjs';

// 타입 제거는 정규식이 아니라 tsc(transpileModule)로 한다 — 새 타입 문법이 추가될
// 때마다 정규식 목록을 손보지 않아도 되게.
let src = readRepo('supabase/functions/digest/index.ts');
src = src.replace('import { createClient } from "https://esm.sh/@supabase/supabase-js@2";', '');
src = src.replace('Deno.serve(async (req: Request) => {', 'globalThis.__h = (async (req) => {');
src = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
// 오류 메시지가 읽히도록 파일로 떨궈서 불러온다
const GEN = `${TMP}/_digest.gen.mjs`;
fs.writeFileSync(GEN, src);

// ── 가짜 Supabase ──
const db = { flow_state: [], daily_digest: [], push_subscriptions: [] };
globalThis.createClient = () => ({
  from(t) {
    const q = { _eq: {}, _sel: null, _count: false };
    q.select = (c, o) => { q._count = !!(o && o.head); return q; };
    q.eq = (k, v) => { q._eq[k] = v; return q; };
    q.upsert = (row) => { const i = db[t].findIndex(r => r.user_id === row.user_id);
      i >= 0 ? db[t][i] = row : db[t].push(row); return Promise.resolve({ error: null }); };
    q.delete = () => { q._del = true; return q; };
    q.then = (res) => {
      let rows = db[t].filter(r => Object.entries(q._eq).every(([k, v]) => r[k] === v));
      if (q._del) { db[t] = db[t].filter(r => !rows.includes(r)); return Promise.resolve({ error: null }).then(res); }
      if (q._count) return Promise.resolve({ count: rows.length, error: null }).then(res);
      return Promise.resolve({ data: rows, error: null }).then(res);
    };
    return q;
  },
});

// ── VAPID 키쌍 생성 ──
const vkp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const V_PUB = bytesToB64u(new Uint8Array(await crypto.subtle.exportKey('raw', vkp.publicKey)));
const V_PRIV = (await crypto.subtle.exportKey('jwk', vkp.privateKey)).d;
let env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc',
            VAPID_PUBLIC_KEY: V_PUB, VAPID_PRIVATE_KEY: V_PRIV, VAPID_SUBJECT: 'mailto:me@example.com' };
globalThis.Deno = { env: { get: k => env[k] } };

// ── 가짜 푸시 서비스 ──
let captured = [];
let pushStatus = 201;
globalThis.fetch = async (url, opt) => {
  captured.push({ url, headers: opt.headers, body: new Uint8Array(opt.body) });
  return { status: pushStatus, ok: pushStatus < 300, text: async () => pushStatus < 300 ? '' : 'push service said no' };
};

await import(`file://${GEN}`);
const H = globalThis.__h;

// ── 구독자(브라우저) 키쌍 ──
const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const subPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
const subAuth = crypto.getRandomValues(new Uint8Array(16));
const SUBSCRIPTION = { endpoint: 'https://fcm.googleapis.com/fcm/send/tok123',
  keys: { p256dh: bytesToB64u(subPub), auth: bytesToB64u(subAuth) } };

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
const expand = async (prk, info, len) => (await hmac(prk, cat(info, new Uint8Array([1])))).slice(0, len);
async function decrypt(body) {
  const salt = body.slice(0, 16), idlen = body[20];
  const asPub = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, kp.privateKey, 256));
  const prkKey = await hmac(subAuth, shared);
  const ikm = await expand(prkKey, cat(te('WebPush: info\0'), subPub, asPub), 32);
  const prk = await hmac(salt, ikm);
  const cek = await expand(prk, te('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await expand(prk, te('Content-Encoding: nonce\0'), 12);
  const k = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, k, ct));
  return JSON.parse(new TextDecoder().decode(pt.slice(0, pt.lastIndexOf(2))));
}

const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const tok = p => `Bearer x.${b64u(p)}.y`;
const call = (body, authPayload) => H(new Request('https://x.supabase.co/functions/v1/digest', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: tok(authPayload) },
  body: JSON.stringify(body) }));
const ok = (n, v, x = '') => { console.log(`${v ? '✅' : '❌'} ${n}${x ? ' — ' + x : ''}`); if (!v) process.exitCode = 1; };

const USER = 'u1';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
db.flow_state.push({ user_id: USER, data: {
  tx: [{ type: 'expense', date: today, amount: 5000, cat: '식비', payKind: 'cash' }],
  fixed: [{ name: '넷플릭스', amount: 9900, day: +today.slice(8, 10), active: true }],
  accounts: [], cards: [], budgets: {}, notify: {} } });
db.push_subscriptions.push({ id: 1, user_id: USER, subscription: SUBSCRIPTION });

// ═══ status ═══
let r = await (await call({ action: 'status' }, { sub: USER, role: 'authenticated' })).json();
ok('status: VAPID 준비됨', r.vapidReady === true, r.vapidError);
ok('status: 공개키 반환(앱이 대조용)', r.vapidPublic === V_PUB);
ok('status: 등록 기기 수', r.subscriptions === 1, String(r.subscriptions));

// ═══ test 발송 ═══
captured = [];
r = await (await call({ action: 'test' }, { sub: USER, role: 'authenticated' })).json();
ok('test: 발송 성공', r.ok === true && r.sent === 1, JSON.stringify(r));
ok('  푸시 서비스로 POST 1건', captured.length === 1, String(captured.length));
const req0 = captured[0];
ok('  endpoint 그대로 사용', req0.url === SUBSCRIPTION.endpoint);
ok('  Content-Encoding: aes128gcm', req0.headers['Content-Encoding'] === 'aes128gcm');
ok('  TTL 헤더', req0.headers['TTL'] === '86400');
ok('  Authorization vapid t=…,k=…', /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/.test(req0.headers['Authorization']));
const jwtParts = req0.headers['Authorization'].match(/t=([\w-]+)\.([\w-]+)\.([\w-]+)/);
ok('  JWT 서명이 VAPID 공개키로 검증됨',
  await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, vkp.publicKey,
    b64uToBytes(jwtParts[3]), te(jwtParts[1] + '.' + jwtParts[2])));
ok('  aud = 푸시 서비스 origin',
  JSON.parse(Buffer.from(jwtParts[2], 'base64url').toString()).aud === 'https://fcm.googleapis.com');
const dec = await decrypt(req0.body);
ok('  구독자 키로 복호화 성공', dec.title === '🔔 테스트 알림', JSON.stringify(dec).slice(0, 60));

// ═══ 매일 실행 (cron) ═══
captured = [];
r = await (await call({}, { role: 'service_role' })).json();
ok('run(cron): 사용자 전체 처리', r.ok === true && r.users === 1 && r.updated === 1, JSON.stringify(r));
ok('  고정비 임박 → 푸시 발송', r.pushed === 1 && r.failed === 0, JSON.stringify(r));
const dec2 = await decrypt(captured[0].body);
ok('  내용에 고정비 포함', dec2.body.includes('넷플릭스'), dec2.body);
ok('  daily_digest 저장됨', db.daily_digest.length === 1 && db.daily_digest[0].digest.items.length >= 2);

// ═══ 실패를 삼키지 않는지 ═══
pushStatus = 403;
r = await (await call({}, { role: 'service_role' })).json();
ok('403 실패가 응답에 드러남', r.failed === 1 && r.errors.length === 1 && r.errors[0].startsWith('403'), JSON.stringify(r.errors));
ok('  403 은 구독을 지우지 않음', db.push_subscriptions.length === 1);

// ═══ 사라진 구독 정리 ═══
pushStatus = 410;
r = await (await call({}, { role: 'service_role' })).json();
ok('410 이면 구독 삭제', db.push_subscriptions.length === 0, String(db.push_subscriptions.length));
pushStatus = 201;

// ═══ 구독 없을 때 test 안내 ═══
r = await (await call({ action: 'test' }, { sub: USER, role: 'authenticated' })).json();
ok('기기 미등록 시 안내 메시지', r.ok === false && /기기가 없어요/.test(r.error), r.error);

// ═══ VAPID 미설정 ═══
const saved = env.VAPID_PRIVATE_KEY; env.VAPID_PRIVATE_KEY = '';
r = await (await call({ action: 'status' }, { sub: USER, role: 'authenticated' })).json();
ok('시크릿 없으면 이유를 알려줌', r.vapidReady === false && /시크릿이 없어요/.test(r.vapidError), r.vapidError);
env.VAPID_PRIVATE_KEY = saved;

// ═══ 짝이 아닌 키쌍 탐지 ═══
const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
env.VAPID_PUBLIC_KEY = bytesToB64u(new Uint8Array(await crypto.subtle.exportKey('raw', other.publicKey)));
r = await (await call({ action: 'status' }, { sub: USER, role: 'authenticated' })).json();
ok('짝 아닌 키쌍 탐지', r.vapidReady === false && /한 쌍이 아니에요/.test(r.vapidError), r.vapidError);
env.VAPID_PUBLIC_KEY = V_PUB;

// ═══ 비로그인 차단 ═══
r = await H(new Request('https://x/functions/v1/digest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
ok('토큰 없으면 401', r.status === 401);

// ═══ 일반 사용자는 본인 것만 ═══
db.flow_state.push({ user_id: 'u2', data: { tx: [], fixed: [], accounts: [], cards: [] } });
r = await (await call({ action: 'run' }, { sub: USER, role: 'authenticated' })).json();
ok('일반 사용자 호출은 본인만 대상', r.users === 1, JSON.stringify({ users: r.users }));
