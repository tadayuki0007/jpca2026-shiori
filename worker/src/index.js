// Gemini API プロキシ (キャッシュ + ソフトレート制限つき)
// 秘密の GEMINI_KEY は Workers Secrets に保存。フロントには出さない。
// 予稿集由来のセッション書誌データは PRIVATE_KB として Worker 側に保持し、
// クライアントの公開ソースには含めない。Gemini 呼び出し時に systemText 末尾へ注入。
import { PRIVATE_KB } from "./kb_private.js";

const ALLOW_ORIGINS = new Set([
  "https://jpca2026-shiori.pages.dev",
  "https://tadayuki0007.github.io",
  "http://localhost:8000",
  "null", // file:// で開いたとき
]);

const MAX_INPUT_CHARS = 4000;   // userText の最大長 (トークン暴走防止)
const RATE_WINDOW_SEC = 60;     // レート制限の窓
const RATE_MAX = 12;            // 1IPあたり 60秒で最大12リクエスト
const CACHE_TTL_SEC = 3600;     // 同一質問キャッシュ 1時間

const corsHeaders = (origin) => ({
  "Access-Control-Allow-Origin": ALLOW_ORIGINS.has(origin) ? origin : "https://jpca2026-shiori.pages.dev",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
});

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env, ctx) {
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

    let { userText, systemText, model } = body || {};
    if (!userText) return json({ error: "userText is required" }, 400, origin);
    if (typeof userText !== "string") return json({ error: "bad userText" }, 400, origin);
    if (userText.length > MAX_INPUT_CHARS) userText = userText.slice(0, MAX_INPUT_CHARS);

    const apiKey = env.GEMINI_KEY;
    if (!apiKey) return json({ error: "server misconfigured: missing GEMINI_KEY" }, 500, origin);

    const m = model || "gemini-2.5-flash";
    const cache = caches.default;

    // ---- 1) ソフトレート制限 (IP + 時間窓バケツ) ----
    const ip = request.headers.get("cf-connecting-ip") || "anon";
    const bucket = Math.floor(Date.now() / 1000 / RATE_WINDOW_SEC);
    const rlKey = new Request(`https://rl.local/${await sha256(ip + ":" + bucket)}`);
    let count = 0;
    const rlHit = await cache.match(rlKey);
    if (rlHit) { try { count = parseInt(await rlHit.text()) || 0; } catch {} }
    if (count >= RATE_MAX) {
      return json({ error: "リクエストが多すぎます。少し時間をおいて再度お試しください。" }, 429, origin);
    }
    ctx.waitUntil(cache.put(rlKey, new Response(String(count + 1), {
      headers: { "Cache-Control": `max-age=${RATE_WINDOW_SEC}` },
    })));

    // ---- 2) 同一質問キャッシュ ----
    const cacheKey = new Request(`https://cache.local/ai/${await sha256(m + "|" + (systemText || "") + "|" + userText)}`);
    const cached = await cache.match(cacheKey);
    if (cached) {
      const t = await cached.text();
      return json({ text: t, cached: true }, 200, origin);
    }

    // ---- 3) Gemini 呼び出し (429/5xx は指数バックオフでリトライ) ----
    // クライアント側 systemText 上限を 200KB に拡張
    if (typeof systemText === "string" && systemText.length > 200000) {
      systemText = systemText.slice(0, 200000);
    }
    // 予稿集ベースの私的知識ベースを末尾に結合 (公開ソースには含めない)
    if (PRIVATE_KB) {
      const sep = "\n\n========【予稿集ベース・全セッション詳細 (内部リファレンス)】========\n";
      systemText = (systemText || "") + sep + PRIVATE_KB;
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
    const payload = {
      contents: [{ parts: [{ text: userText }] }],
      // 高速化設定
      generationConfig: {
        // Gemini 2.5 の思考モードを無効化 (シンプルな質問応答用途、思考の隠れトークンによる遅延を排除)
        thinkingConfig: { thinkingBudget: 0 },
        // 出力トークン上限 (長文応答による待ち時間を抑制)
        maxOutputTokens: 1024,
        // 適度な創造性
        temperature: 0.7,
        topP: 0.95,
      },
    };
    if (systemText) payload.systemInstruction = { parts: [{ text: systemText }] };
    const bodyStr = JSON.stringify(payload);

    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const delays = [0, 800, 2000]; // 最大3回試行 (合計遅延を抑える)
    let lastErr = "";

    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt]) await sleep(delays[attempt]);
      let r;
      try {
        r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: bodyStr,
        });
      } catch (e) {
        lastErr = "network: " + e.message;
        continue; // ネットワーク系はリトライ
      }

      // レスポンスを安全にパース (たまにHTMLが返る)
      let data = null;
      const raw = await r.text();
      try { data = JSON.parse(raw); } catch { data = null; }

      if (r.ok) {
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text && text.trim()) {
          ctx.waitUntil(cache.put(cacheKey, new Response(text, {
            headers: { "Cache-Control": `max-age=${CACHE_TTL_SEC}` },
          })));
          return json({ text }, 200, origin);
        }
        // 空応答 (安全フィルタ等) → 1回だけリトライ価値あり
        lastErr = "empty";
        continue;
      }

      // 429 / 500 / 503 はリトライ対象、それ以外は即返す
      if (r.status === 429 || r.status === 500 || r.status === 503) {
        lastErr = `upstream ${r.status}`;
        continue;
      }
      const msg = data?.error?.message || `upstream ${r.status}`;
      return json({ error: msg }, r.status, origin);
    }

    // 全リトライ失敗
    return json({
      error: "ただいまアクセスが集中しています。数秒おいて、もう一度お試しください。",
      detail: lastErr,
    }, 429, origin);
  },
};

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}
