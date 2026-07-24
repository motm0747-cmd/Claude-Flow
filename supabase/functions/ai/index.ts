// ══════════════════════════════════════════════════════════════════════
// Claude Flow — 서버 AI (Supabase Edge Function)
//
// 목적: AI 키를 브라우저에 노출하지 않고 서버에만 두기. 로그인한 사용자만
//       호출할 수 있고(로그인 JWT는 supabase-js 가 자동 첨부, Supabase가 검증),
//       서버 시크릿 GEMINI_API_KEY 로 Gemini 를 호출해 텍스트를 돌려준다.
//
// 배포(대시보드): Edge Functions → 새 함수 'ai' 생성 → 이 코드 붙여넣기 → Deploy
// 시크릿 설정:   Edge Functions → Secrets 에 GEMINI_API_KEY = 당신의 Gemini 키
//                (선택) AI_MODEL 로 모델 변경 가능 (기본 gemini-2.5-flash)
// ⚠️ verify_jwt 는 켠 채로 두세요(기본값). 그래야 로그인한 사람만 쓸 수 있어요.
// ══════════════════════════════════════════════════════════════════════

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST 만 지원해요" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const prompt = body?.prompt;
    if (!prompt || typeof prompt !== "string") return json({ error: "prompt 이 필요해요" }, 400);
    if (prompt.length > 12000) return json({ error: "prompt 이 너무 길어요" }, 400);

    const key = Deno.env.get("GEMINI_API_KEY");
    if (!key) return json({ error: "서버에 AI 키(GEMINI_API_KEY)가 설정되지 않았어요" }, 500);
    const model = Deno.env.get("AI_MODEL") || "gemini-2.5-flash";

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      },
    );

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = data?.error?.message || `AI 오류 ${r.status}`;
      return json({ error: msg }, r.status === 429 ? 429 : 502);
    }

    const text: string = (data?.candidates?.[0]?.content?.parts || [])
      .map((p: { text?: string }) => p?.text || "")
      .join("");
    return json({ text });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
