// ══════════════════════════════════════════════════════════════════════
// Claude Flow — 증권사 연동 프록시 (토스증권 Open API)
//
// 왜 서버를 거치나:
//  1) 증권사 API는 브라우저(CORS)에서 직접 호출할 수 없다.
//  2) API 키/시크릿이 브라우저에 노출되면 안 된다. 토스 키에는 주문 권한도
//     딸려오므로 유출 시 실제 매매가 가능하다.
//
// ⚠️ 설계 원칙: 조회 전용(read-only).
//    주문 생성/정정/취소 엔드포인트는 이 파일에 의도적으로 구현하지 않는다.
//    가계부에 매매 기능은 필요 없고, 사고 위험만 키운다.
//
// 배포:
//   Edge Functions → 새 함수 'broker' → 이 코드 붙여넣기 → Deploy
// 시크릿(Edge Functions → Secrets):
//   TOSS_API_KEY     = 토스증권에서 발급받은 client id
//   TOSS_SECRET_KEY  = 토스증권에서 발급받은 client secret
//   (선택) TOSS_ACCOUNT_SEQ = 기본으로 쓸 계좌 seq
// ⚠️ verify_jwt 는 켠 채로 두세요(기본값). 로그인한 사람만 호출할 수 있어야 합니다.
// ══════════════════════════════════════════════════════════════════════

const TOSS_BASE = "https://openapi.tossinvest.com";

// ── 소유자 전용 게이트 ──────────────────────────────────────────────
// 이 함수는 서버에 등록된 '소유자의' 증권 계좌를 조회한다. 앱을 여러 사람에게
// 배포하면 다른 사용자도 로그인만 하면 호출할 수 있으므로, 반드시 허용된
// 계정인지 서버에서 확인한다. (화면에서 버튼을 숨기는 것만으로는 못 막는다)
//
// 시크릿: BROKER_ALLOWED_EMAILS = 쉼표로 구분한 허용 이메일 목록
//         예) me@example.com,other@example.com
// 설정하지 않으면 아무도 사용할 수 없다(안전 우선).
function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const p = token.split(".")[1];
    if (!p) return {};
    const b64 = p.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(atob(pad));
  } catch { return {}; }
}
function checkOwner(req: Request): { ok: boolean; reason?: string; email?: string } {
  const allowRaw = (Deno.env.get("BROKER_ALLOWED_EMAILS") || "").trim();
  if (!allowRaw) {
    return { ok: false, reason: "증권사 연동이 이 서버에서 활성화되지 않았어요. (관리자만 사용할 수 있어요)" };
  }
  const allow = allowRaw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const auth = req.headers.get("authorization") || "";
  const payload = decodeJwtPayload(auth.replace(/^Bearer\s+/i, ""));
  const email = String(payload.email || "").toLowerCase();
  if (!email) return { ok: false, reason: "로그인이 필요해요" };
  if (!allow.includes(email)) {
    return { ok: false, reason: "이 계정은 증권사 연동을 사용할 수 없어요. (소유자 전용 기능)", email };
  }
  return { ok: true, email };
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });

// ── 액세스 토큰 캐시 (함수 인스턴스가 살아있는 동안 재사용해 호출 수를 아낀다) ──
let tokenCache: { token: string; exp: number } | null = null;

async function getToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.exp > now + 30_000) return tokenCache.token;

  const id = Deno.env.get("TOSS_API_KEY");
  const secret = Deno.env.get("TOSS_SECRET_KEY");
  if (!id || !secret) throw new Error("서버에 토스 API 키(TOSS_API_KEY / TOSS_SECRET_KEY)가 설정되지 않았어요");

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: id,
    client_secret: secret,
  });
  const r = await fetch(`${TOSS_BASE}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j?.access_token) {
    throw new Error(j?.error_description || j?.message || `토큰 발급 실패 (${r.status})`);
  }
  const ttl = (Number(j.expires_in) || 1800) * 1000;
  tokenCache = { token: j.access_token, exp: now + ttl };
  return j.access_token;
}

async function tossGet(path: string, params: Record<string, string> = {}, accountSeq?: number) {
  const token = await getToken();
  const qs = new URLSearchParams(params).toString();
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (accountSeq !== undefined) headers["X-Tossinvest-Account"] = String(accountSeq);

  const r = await fetch(`${TOSS_BASE}${path}${qs ? "?" + qs : ""}`, { headers });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const retry = r.headers.get("Retry-After");
    const msg = j?.error?.message || j?.message || `토스 API 오류 (${r.status})`;
    throw Object.assign(new Error(msg), { status: r.status, retryAfter: retry });
  }
  return j?.result ?? j;
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST 만 지원해요" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "");

    // 소유자 확인 — 모든 action 보다 먼저
    const gate = checkOwner(req);
    if (action === "status") return json({ allowed: gate.ok });   // 앱이 버튼 표시 여부를 묻는 용도
    if (!gate.ok) return json({ error: gate.reason }, 403);
    const envSeq = Deno.env.get("TOSS_ACCOUNT_SEQ");
    const accountSeq = body?.accountSeq !== undefined && body?.accountSeq !== null
      ? Number(body.accountSeq)
      : (envSeq ? Number(envSeq) : undefined);

    // ── 계좌 목록 ──
    if (action === "accounts") {
      const list = await tossGet("/api/v1/accounts");
      return json({ accounts: list });
    }

    // ── 미국주식 요약 + 보유 종목 (Claude Flow 연동의 핵심) ──
    if (action === "us-summary" || action === "holdings") {
      if (accountSeq === undefined || Number.isNaN(accountSeq)) {
        return json({ error: "accountSeq 가 필요해요. 먼저 계좌를 선택해주세요." }, 400);
      }
      const h = await tossGet("/api/v1/holdings", {}, accountSeq);

      const items = Array.isArray(h?.items) ? h.items : [];
      const us = items.filter((x: any) => x?.currency === "USD" || x?.marketCountry === "US");

      // 예수금(USD)은 실패해도 전체를 막지 않는다
      let cashUsd = 0;
      try {
        const bp = await tossGet("/api/v1/buying-power", { currency: "USD" }, accountSeq);
        cashUsd = num(bp?.cashBuyingPower);
      } catch (_) { /* 조회 실패 시 0 */ }

      const marketValueUsd = num(h?.marketValue?.amount?.usd);
      const purchaseUsd = num(h?.totalPurchaseAmount?.usd);

      return json({
        currency: "USD",
        // 투자 계좌 '현재 평가금액'에 그대로 넣을 값 = 주식 평가액 + 달러 예수금
        totalUsd: Math.round((marketValueUsd + cashUsd) * 100) / 100,
        marketValueUsd,
        cashUsd,
        purchaseUsd,
        profitUsd: Math.round((marketValueUsd - purchaseUsd) * 100) / 100,
        holdings: us.map((x: any) => ({
          symbol: x.symbol,
          name: x.name,
          quantity: num(x.quantity),
          lastPrice: num(x.lastPrice),
          avgPrice: num(x.averagePurchasePrice),
          value: num(x?.marketValue?.amount),
          purchase: num(x?.marketValue?.purchaseAmount),
          profit: num(x?.profitLoss?.amount),
          profitRate: num(x?.profitLoss?.rate),
        })),
        fetchedAt: new Date().toISOString(),
      });
    }

    // ── 현재가 (선택) ──
    if (action === "prices") {
      const symbols = String(body?.symbols || "").trim();
      if (!symbols) return json({ error: "symbols 가 필요해요" }, 400);
      const p = await tossGet("/api/v1/prices", { symbols });
      return json({ prices: p });
    }

    return json({ error: `지원하지 않는 action: ${action || "(없음)"}` }, 400);
  } catch (e) {
    const err = e as { message?: string; status?: number; retryAfter?: string | null };
    const status = err.status === 429 ? 429 : 502;
    return json({ error: err.message || String(e), retryAfter: err.retryAfter ?? undefined }, status);
  }
});
