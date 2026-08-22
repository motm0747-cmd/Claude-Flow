// ══════════════════════════════════════════════════════════════════════
// Claude Flow — 문자 수신함 (SMS ingest)
//
// 폰의 자동화(iOS 단축어 / 안드로이드 MacroDroid)가 카드 결제 문자를
// 이 주소로 그대로 보내면, 원문만 sms_inbox 테이블에 쌓아둔다.
//
// ⚠️ 이 함수는 문자를 '해석하지 않는다'.
//    해석과 기록은 앱(브라우저)이 smsparse.js 로 직접 한다. 서버가 가계부에
//    직접 써 넣으면 기기에서 편집 중인 내용과 충돌할 수 있기 때문이다.
//    서버는 '우체통', 앱이 '읽는 사람'.
//
// 배포:
//   Edge Functions → 새 함수 'sms' → 이 코드 붙여넣기 → Deploy
//   시크릿 설정 필요 없음 (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 는 자동 제공)
//
// ⚠️ verify_jwt 는 켠 채로 두세요(기본값).
//    폰의 자동화는 Authorization 헤더에 anon key 를 담아 보내고,
//    '누구의 가계부인가'는 본문의 token(사용자별 수신 토큰)으로 판별합니다.
//    앱 설정 화면이 이 두 값을 그대로 복사해 줍니다.
// ══════════════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });

const MAX_TEXT = 1200;      // 카드 문자는 길어야 수백 자
const MAX_PENDING = 500;    // 앱을 오래 안 열어도 무한정 쌓이지 않게

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 본문을 JSON 으로도, 순수 텍스트로도 받을 수 있게 한다.
 *  (단축어에서 JSON 을 만드는 것보다 텍스트 한 덩어리를 보내는 게 훨씬 쉽다) */
async function readInput(req: Request): Promise<{ token: string; text: string; sender: string; receivedAt: string }> {
  const url = new URL(req.url);
  let token = (url.searchParams.get("t") || url.searchParams.get("token") || "").trim();
  let text = "", sender = "", receivedAt = "";

  const ctype = (req.headers.get("content-type") || "").toLowerCase();
  const bodyRaw = await req.text();

  if (ctype.includes("application/json")) {
    try {
      const b = JSON.parse(bodyRaw || "{}");
      token = String(b.token || b.t || token || "").trim();
      text = String(b.text ?? b.message ?? b.body ?? b.sms ?? "");
      sender = String(b.sender ?? b.from ?? "");
      receivedAt = String(b.receivedAt ?? b.at ?? "");
    } catch {
      text = bodyRaw;                       // JSON 이라 했지만 아니면 텍스트로 취급
    }
  } else if (ctype.includes("application/x-www-form-urlencoded")) {
    const p = new URLSearchParams(bodyRaw);
    token = (p.get("token") || p.get("t") || token || "").trim();
    text = p.get("text") || p.get("message") || p.get("body") || "";
    sender = p.get("sender") || p.get("from") || "";
  } else {
    text = bodyRaw;                         // text/plain — 문자 원문 그대로
  }
  return { token, text, sender, receivedAt };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST 로 보내주세요" }, 405);

  try {
    const { token, text, sender, receivedAt } = await readInput(req);

    if (!token || token.length < 20 || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) {
      return json({ error: "수신 토큰이 없거나 형식이 올바르지 않아요" }, 400);
    }
    const body = String(text || "").trim();
    if (!body) return json({ error: "문자 내용이 비어 있어요" }, 400);
    if (body.length > MAX_TEXT) return json({ error: "문자가 너무 길어요" }, 400);

    const url = Deno.env.get("SUPABASE_URL") || "";
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!url || !key) return json({ error: "서버 설정이 완료되지 않았어요" }, 500);
    const db = createClient(url, key, { auth: { persistSession: false } });

    // 토큰 → 사용자
    const owner = await db.from("sms_tokens").select("user_id").eq("token", token).maybeSingle();
    if (owner.error) return json({ error: "수신함을 확인하지 못했어요" }, 500);
    if (!owner.data) return json({ error: "알 수 없는 수신 토큰이에요 (앱에서 다시 발급해 주세요)" }, 401);
    const userId = owner.data.user_id as string;

    // 쌓임 방지
    const cnt = await db.from("sms_inbox").select("id", { count: "exact", head: true }).eq("user_id", userId);
    if ((cnt.count || 0) >= MAX_PENDING) {
      return json({ error: "수신함이 가득 찼어요. 앱을 열어 처리해 주세요" }, 429);
    }

    // 같은 문자가 두 번 와도 한 건만 (unique(user_id, hash))
    const hash = await sha256(body);
    const at = receivedAt && !isNaN(Date.parse(receivedAt)) ? new Date(receivedAt).toISOString() : new Date().toISOString();

    const ins = await db.from("sms_inbox")
      .insert({ user_id: userId, raw: body, sender: String(sender || "").slice(0, 60), hash, received_at: at })
      .select("id");

    if (ins.error) {
      // 23505 = unique 위반 → 이미 받은 문자. 정상 응답으로 돌려준다.
      if ((ins.error as { code?: string }).code === "23505") return json({ ok: true, stored: false, duplicate: true });
      return json({ error: "저장하지 못했어요" }, 500);
    }
    return json({ ok: true, stored: true });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
