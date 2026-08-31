// ══════════════════════════════════════════════════════════════════════
// Claude Flow — 서버 자동화 + 웹 푸시 (Supabase Edge Function)
//
// 매일 스케줄로 실행: 각 사용자의 flow_state 를 훑어 리마인더를 계산해
// daily_digest 에 저장하고, '결제 임박/미기록' 같은 실행형 리마인더가 있으면
// 그 사용자의 push_subscriptions 로 웹 푸시를 보낸다.
//
// 시크릿 (푸시를 쓰려면 필요 — 없으면 저장만 하고 발송은 건너뜀):
//   VAPID_PUBLIC_KEY   앱의 PUSH_VAPID_PUBLIC 과 반드시 같은 값
//   VAPID_PRIVATE_KEY  위 공개키와 한 쌍인 비밀키 (32바이트 base64url)
//   VAPID_SUBJECT      mailto:you@example.com (선택)
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 는 자동 제공된다.
//
// ⚠️ 푸시 발송을 Node 라이브러리(web-push) 대신 Web Crypto 로 직접 구현했다.
//    web-push 는 node:crypto 의 createECDH 등에 의존해 Deno 런타임에서
//    실패할 수 있고, 실패가 조용히 묻히면 원인을 찾을 수 없기 때문이다.
//    여기서는 RFC 8291(aes128gcm) + RFC 8292(VAPID) 를 직접 처리한다.
//
// 호출 방법
//   { }                 또는 {action:"run"}  전체 계산 + 발송 (cron 용)
//   {action:"status"}   설정 점검 결과만 반환 (앱의 '알림 점검' 버튼)
//   {action:"test"}     호출한 사람에게 지금 바로 테스트 알림 발송
//   서비스 역할 키로 부르면 전체 사용자, 사용자 토큰으로 부르면 본인만 대상.
// ══════════════════════════════════════════════════════════════════════
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });

const won = (n: number) => Math.round(n || 0).toLocaleString("ko-KR") + "원";
function kstToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}
function daysBetween(a: string, b: string): number {
  const da = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  const db = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
  return Math.round((db - da) / 86400000);
}

type Item = { emo: string; title: string; detail: string; kind: string };

function computeDigest(data: any) {
  const today = kstToday();
  const Y = +today.slice(0, 4), M = +today.slice(5, 7), D = +today.slice(8, 10);
  const tx: any[] = Array.isArray(data?.tx) ? data.tx : [];
  const fixed: any[] = Array.isArray(data?.fixed) ? data.fixed : [];
  const items: Item[] = [];

  // 1) 최근 7일 지출(정보성)
  const wa = new Date(Date.UTC(Y, M - 1, D)); wa.setUTCDate(wa.getUTCDate() - 6);
  const waStr = wa.toISOString().slice(0, 10);
  let wExp = 0;
  for (const t of tx) if (t?.type === "expense" && t.date >= waStr && t.date <= today) wExp += (+t.amount || 0);
  items.push({ emo: "📊", title: "최근 7일 지출", detail: won(wExp), kind: "week" });

  // 2) 다가오는 고정비(오늘~+3일) — 실행형
  for (const f of fixed) {
    if (!f || f.active === false || !f.day) continue;
    for (let off = 0; off <= 3; off++) {
      const d = new Date(Date.UTC(Y, M - 1, D)); d.setUTCDate(d.getUTCDate() + off);
      if (d.getUTCDate() === f.day) {
        const when = off === 0 ? "오늘" : `${off}일 뒤`;
        items.push({ emo: "📌", title: `${when} 결제 예정`, detail: `${f.name || "고정비"} ${won(f.amount)}`, kind: "fixed" });
        break;
      }
    }
  }

  // 3) 오래 미기록(3일 이상) — 실행형
  let last = "";
  for (const t of tx) if (t?.date && t.date > last) last = t.date;
  if (last) {
    const gap = daysBetween(last, today);
    if (gap >= 3) items.push({ emo: "✍️", title: "기록이 뜸해요", detail: `${gap}일째 새 내역이 없어요`, kind: "inactive" });
  }

  // 4) 예산 80% 경고 — 실행형
  const ym = today.slice(0, 7);
  const budget = data?.budgets?.[ym];
  if (budget?.total > 0) {
    let mExp = 0;
    for (const t of tx) if (t?.type === "expense" && t.date?.slice(0, 7) === ym) mExp += (+t.amount || 0);
    const pct = Math.round(mExp / budget.total * 100);
    if (pct >= 80) {
      items.push({
        emo: pct >= 100 ? "🔴" : "🟡",
        title: pct >= 100 ? "예산을 초과했어요" : "예산 80% 도달",
        detail: `${won(mExp)} / ${won(budget.total)} (${pct}%)`,
        kind: "budget",
      });
    }
  }

  // 5) 카드 실적 마감 임박(월말 5일 이내)인데 미달 — 실행형
  const dim = new Date(Date.UTC(Y, M, 0)).getUTCDate();
  if (dim - D <= 5) {
    for (const c of (Array.isArray(data?.cards) ? data.cards : [])) {
      const target = c?.target || (Array.isArray(c?.tiers) && c.tiers.length ? Math.min(...c.tiers) : 0);
      if (!target || c?.type !== "credit") continue;
      let spend = 0;
      for (const t of tx) {
        if (t?.type === "expense" && t.payKind === "card" && t.payId === c.id && t.date?.slice(0, 7) === ym) {
          if (!t.noPerf && !(Array.isArray(c.exclCats) && c.exclCats.includes(t.cat))) spend += (+t.amount || 0);
        }
      }
      if (spend < target) {
        items.push({
          emo: "💳", title: `${c.name || "카드"} 실적 미달`,
          detail: `${won(target - spend)} 더 필요 (마감 ${dim - D}일 전)`, kind: "card",
        });
      }
    }
  }

  return { date: today, items, computedAt: new Date().toISOString() };
}

/* ══════════════════════════════════════════════════════════════════
   웹 푸시 (RFC 8291 aes128gcm + RFC 8292 VAPID) — Web Crypto 로만 구현
   ══════════════════════════════════════════════════════════════════ */
const te = (x: string) => new TextEncoder().encode(x);
function b64uToBytes(v: string): Uint8Array {
  const t = String(v).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}
function bytesToB64u(b: ArrayBuffer | Uint8Array): string {
  const a = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function cat(...arrs: Uint8Array[]): Uint8Array {
  let n = 0; for (const a of arrs) n += a.length;
  const out = new Uint8Array(n);
  let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
// 필요한 길이가 항상 32바이트 이하라 한 블록만 뽑으면 된다
async function hkdfExpand(prk: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  return (await hmac(prk, cat(info, new Uint8Array([1])))).slice(0, len);
}

async function encryptPayload(p256dh: string, auth: string, plaintext: string): Promise<Uint8Array> {
  const uaPub = b64uToBytes(p256dh);
  const authSecret = b64uToBytes(auth);
  if (uaPub.length !== 65 || uaPub[0] !== 4) throw new Error("구독 키(p256dh) 형식이 올바르지 않아요");
  if (authSecret.length !== 16) throw new Error("구독 키(auth) 형식이 올바르지 않아요");

  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));

  const prkKey = await hmac(authSecret, shared);
  const ikm = await hkdfExpand(prkKey, cat(te("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = await hkdfExpand(prk, te("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfExpand(prk, te("Content-Encoding: nonce\0"), 12);

  const payload = te(plaintext);
  if (payload.length > 3800) throw new Error("알림 내용이 너무 길어요");
  const cekKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, tagLength: 128 }, cekKey, cat(payload, new Uint8Array([2]))));

  const header = new Uint8Array(21 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);   // 레코드 크기
  header[20] = 65;                                          // 공개키 길이
  header.set(asPub, 21);
  return cat(header, ct);
}

type Vapid = { pub: string; priv: CryptoKey; pubKey: CryptoKey; subject: string };
async function loadVapid(): Promise<Vapid> {
  const pub = (Deno.env.get("VAPID_PUBLIC_KEY") || "").trim();
  const privB64 = (Deno.env.get("VAPID_PRIVATE_KEY") || "").trim();
  if (!pub || !privB64) throw new Error("VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 시크릿이 없어요");
  const pubBytes = b64uToBytes(pub);
  if (pubBytes.length !== 65 || pubBytes[0] !== 4) {
    throw new Error("VAPID_PUBLIC_KEY 형식이 올바르지 않아요 (65바이트 비압축 키여야 해요)");
  }
  const d = b64uToBytes(privB64);
  if (d.length !== 32) throw new Error("VAPID_PRIVATE_KEY 형식이 올바르지 않아요 (32바이트여야 해요)");

  const jwk = {
    kty: "EC", crv: "P-256", ext: true,
    x: bytesToB64u(pubBytes.slice(1, 33)), y: bytesToB64u(pubBytes.slice(33, 65)), d: bytesToB64u(d),
  };
  const MISMATCH = "VAPID 공개키와 비밀키가 한 쌍이 아니에요 (키를 새로 발급해 앱과 서버 양쪽을 함께 교체해주세요)";
  // 짝이 아닌 키는 대부분 여기서 'Invalid keyData' 로 거절된다 — 알아볼 수 있는 말로 바꿔준다
  let priv: CryptoKey;
  try {
    priv = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  } catch { throw new Error(MISMATCH); }
  const pubKey = await crypto.subtle.importKey("raw", pubBytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);

  // 런타임이 위에서 걸러주지 않는 경우를 대비해 서명·검증으로 한 번 더 확인한다
  const probe = te("claude-flow-vapid-selftest");
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, probe);
  if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pubKey, sig, probe))) {
    throw new Error(MISMATCH);
  }
  return { pub, priv, pubKey, subject: Deno.env.get("VAPID_SUBJECT") || "mailto:noreply@example.com" };
}

async function sendPush(v: Vapid, sub: any, payload: string) {
  const endpoint = String(sub?.endpoint || "");
  if (!/^https:\/\//.test(endpoint)) throw new Error("구독 endpoint 가 올바르지 않아요");
  const body = await encryptPayload(sub?.keys?.p256dh, sub?.keys?.auth, payload);

  const h = bytesToB64u(te(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const c = bytesToB64u(te(JSON.stringify({
    aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: v.subject,
  })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, v.priv, te(h + "." + c));

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `vapid t=${h}.${c}.${bytesToB64u(sig)}, k=${v.pub}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": "86400",
    },
    body,
  });
  const text = res.ok ? "" : (await res.text().catch(() => "")).slice(0, 200);
  return { status: res.status, ok: res.status >= 200 && res.status < 300, detail: text };
}

/* ── 호출자 판별 ─────────────────────────────────────────────────
   서비스 역할 키로 부르면(cron) 전체 사용자, 사용자 토큰으로 부르면 본인만. */
function jwtPayload(token: string): Record<string, unknown> {
  try {
    const p = token.split(".")[1];
    if (!p) return {};
    const b = p.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b + "=".repeat((4 - (b.length % 4)) % 4)));
  } catch { return {}; }
}
function caller(req: Request): { role: string; userId: string } {
  const p = jwtPayload((req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""));
  return { role: String(p.role || ""), userId: String(p.sub || "") };
}

const PUSH_TITLE = "🌅 오늘의 리마인더";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !serviceKey) return json({ error: "서버 설정이 완료되지 않았어요" }, 500);
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    let action = "run";
    try { action = String(((await req.json()) || {}).action || "run"); } catch { /* 본문 없음 = run */ }

    const who = caller(req);
    const isCron = who.role === "service_role";
    if (!isCron && !who.userId) return json({ error: "로그인이 필요해요" }, 401);

    // VAPID 상태를 먼저 확인해 둔다 (문제가 있으면 이유를 그대로 돌려준다)
    let vapid: Vapid | null = null, vapidError = "";
    try { vapid = await loadVapid(); } catch (e) { vapidError = String((e as Error)?.message || e); }

    /* ── 설정 점검 ── */
    if (action === "status") {
      const { count } = await admin.from("push_subscriptions")
        .select("id", { count: "exact", head: true }).eq("user_id", who.userId);
      return json({
        ok: true,
        vapidReady: !!vapid,
        vapidError,
        vapidPublic: vapid ? vapid.pub : "",   // 앱이 자기 키와 같은지 비교한다
        subscriptions: count || 0,
      });
    }

    /* ── 테스트 발송 ── */
    if (action === "test") {
      if (!vapid) return json({ ok: false, error: vapidError }, 400);
      const { data: subs } = await admin.from("push_subscriptions")
        .select("id,subscription").eq("user_id", who.userId);
      if (!subs?.length) {
        return json({ ok: false, error: "이 계정에 등록된 기기가 없어요. 먼저 '푸시 알림 켜기'를 눌러주세요" }, 400);
      }
      const payload = JSON.stringify({
        title: "🔔 테스트 알림", body: "알림이 정상적으로 도착했어요. Claude Flow", url: "./", tag: "test",
      });
      const results = [];
      for (const s of subs) {
        try {
          const r = await sendPush(vapid, s.subscription, payload);
          if (!r.ok && (r.status === 404 || r.status === 410)) {
            await admin.from("push_subscriptions").delete().eq("id", s.id);
          }
          results.push(r);
        } catch (e) {
          results.push({ status: 0, ok: false, detail: String((e as Error)?.message || e) });
        }
      }
      const sent = results.filter((r) => r.ok).length;
      return json({ ok: sent > 0, sent, tried: results.length, results });
    }

    /* ── 매일 계산 + 발송 ── */
    let q = admin.from("flow_state").select("user_id,data");
    if (!isCron) q = q.eq("user_id", who.userId);   // 사용자 호출은 본인 것만
    const { data: rows, error } = await q;
    if (error) throw error;

    let updated = 0, pushed = 0, failed = 0;
    const errors: string[] = [];

    for (const row of rows || []) {
      const digest = computeDigest(row.data);
      const { error: upErr } = await admin.from("daily_digest").upsert(
        { user_id: row.user_id, digest, computed_at: new Date().toISOString() },
        { onConflict: "user_id" },
      );
      if (!upErr) updated++;

      if (!vapid) continue;
      // 사용자가 켠 알림 종류만 발송 (S.notify — 값이 없으면 기본 ON)
      const pref = (row.data?.notify || {}) as Record<string, boolean>;
      const actionable = digest.items.filter((i) => i.kind !== "week" && pref[i.kind] !== false);
      if (!actionable.length) continue;

      const { data: subs } = await admin.from("push_subscriptions")
        .select("id,subscription").eq("user_id", row.user_id);
      if (!subs?.length) continue;

      const payload = JSON.stringify({
        title: PUSH_TITLE,
        body: actionable.map((i) => `${i.title} · ${i.detail}`).join("\n"),
        url: "./", tag: "daily-digest",
      });
      for (const s of subs) {
        try {
          const r = await sendPush(vapid, s.subscription, payload);
          if (r.ok) { pushed++; continue; }
          failed++;
          // 404/410 = 사라진 구독 → 정리. 그 외는 원인을 남긴다.
          if (r.status === 404 || r.status === 410) await admin.from("push_subscriptions").delete().eq("id", s.id);
          else if (errors.length < 5) errors.push(`${r.status} ${r.detail}`);
        } catch (e) {
          failed++;
          if (errors.length < 5) errors.push(String((e as Error)?.message || e));
        }
      }
    }
    // 실패를 조용히 삼키지 않는다 — 응답에 그대로 담아 두면 원인을 바로 알 수 있다
    return json({ ok: true, users: (rows || []).length, updated, pushed, failed, vapidError, errors });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
