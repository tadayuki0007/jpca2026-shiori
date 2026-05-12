// Gemini API プロキシ
// 公開URL: https://jpca2026-ai.<account>.workers.dev/
// 秘密の GEMINI_KEY を Workers Secrets に保存し、フロントには出さない。

const ALLOW_ORIGINS = new Set([
  "https://tadayuki0007.github.io",
  "http://localhost:8000",
  "null", // file:// で開いたとき
]);

const corsHeaders = (origin) => ({
  "Access-Control-Allow-Origin": ALLOW_ORIGINS.has(origin) ? origin : "https://tadayuki0007.github.io",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
});

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return new Response("Use POST", { status: 405, headers: corsHeaders(origin) });
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid json" }, 400, origin); }

    const { userText, systemText, model } = body || {};
    if (!userText) return json({ error: "userText is required" }, 400, origin);

    const apiKey = env.GEMINI_KEY;
    if (!apiKey) return json({ error: "server misconfigured: missing GEMINI_KEY" }, 500, origin);

    const m = model || "gemini-2.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
    const payload = { contents: [{ parts: [{ text: userText }] }] };
    if (systemText) payload.systemInstruction = { parts: [{ text: systemText }] };

    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      if (!r.ok) {
        return json({ error: data?.error?.message || `upstream ${r.status}` }, r.status, origin);
      }
      return json({ text }, 200, origin);
    } catch (e) {
      return json({ error: "fetch failed: " + e.message }, 502, origin);
    }
  },
};

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}
