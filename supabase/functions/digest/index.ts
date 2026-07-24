// ══════════════════════════════════════════════════════════════════════
// Claude Flow — 서버 자동화: 오늘의 리마인더 생성 (Supabase Edge Function)
//
// 매일 스케줄로 실행되어(사용자 접속과 무관), 각 사용자의 flow_state 를 훑어
// 간단하고 정확한 리마인더를 계산해 daily_digest 테이블에 저장한다.
// 앱은 이 값을 열 때 읽어 '오늘의 리마인더' 카드로 보여주고,
// 다음 단계(푸시 알림)의 발송 재료가 된다.
//
// 스케줄러(cron)가 service_role 로 호출한다. verify_jwt 는 켠 채로 두면 되고,
// cron 은 service_role 키를 Bearer 로 보내므로 통과한다.
// ══════════════════════════════════════════════════════════════════════
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });

// ── 유틸 ──
const won = (n: number) => Math.round(n || 0).toLocaleString("ko-KR") + "원";
function kstToday(): string {
  // Asia/Seoul 기준 YYYY-MM-DD (en-CA 로케일이 YYYY-MM-DD 형식)
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
  const today = kstToday();                 // '2026-07-24'
  const Y = +today.slice(0, 4), M = +today.slice(5, 7), D = +today.slice(8, 10);
  const tx: any[] = Array.isArray(data?.tx) ? data.tx : [];
  const fixed: any[] = Array.isArray(data?.fixed) ? data.fixed : [];
  const items: Item[] = [];

  // 1) 최근 7일 지출 요약(정보성)
  const wa = new Date(Date.UTC(Y, M - 1, D)); wa.setUTCDate(wa.getUTCDate() - 6);
  const waStr = wa.toISOString().slice(0, 10);
  let wExp = 0;
  for (const t of tx) if (t?.type === "expense" && t.date >= waStr && t.date <= today) wExp += (+t.amount || 0);
  items.push({ emo: "📊", title: "최근 7일 지출", detail: won(wExp), kind: "week" });

  // 2) 다가오는 고정비(오늘~+3일)
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

  // 3) 오래 미기록(3일 이상)
  let last = "";
  for (const t of tx) if (t?.date && t.date > last) last = t.date;
  if (last) {
    const gap = daysBetween(last, today);
    if (gap >= 3) items.push({ emo: "✍️", title: "기록이 뜸해요", detail: `${gap}일째 새 내역이 없어요`, kind: "inactive" });
  }

  return { date: today, items, computedAt: new Date().toISOString() };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !serviceKey) return json({ error: "server env missing" }, 500);

    // service_role 로 전체 사용자 데이터 읽기/쓰기 (RLS 우회)
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    const { data: rows, error } = await admin.from("flow_state").select("user_id,data");
    if (error) throw error;

    let n = 0;
    for (const row of rows || []) {
      const digest = computeDigest(row.data);
      const { error: upErr } = await admin.from("daily_digest").upsert(
        { user_id: row.user_id, digest, computed_at: new Date().toISOString() },
        { onConflict: "user_id" },
      );
      if (!upErr) n++;
    }
    return json({ ok: true, users: (rows || []).length, updated: n });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
