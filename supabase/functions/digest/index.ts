// ══════════════════════════════════════════════════════════════════════
// Claude Flow — 서버 자동화 + 푸시 (Supabase Edge Function)
//
// 매일 스케줄로 실행: 각 사용자의 flow_state 를 훑어 리마인더를 계산해
// daily_digest 에 저장하고, '결제 임박/미기록' 같은 실행형 리마인더가 있으면
// 그 사용자의 push_subscriptions 로 웹 푸시를 보낸다.
//
// 필요한 시크릿(선택 — 없으면 푸시는 건너뛰고 저장만):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT(mailto:you@example.com)
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 는 자동 제공됨.
// ══════════════════════════════════════════════════════════════════════
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

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

  return { date: today, items, computedAt: new Date().toISOString() };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok");
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !serviceKey) return json({ error: "server env missing" }, 500);
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    // VAPID 시크릿이 있으면 푸시 발송 활성화
    const vapPub = Deno.env.get("VAPID_PUBLIC_KEY");
    const vapPriv = Deno.env.get("VAPID_PRIVATE_KEY");
    const canPush = !!(vapPub && vapPriv);
    if (canPush) {
      webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") || "mailto:noreply@example.com", vapPub!, vapPriv!);
    }

    const { data: rows, error } = await admin.from("flow_state").select("user_id,data");
    if (error) throw error;

    let updated = 0, pushed = 0;
    for (const row of rows || []) {
      const digest = computeDigest(row.data);
      const { error: upErr } = await admin.from("daily_digest").upsert(
        { user_id: row.user_id, digest, computed_at: new Date().toISOString() },
        { onConflict: "user_id" },
      );
      if (!upErr) updated++;

      if (!canPush) continue;
      const actionable = digest.items.filter((i) => i.kind === "fixed" || i.kind === "inactive");
      if (!actionable.length) continue;

      const { data: subs } = await admin.from("push_subscriptions")
        .select("id,subscription").eq("user_id", row.user_id);
      if (!subs || !subs.length) continue;

      const body = actionable.map((i) => `${i.title} · ${i.detail}`).join("\n");
      const payload = JSON.stringify({ title: "🌅 오늘의 리마인더", body, url: "./", tag: "daily-digest" });
      for (const s of subs) {
        try {
          await webpush.sendNotification(s.subscription, payload);
          pushed++;
        } catch (err) {
          const code = (err as { statusCode?: number })?.statusCode;
          if (code === 404 || code === 410) await admin.from("push_subscriptions").delete().eq("id", s.id);
        }
      }
    }
    return json({ ok: true, users: (rows || []).length, updated, pushed });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
