// Gemini API プロキシ (Context Caching + ストリーミング対応)
// 秘密の GEMINI_KEY は Workers Secrets に保存。フロントには出さない。
// 静的な systemPrompt 部分を Gemini Context Cache に保存し、毎回の入力トークンを削減 (~75%減)。
// ストリーミング有効時は SSE で逐次返却し、体感速度を向上。
import { PRIVATE_KB } from "./kb_private.js";
import { STATIC_SYSTEM_PROMPT } from "./kb_full.js";

const ALLOW_ORIGINS = new Set([
  "https://jpca2026-shiori.pages.dev",
  "https://tadayuki0007.github.io",
  "http://localhost:8000",
  "null", // file:// で開いたとき
]);

const MAX_INPUT_CHARS = 4000;    // userText の最大長 (トークン暴走防止)
const RATE_WINDOW_SEC = 60;      // レート制限の窓
const RATE_MAX = 12;             // 1IPあたり 60秒で最大12リクエスト
const CACHE_TTL_SEC = 3600;      // 同一質問キャッシュ 1時間
const CTX_CACHE_TTL_SEC = 3300;  // Gemini Context Cache の TTL (55分)
const CTX_CACHE_REFRESH_BEFORE = 300; // 残り5分を切ったら再生成
const MODEL = "gemini-2.5-flash";

const FULL_SYSTEM = STATIC_SYSTEM_PROMPT +
  "\n\n========【予稿集ベース・全セッション詳細 (内部リファレンス)】========\n" +
  (PRIVATE_KB || "");

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

// ---- Gemini Context Cache 管理 ----
// caches.default に { name, expiresAtMs } を JSON で保存。
// プロンプト改訂時はバージョンを上げる (=既存 caches.default エントリを破棄して再生成)
const CTX_CACHE_KEY = "https://ctxcache.local/v3-name-strict";

async function getOrCreateContextCache(apiKey, ctx) {
  const cache = caches.default;
  const hit = await cache.match(CTX_CACHE_KEY);
  if (hit) {
    try {
      const data = JSON.parse(await hit.text());
      const remaining = (data.expiresAtMs - Date.now()) / 1000;
      if (data.name && remaining > CTX_CACHE_REFRESH_BEFORE) {
        return data.name; // 有効期限まで余裕あり
      }
    } catch {}
  }
  // 新規作成
  const url = `https://generativelanguage.googleapis.com/v1beta/cachedContents?key=${apiKey}`;
  const body = JSON.stringify({
    model: `models/${MODEL}`,
    systemInstruction: { parts: [{ text: FULL_SYSTEM }] },
    ttl: `${CTX_CACHE_TTL_SEC}s`,
  });
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!r.ok) {
    // キャッシュ作成失敗 (例: トークン下限未満等) → null を返してインライン送信に fallback
    const txt = await r.text().catch(() => "");
    console.log("ctxCache create failed:", r.status, txt.slice(0, 200));
    return null;
  }
  const data = await r.json();
  const name = data?.name; // "cachedContents/abc"
  if (!name) return null;
  const expiresAtMs = Date.now() + CTX_CACHE_TTL_SEC * 1000;
  ctx.waitUntil(cache.put(CTX_CACHE_KEY, new Response(JSON.stringify({ name, expiresAtMs }), {
    headers: { "Cache-Control": `max-age=${CTX_CACHE_TTL_SEC - CTX_CACHE_REFRESH_BEFORE}` },
  })));
  return name;
}

function buildPayload(userText, cachedName) {
  const payload = {
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: {
      thinkingConfig: { thinkingBudget: 0 },
      maxOutputTokens: 1024,
      temperature: 0.7,
      topP: 0.95,
    },
  };
  if (cachedName) {
    payload.cachedContent = cachedName;
  } else {
    payload.systemInstruction = { parts: [{ text: FULL_SYSTEM }] };
  }
  return payload;
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

    let { userText, stream } = body || {};
    if (!userText) return json({ error: "userText is required" }, 400, origin);
    if (typeof userText !== "string") return json({ error: "bad userText" }, 400, origin);
    if (userText.length > MAX_INPUT_CHARS) userText = userText.slice(0, MAX_INPUT_CHARS);

    const apiKey = env.GEMINI_KEY;
    if (!apiKey) return json({ error: "server misconfigured: missing GEMINI_KEY" }, 500, origin);

    const cache = caches.default;

    // ---- 1) ソフトレート制限 ----
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

    // ---- 2) 同一質問キャッシュ (非ストリーミング時のみ有効) ----
    const cacheKey = new Request(`https://cache.local/ai/v2/${await sha256(MODEL + "|" + userText)}`);
    if (!stream) {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const t = await cached.text();
        return json({ text: t, cached: true }, 200, origin);
      }
    }

    // ---- 3) Gemini Context Cache を確保 ----
    const cachedName = await getOrCreateContextCache(apiKey, ctx);

    // ---- 4) ストリーミング呼び出し ----
    if (stream) {
      return await callGeminiStreaming(apiKey, userText, cachedName, origin, ctx, cacheKey);
    }

    // ---- 5) 非ストリーミング (互換用) ----
    return await callGeminiNonStream(apiKey, userText, cachedName, origin, ctx, cacheKey);
  },
};

async function callGeminiNonStream(apiKey, userText, cachedName, origin, ctx, cacheKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
  const payload = buildPayload(userText, cachedName);
  const bodyStr = JSON.stringify(payload);

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const delays = [0, 800, 2000];
  let lastErr = "";

  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt]) await sleep(delays[attempt]);
    let r;
    try {
      r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: bodyStr });
    } catch (e) { lastErr = "network: " + e.message; continue; }

    let data = null;
    const raw = await r.text();
    try { data = JSON.parse(raw); } catch {}

    if (r.ok) {
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text && text.trim()) {
        ctx.waitUntil(caches.default.put(cacheKey, new Response(text, {
          headers: { "Cache-Control": `max-age=${CACHE_TTL_SEC}` },
        })));
        return json({ text }, 200, origin);
      }
      lastErr = "empty"; continue;
    }
    if (r.status === 429 || r.status === 500 || r.status === 503) {
      lastErr = `upstream ${r.status}`; continue;
    }
    const msg = data?.error?.message || `upstream ${r.status}`;
    return json({ error: msg }, r.status, origin);
  }
  return json({ error: "ただいまアクセスが集中しています。数秒おいて、もう一度お試しください。", detail: lastErr }, 429, origin);
}

async function callGeminiStreaming(apiKey, userText, cachedName, origin, ctx, cacheKey) {
  // Gemini の streamGenerateContent は SSE 形式 (alt=sse) または NDJSON 形式を返す。
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse&key=${apiKey}`;
  const payload = buildPayload(userText, cachedName);
  console.log("[stream] start, cachedName=", cachedName ? cachedName.slice(0,30)+"…" : "(none)");
  let upstream;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.log("[stream] fetch failed:", e.message);
    return json({ error: "ネットワークエラー: " + e.message }, 502, origin);
  }

  console.log("[stream] upstream status=", upstream.status, "body?", !!upstream.body);
  if (!upstream.ok || !upstream.body) {
    const raw = await upstream.text().catch(() => "");
    console.log("[stream] upstream error body:", raw.slice(0, 300));
    let msg = `upstream ${upstream.status}`;
    try { msg = JSON.parse(raw)?.error?.message || msg; } catch {}
    return json({ error: msg }, upstream.status || 502, origin);
  }

  // SSE を読み取り、テキストデルタだけ抽出して text/event-stream として中継。
  // 完了時に全文をレスポンスキャッシュに保存。
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  // ctx.waitUntil で囲わないと、Workers ランタイムがレスポンス返却後すぐに
  // 背景 async タスクを停止することがある。stream の readable と writable は
  // 同一 isolate 上だが、念のため waitUntil で生存を保証する。
  ctx.waitUntil((async () => {
    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let full = "";
    let chunks = 0;
    let iter = 0;
    // 1行に1つの "data: {...}" が来る (Gemini の SSE)。
    // CRLF/LF を正規化し、改行ごとに処理する。
    const processLine = async (line) => {
      line = line.trim();
      if (!line.startsWith("data:")) return;
      const json5 = line.slice(5).trim();
      if (!json5 || json5 === "[DONE]") return;
      try {
        const obj = JSON.parse(json5);
        const piece = obj?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (piece) {
          full += piece;
          chunks++;
          await writer.write(enc.encode("data: " + JSON.stringify({ delta: piece }) + "\n\n"));
        }
        const fin = obj?.candidates?.[0]?.finishReason;
        if (fin) {
          await writer.write(enc.encode("data: " + JSON.stringify({ done: true, finishReason: fin }) + "\n\n"));
        }
      } catch (parseErr) {
        // JSON が分割されて到達した場合、後で再合流するので static buffer に戻す必要があるが、
        // ここでは「行末まで来たがJSON不完全」のケースのみ buf に書き戻す
        throw parseErr;
      }
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        iter++;
        if (done) { console.log("[stream] reader done at iter=", iter); break; }
        const piece = dec.decode(value, { stream: true });
        buf += piece.replace(/\r\n/g, "\n");
        // 改行で行ごとに切り出す。最後の不完全な行は buf に残す。
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          const remaining = buf.slice(nl + 1);
          if (line.trim() === "") { buf = remaining; continue; } // 空行
          if (!line.startsWith("data:")) { buf = remaining; continue; }
          // data: で始まる行は JSON を抽出してパースを試みる。失敗したら buf に書き戻して次の chunk を待つ。
          const json5 = line.slice(5).trim();
          try {
            JSON.parse(json5);
          } catch {
            // まだ未完成。buf を消費しないで次の read を待つ
            break;
          }
          try { await processLine(line); } catch {}
          buf = remaining;
        }
      }
      // ループ終了後、bufに残った最後のdata行があれば処理
      if (buf.trim()) {
        try { await processLine(buf); } catch {}
      }
    } catch (e) {
      console.log("[stream] reader error:", e.message);
      try { await writer.write(enc.encode("data: " + JSON.stringify({ error: String(e) }) + "\n\n")); } catch {}
    } finally {
      console.log("[stream] end, chunks=", chunks, "len=", full.length);
      try { await writer.write(enc.encode("data: [DONE]\n\n")); } catch {}
      try { await writer.close(); } catch {}
      if (full && full.trim()) {
        ctx.waitUntil(caches.default.put(cacheKey, new Response(full, {
          headers: { "Cache-Control": `max-age=${CACHE_TTL_SEC}` },
        })));
      }
    }
  })());

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders(origin),
    },
  });
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}
