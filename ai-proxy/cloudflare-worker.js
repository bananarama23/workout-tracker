import { handleTrackerRequest, handleTrackerScheduled, trackerHealth } from "./tracker-watch.js";

/*
 * PLUSULTRA lightweight AI proxy.
 *
 * Purpose:
 * - Keep Google Apps Script focused on Google Sheet reads/writes.
 * - Run OpenAI, Gemini, and Claude AI calls outside Apps Script timeout limits.
 * - Keep provider API keys on the server/edge, never in frontend HTML.
 *
 * Production security model:
 * - Put the app and this Worker behind Cloudflare Access.
 * - Set CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD so the Worker verifies Access JWTs.
 * - Store APPS_SCRIPT_URL + APPS_SCRIPT_TOKEN in Worker secrets; never in HTML.
 * - Set APP_CLIENT_TOKEN_REQUIRED=true and APP_CLIENT_TOKEN=<same token> in Apps Script.
 */

const OPENAI_BASE = "https://api.openai.com/v1";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const ANTHROPIC_BASE = "https://api.anthropic.com/v1";
const AI_PROXY_VERSION = "v1.7.0-secure-app-gateway";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const SCAN_PROMPT = 'This is a nutrition label or food packaging. Extract the nutrition information and return ONLY a JSON object with these exact keys (use null if not found): {"name":"food name","serving":number,"unit":"g or ml or oz or piece or scoop or serving","calories":number,"protein":number,"carbs":number,"fat":number,"fibre":number,"satFat":number,"sodium":number}. All numbers per serving. Sodium in mg. Return raw JSON only, no markdown.';
let ACCESS_JWKS_CACHE = { issuer: "", expiresAt: 0, keys: [] };

export default {
  async fetch(request, env) {
    const started = Date.now();
    const url = new URL(request.url);
    const routePath = normalizeRoutePath(url.pathname);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (routePath === "/health") {
        const origin = request.headers.get("Origin") || "";
        const allowed = allowedOrigins(env);
        return json({
          status: "ok",
          type: "health",
          version: AI_PROXY_VERSION,
          openaiConfigured: !!env.OPENAI_API_KEY,
          geminiConfigured: !!env.GEMINI_API_KEY,
          anthropicConfigured: !!env.ANTHROPIC_API_KEY,
          allowedOriginsConfigured: allowed.length > 0,
          requestOrigin: origin || "none",
          requestOriginAllowed: !origin || allowed.includes(origin) || (origin === "null" && allowed.includes("null")),
          tokenAuthEnabled: !!String(env.AI_PROXY_TOKEN || "").trim(),
          accessJwtAuthConfigured: accessAuthConfigured(env),
          authRequired: authRequired(env),
          maxRequestBytes: maxRequestBytes(env),
          appsScriptProxyConfigured: !!String(env.APPS_SCRIPT_URL || "").trim(),
          appsScriptTokenConfigured: !!String(env.APPS_SCRIPT_TOKEN || env.APP_CLIENT_TOKEN || "").trim(),
          appsScriptProxyRoutes: true,
          d1Configured: hasD1(env),
          trainerCacheRoutes: true,
          trainerBrainRoutes: true,
          nutritionCacheRoutes: true,
          ...trackerHealth(env),
          backgroundRoutes: true,
          providerRoutes: true,
          authCheckRoute: true,
          securityHeaders: true
        }, cors);
      }

      const auth = await checkRequestAuth(request, env);
      if (!auth.ok) {
        return json({ status: "error", errorCode: "unauthorized", message: auth.message }, cors, 401);
      }
      const origin = checkOriginAllowlist(request, env, auth);
      if (!origin.ok) {
        return json({ status: "error", errorCode: "origin_not_allowed", message: origin.message }, cors, 403);
      }
      const size = checkRequestSize(request, env);
      if (!size.ok) {
        return json({ status: "error", errorCode: "request_too_large", message: size.message, maxRequestBytes: size.maxRequestBytes }, cors, 413);
      }

      if (request.method === "POST" && routePath === "/v1/auth-check") {
        return json(withDuration({
          status: "ok",
          type: "auth-check",
          tokenAuthEnabled: !!String(env.AI_PROXY_TOKEN || "").trim(),
          accessJwtAuthConfigured: accessAuthConfigured(env),
          authMode: auth.mode || "unknown",
          originAllowed: true,
          maxRequestBytes: maxRequestBytes(env)
        }, started), cors);
      }

      if (request.method === "POST" && (routePath === "/v1/apps-script" || routePath === "/v1/sheets")) {
        const result = await handleAppsScriptProxy(request, env);
        return json(withDuration(result, started), cors);
      }

      if (request.method === "POST" && routePath === "/v1/trainer-cache/upsert") {
        const body = await request.json();
        const result = await handleTrainerCacheUpsert(body, env);
        return json(withDuration(result, started), cors);
      }

      if (request.method === "POST" && routePath === "/v1/trainer-cache/get") {
        const body = await request.json();
        const result = await handleTrainerCacheGet(body, env);
        return json(withDuration(result, started), cors);
      }

      if (request.method === "POST" && routePath === "/v1/trainer-brain/run") {
        const body = await request.json();
        const result = await handleTrainerBrainRun(body, env);
        return json(withDuration(result, started), cors);
      }

      if (request.method === "POST" && routePath === "/v1/nutrition-cache/get") {
        const body = await request.json();
        const result = await handleNutritionCacheGet(body, env);
        return json(withDuration(result, started), cors);
      }

      if (request.method === "POST" && routePath === "/v1/nutrition-cache/upsert") {
        const body = await request.json();
        const result = await handleNutritionCacheUpsert(body, env);
        return json(withDuration(result, started), cors);
      }

      if (routePath.startsWith("/tracker/") || routePath.startsWith("/v1/tracker/")) {
        const result = await handleTrackerRequest(request, env, {
          openaiJson,
          waitUntil(promise) {
            if (promise && typeof promise.then === "function") promise.catch(() => null);
          }
        });
        const status = result && result.status === "error" ? (result.httpStatus || 500) : 200;
        return json(withDuration(result, started), cors, status);
      }

      if (request.method === "POST" && routePath === "/v1/gemini-json") {
        if (!env.GEMINI_API_KEY) {
          return json(providerKeyMissing("gemini", "GEMINI_API_KEY"), cors, 500);
        }
        const body = await request.json();
        const result = await handleGeminiJson(body, env);
        return json(withDuration(result, started), cors);
      }

      if (request.method === "POST" && routePath === "/v1/gemini-vision-json") {
        if (!env.GEMINI_API_KEY) {
          return json(providerKeyMissing("gemini", "GEMINI_API_KEY"), cors, 500);
        }
        const body = await request.json();
        const result = await handleGeminiVisionJson(body, env);
        return json(withDuration(result, started), cors);
      }

      if (request.method === "POST" && routePath === "/v1/claude-json") {
        if (!env.ANTHROPIC_API_KEY) {
          return json(providerKeyMissing("claude", "ANTHROPIC_API_KEY"), cors, 500);
        }
        const body = await request.json();
        const result = await handleClaudeJson(body, env);
        return json(withDuration(result, started), cors);
      }

      if (request.method === "POST" && routePath === "/v1/claude-vision-json") {
        if (!env.ANTHROPIC_API_KEY) {
          return json(providerKeyMissing("claude", "ANTHROPIC_API_KEY"), cors, 500);
        }
        const body = await request.json();
        const result = await handleClaudeVisionJson(body, env);
        return json(withDuration(result, started), cors);
      }

      if (request.method === "POST" && routePath === "/v1/claude-nutrition") {
        if (!env.ANTHROPIC_API_KEY) {
          return json(providerKeyMissing("claude", "ANTHROPIC_API_KEY"), cors, 500);
        }
        const body = await request.json();
        const result = await handleClaudeNutrition(body, env);
        return json(withDuration(result, started), cors);
      }

      if (request.method === "POST" && routePath === "/v1/claude-vision-nutrition") {
        if (!env.ANTHROPIC_API_KEY) {
          return json(providerKeyMissing("claude", "ANTHROPIC_API_KEY"), cors, 500);
        }
        const body = await request.json();
        const result = await handleClaudeVisionNutrition(body, env);
        return json(withDuration(result, started), cors);
      }

      if (request.method === "POST" && routePath === "/v1/scan-food") {
        const body = await request.json();
        const result = await handleScanFood(body, env);
        return json(withDuration(result, started), cors);
      }

      if (!env.OPENAI_API_KEY) {
        return json({ status: "error", errorCode: "openai_key_missing", message: "OPENAI_API_KEY missing" }, cors, 500);
      }

      if (request.method === "POST" && routePath === "/v1/chat-json") {
        const body = await request.json();
        const result = await handleChatJson(body, env, false);
        return json(withDuration(result, started), cors);
      }

      if (request.method === "POST" && routePath === "/v1/image-json") {
        const body = await request.json();
        const result = await handleImageJson(body, env);
        return json(withDuration(result, started), cors);
      }

      if (request.method === "POST" && routePath === "/v1/background/start") {
        const body = await request.json();
        const result = await handleChatJson(body, env, true);
        return json(withDuration(result, started), cors);
      }

      if (request.method === "POST" && routePath === "/v1/background/poll") {
        const body = await request.json();
        const responseId = String(body.responseId || body.id || "").trim();
        if (!responseId) {
          return json({ status: "error", errorCode: "missing_response_id", message: "Missing responseId" }, cors, 400);
        }
        const result = await openaiJson(`/responses/${encodeURIComponent(responseId)}`, {
          method: "GET"
        }, env);
        return json(withDuration(normalizeResponseResult(result), started), cors);
      }

      return json({ status: "error", errorCode: "not_found", message: "Unknown AI proxy route" }, cors, 404);
    } catch (err) {
      return json({
        status: "error",
        errorCode: String(err && err.errorCode || "ai_proxy_exception"),
        message: String(err && err.message || err || "AI proxy failed"),
        durationMs: Date.now() - started
      }, cors, err && err.httpStatus ? err.httpStatus : 500);
    }
  },

  async scheduled(event, env, ctx) {
    try {
      const job = handleTrackerScheduled(env, Object.assign({}, ctx || {}, { openaiJson }));
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(job);
      else await job;
    } catch (_) {}
  }
};

function corsHeaders(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin") || "";
  const allowed = allowedOrigins(env);
  const healthRoute = request.method === "GET" && normalizeRoutePath(url.pathname) === "/health";
  const allowOrigin = healthRoute || allowed.includes(origin) || (origin === "null" && allowed.includes("null"));
  return {
    "Access-Control-Allow-Origin": allowOrigin ? (origin || "*") : (allowed[0] || "null"),
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-WT-Client-Version, X-WT-Proxy-Token",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function normalizeRoutePath(pathname) {
  const path = String(pathname || "/");
  if (path === "/api") return "/";
  if (path.indexOf("/api/") === 0) return path.slice(4) || "/";
  return path;
}

async function checkRequestAuth(request, env) {
  const bearer = checkBearerToken(request, env);
  if (bearer.ok) return bearer;

  const access = await checkCloudflareAccessJwt(request, env);
  if (access.ok) return access;

  if (authRequired(env)) {
    return {
      ok: false,
      mode: "required",
      message: access.configured
        ? (access.message || "Cloudflare Access JWT required")
        : (bearer.configured ? bearer.message : "Worker auth required")
    };
  }

  if (bearer.configured) return { ok: false, mode: "bearer", message: bearer.message };
  if (access.configured) return { ok: false, mode: "access_jwt", message: access.message };
  return { ok: true, mode: "origin_allowlist_only" };
}

function checkBearerToken(request, env) {
  const expected = String(env.AI_PROXY_TOKEN || "").trim();
  if (!expected) return { ok: false, configured: false, mode: "bearer" };
  const auth = request.headers.get("Authorization") || "";
  const headerToken = request.headers.get("X-WT-Proxy-Token") || "";
  const actual = (headerToken || auth.replace(/^Bearer\s+/i, "")).trim();
  if (actual && actual === expected) return { ok: true, configured: true, mode: "bearer" };
  return { ok: false, configured: true, mode: "bearer", message: "Invalid or missing proxy bearer token" };
}

function authRequired(env) {
  return truthy(env.AUTH_REQUIRED || env.REQUIRE_AUTH || env.REQUIRE_WORKER_AUTH || env.REQUIRE_CLOUDFLARE_ACCESS);
}

function truthy(value) {
  return /^(1|true|yes|required|on)$/i.test(String(value || "").trim());
}

function accessAuthConfig(env) {
  const teamRaw = String(env.CF_ACCESS_TEAM_DOMAIN || env.CLOUDFLARE_ACCESS_TEAM_DOMAIN || "").trim();
  const aud = String(env.CF_ACCESS_AUD || env.CLOUDFLARE_ACCESS_AUD || "").trim();
  if (!teamRaw || !aud) return null;
  const team = teamRaw
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/g, "")
    .replace(/\.cloudflareaccess\.com$/i, "");
  if (!team) return null;
  return {
    issuer: `https://${team}.cloudflareaccess.com`,
    aud
  };
}

function accessAuthConfigured(env) {
  return !!accessAuthConfig(env);
}

async function checkCloudflareAccessJwt(request, env) {
  const cfg = accessAuthConfig(env);
  if (!cfg) return { ok: false, configured: false, mode: "access_jwt" };
  const token = accessTokenFromRequest(request);
  if (!token) return { ok: false, configured: true, mode: "access_jwt", message: "Cloudflare Access login required" };
  try {
    const verified = await verifyAccessJwt(token, cfg);
    if (verified.ok) return { ok: true, configured: true, mode: "access_jwt", email: verified.email || "" };
    return { ok: false, configured: true, mode: "access_jwt", message: verified.message || "Invalid Cloudflare Access token" };
  } catch (err) {
    return { ok: false, configured: true, mode: "access_jwt", message: String(err && err.message || err || "Access JWT validation failed") };
  }
}

function accessTokenFromRequest(request) {
  const header = String(request.headers.get("Cf-Access-Jwt-Assertion") || request.headers.get("cf-access-token") || "").trim();
  if (header) return header;
  const cookie = String(request.headers.get("Cookie") || "");
  const match = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

async function verifyAccessJwt(token, cfg) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return { ok: false, message: "Malformed Cloudflare Access token" };
  const header = parseJwtPart(parts[0]);
  const payload = parseJwtPart(parts[1]);
  if (!header || !payload) return { ok: false, message: "Unreadable Cloudflare Access token" };
  if (String(header.alg || "") !== "RS256") return { ok: false, message: "Unexpected Access token algorithm" };
  if (String(payload.iss || "") !== cfg.issuer) return { ok: false, message: "Access token issuer mismatch" };
  const aud = Array.isArray(payload.aud) ? payload.aud.map(String) : [String(payload.aud || "")];
  if (!aud.includes(cfg.aud)) return { ok: false, message: "Access token audience mismatch" };
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && Number(payload.exp) <= now) return { ok: false, message: "Cloudflare Access session expired" };
  if (payload.nbf && Number(payload.nbf) > now + 30) return { ok: false, message: "Cloudflare Access session not active yet" };

  const jwks = await getAccessJwks(cfg.issuer);
  const keyData = (jwks.keys || []).find(k => String(k.kid || "") === String(header.kid || ""));
  if (!keyData) return { ok: false, message: "Cloudflare Access signing key not found" };
  const key = await crypto.subtle.importKey(
    "jwk",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const valid = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    base64UrlToBytes(parts[2]),
    new TextEncoder().encode(parts[0] + "." + parts[1])
  );
  if (!valid) return { ok: false, message: "Cloudflare Access token signature invalid" };
  return { ok: true, email: payload.email || payload.common_name || "" };
}

async function getAccessJwks(issuer) {
  const now = Date.now();
  if (ACCESS_JWKS_CACHE.issuer === issuer && ACCESS_JWKS_CACHE.expiresAt > now && ACCESS_JWKS_CACHE.keys && ACCESS_JWKS_CACHE.keys.length) {
    return { keys: ACCESS_JWKS_CACHE.keys };
  }
  const resp = await fetch(issuer + "/cdn-cgi/access/certs", {
    headers: { "Accept": "application/json" },
    cf: { cacheTtl: 300, cacheEverything: true }
  });
  if (!resp.ok) throw new Error("Unable to load Cloudflare Access signing keys");
  const jwks = await resp.json();
  ACCESS_JWKS_CACHE = {
    issuer,
    expiresAt: now + 5 * 60 * 1000,
    keys: Array.isArray(jwks.keys) ? jwks.keys : []
  };
  return { keys: ACCESS_JWKS_CACHE.keys };
}

function parseJwtPart(part) {
  try {
    const text = new TextDecoder().decode(base64UrlToBytes(part));
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

function base64UrlToBytes(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function checkOriginAllowlist(request, env, auth) {
  if (String(env.AI_PROXY_TOKEN || "").trim()) return { ok: true };
  if (auth && (auth.mode === "access_jwt" || auth.mode === "bearer")) return { ok: true };
  const origin = request.headers.get("Origin") || "";
  try {
    if (origin && origin === new URL(request.url).origin) return { ok: true };
  } catch (_) {}
  const allowed = allowedOrigins(env);
  if (!allowed.length) {
    return {
      ok: false,
      message: "ALLOWED_ORIGINS must be set when AI_PROXY_TOKEN is not used"
    };
  }
  if (allowed.includes(origin) || (origin === "null" && allowed.includes("null"))) return { ok: true };
  return {
    ok: false,
    message: "Request origin is not allowed"
  };
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
}

function maxRequestBytes(env) {
  const configured = parseInt(String(env.MAX_REQUEST_BYTES || ""), 10);
  if (Number.isFinite(configured) && configured > 0) return Math.min(Math.max(configured, 1024 * 1024), 50 * 1024 * 1024);
  return 16 * 1024 * 1024;
}

function checkRequestSize(request, env) {
  if (request.method !== "POST") return { ok: true, maxRequestBytes: maxRequestBytes(env) };
  const max = maxRequestBytes(env);
  const raw = request.headers.get("Content-Length") || "";
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n > max) {
    return { ok: false, maxRequestBytes: max, message: `Request body is larger than ${max} bytes` };
  }
  return { ok: true, maxRequestBytes: max };
}

function securityHeaders() {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
  };
}

function json(obj, headers, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({}, securityHeaders(), headers || {}, { "Content-Type": "application/json; charset=utf-8" })
  });
}

function withDuration(obj, started) {
  return Object.assign({ durationMs: Date.now() - started }, obj || {});
}

function hasD1(env) {
  return !!(env && env.DB && typeof env.DB.prepare === "function");
}

async function handleAppsScriptProxy(request, env) {
  const target = String(env.APPS_SCRIPT_URL || "").trim();
  if (!target) {
    return {
      status: "error",
      type: "apps-script-proxy",
      errorCode: "apps_script_url_missing",
      message: "APPS_SCRIPT_URL is missing in Cloudflare Worker secrets"
    };
  }
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(?:[?#].*)?$/i.test(target)) {
    return {
      status: "error",
      type: "apps-script-proxy",
      errorCode: "apps_script_url_invalid",
      message: "APPS_SCRIPT_URL must be the Google Apps Script /exec URL"
    };
  }
  const scriptToken = String(env.APPS_SCRIPT_TOKEN || env.APP_CLIENT_TOKEN || "").trim();
  if (!scriptToken) {
    return {
      status: "error",
      type: "apps-script-proxy",
      errorCode: "apps_script_token_missing",
      message: "APPS_SCRIPT_TOKEN is missing in Cloudflare Worker secrets"
    };
  }

  const rawText = await request.text();
  let payload = {};
  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch (err) {
    return {
      status: "error",
      type: "apps-script-proxy",
      errorCode: "bad_json",
      message: "Apps Script proxy expected a JSON request body"
    };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      status: "error",
      type: "apps-script-proxy",
      errorCode: "bad_payload",
      message: "Apps Script proxy expected a JSON object"
    };
  }

  const forwarded = Object.assign({}, payload);
  delete forwarded.appToken;
  delete forwarded.app_token;
  delete forwarded.healthToken;
  forwarded.appToken = scriptToken;
  forwarded.viaCloudflare = true;
  forwarded.proxyVersion = AI_PROXY_VERSION;

  const resp = await fetch(target, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
      "Accept": "application/json"
    },
    body: JSON.stringify(forwarded)
  });
  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (err) {
    return {
      status: "error",
      type: "apps-script-proxy",
      errorCode: "apps_script_non_json",
      message: "Apps Script returned non-JSON",
      httpStatus: resp.status
    };
  }
  if (!resp.ok) {
    return Object.assign({
      status: "error",
      type: "apps-script-proxy",
      errorCode: "apps_script_http_error",
      message: "Apps Script request failed",
      httpStatus: resp.status
    }, data || {});
  }
  return data || { status: "error", type: "apps-script-proxy", errorCode: "apps_script_empty_response", message: "Apps Script returned an empty response" };
}

async function ensureTrainerCacheSchema(env) {
  if (!hasD1(env)) return false;
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS trainer_artifacts (
      artifact_type TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      plan_slot TEXT NOT NULL DEFAULT '',
      source_session_id TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (artifact_type, artifact_id, plan_slot)
    )
  `).run();
  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_trainer_artifacts_type_slot_updated
    ON trainer_artifacts (artifact_type, plan_slot, updated_at)
  `).run();
  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_trainer_artifacts_source_session
    ON trainer_artifacts (source_session_id)
  `).run();
  return true;
}

async function ensureNutritionCacheSchema(env) {
  if (!hasD1(env)) return false;
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS nutrition_lookup_cache (
      cache_key TEXT PRIMARY KEY,
      lookup_type TEXT NOT NULL DEFAULT '',
      query_norm TEXT NOT NULL DEFAULT '',
      context_norm TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL,
      hits INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT '',
      expires_at TEXT NOT NULL DEFAULT ''
    )
  `).run();
  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_nutrition_lookup_cache_type_query
    ON nutrition_lookup_cache (lookup_type, query_norm)
  `).run();
  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_nutrition_lookup_cache_updated
    ON nutrition_lookup_cache (updated_at)
  `).run();
  return true;
}

function nutritionCacheNormalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

function nutritionCacheKey(body) {
  const b = body && typeof body === "object" ? body : {};
  const explicit = String(b.cacheKey || b.key || "").trim();
  if (explicit) return explicit.slice(0, 320);
  const type = nutritionCacheNormalizeText(b.lookupType || b.type || "food_lookup") || "food_lookup";
  const query = nutritionCacheNormalizeText(b.query || b.food || b.name || "");
  const ctx = nutritionCacheNormalizeText(b.context || b.brand || "");
  if (!query) return "";
  return [type, query, ctx].join("|").slice(0, 320);
}

function nutritionCachePayload(body) {
  const b = body && typeof body === "object" ? body : {};
  const data = b.data && typeof b.data === "object" ? b.data : (b.payload && typeof b.payload === "object" ? b.payload : null);
  return data || null;
}

function nutritionCacheMaxAgeDays(body) {
  return clampInt((body && body.maxAgeDays) || 60, 1, 365);
}

function parseNutritionCacheRow(row) {
  if (!row) return null;
  let payload = null;
  try { payload = row.payload_json ? JSON.parse(row.payload_json) : null; } catch (_) {}
  if (!payload || typeof payload !== "object") return null;
  return {
    cacheKey: row.cache_key || "",
    lookupType: row.lookup_type || "",
    queryNorm: row.query_norm || "",
    contextNorm: row.context_norm || "",
    source: row.source || "",
    updatedAt: row.updated_at || "",
    expiresAt: row.expires_at || "",
    hits: row.hits || 0,
    data: payload
  };
}

async function handleNutritionCacheGet(body, env) {
  if (!hasD1(env)) {
    return {
      status: "ok",
      type: "nutrition-cache-get",
      d1Configured: false,
      data: null
    };
  }
  await ensureNutritionCacheSchema(env);
  const cacheKey = nutritionCacheKey(body);
  if (!cacheKey) {
    return { status: "ok", type: "nutrition-cache-get", d1Configured: true, data: null, hit: false };
  }
  const row = await env.DB.prepare(`
    SELECT * FROM nutrition_lookup_cache
    WHERE cache_key = ?
    LIMIT 1
  `).bind(cacheKey).first();
  const parsed = parseNutritionCacheRow(row);
  if (!parsed) {
    return { status: "ok", type: "nutrition-cache-get", d1Configured: true, data: null, hit: false };
  }
  const now = Date.now();
  const maxAgeDays = nutritionCacheMaxAgeDays(body);
  const updatedMs = Date.parse(parsed.updatedAt || row.created_at || "");
  const expiresMs = Date.parse(parsed.expiresAt || "");
  const expired = (Number.isFinite(updatedMs) && updatedMs > 0 && now - updatedMs > maxAgeDays * 86400000) ||
    (Number.isFinite(expiresMs) && expiresMs > 0 && now > expiresMs);
  if (expired) {
    return { status: "ok", type: "nutrition-cache-get", d1Configured: true, data: null, hit: false, expired: true };
  }
  await env.DB.prepare(`
    UPDATE nutrition_lookup_cache
    SET hits = hits + 1
    WHERE cache_key = ?
  `).bind(cacheKey).run();
  return {
    status: "ok",
    type: "nutrition-cache-get",
    d1Configured: true,
    hit: true,
    data: parsed
  };
}

async function handleNutritionCacheUpsert(body, env) {
  if (!hasD1(env)) {
    return {
      status: "ok",
      type: "nutrition-cache-upsert",
      d1Configured: false,
      skipped: true,
      message: "D1 DB binding is not configured"
    };
  }
  await ensureNutritionCacheSchema(env);
  const cacheKey = nutritionCacheKey(body);
  const payload = nutritionCachePayload(body);
  if (!cacheKey || !payload) {
    return { status: "error", errorCode: "missing_nutrition_cache_key_or_payload", message: "Missing nutrition cache key or data" };
  }
  const lookupType = nutritionCacheNormalizeText(body.lookupType || body.type || "food_lookup") || "food_lookup";
  const queryNorm = nutritionCacheNormalizeText(body.query || body.food || body.name || "");
  const contextNorm = nutritionCacheNormalizeText(body.context || body.brand || "");
  const source = String(body.source || payload.source || payload._src || "ai_lookup").slice(0, 80);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + nutritionCacheMaxAgeDays(body) * 86400000).toISOString();
  await env.DB.prepare(`
    INSERT INTO nutrition_lookup_cache (
      cache_key, lookup_type, query_norm, context_norm, source, payload_json, hits, updated_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      lookup_type = excluded.lookup_type,
      query_norm = excluded.query_norm,
      context_norm = excluded.context_norm,
      source = excluded.source,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at,
      expires_at = excluded.expires_at
  `).bind(
    cacheKey,
    lookupType,
    queryNorm,
    contextNorm,
    source,
    JSON.stringify(payload),
    now,
    expiresAt
  ).run();
  return {
    status: "ok",
    type: "nutrition-cache-upsert",
    d1Configured: true,
    cacheKey
  };
}

function trainerArtifactPayload(artifact) {
  const a = artifact && typeof artifact === "object" ? artifact : {};
  const data = a.data && typeof a.data === "object" ? a.data : null;
  const payload = a.payload && typeof a.payload === "object" ? a.payload : null;
  return data || payload || a;
}

function trainerArtifactType(artifact) {
  return String((artifact && (artifact.artifactType || artifact.type)) || "").trim().toLowerCase();
}

function trainerArtifactId(artifact, payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  return String(
    (artifact && artifact.artifactId) ||
    p.planId ||
    p.coachStateId ||
    p.reviewId ||
    p.equipmentProfileId ||
    p.equipmentProfileHash ||
    p.sessionId ||
    ""
  ).trim();
}

function trainerArtifactSlot(artifact, payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  return String((artifact && artifact.planSlot) || p.planSlot || "").trim().toUpperCase();
}

function trainerArtifactRevision(artifact, payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  return clampInt(
    (artifact && artifact.revision) ||
    p.revision ||
    p.coachStateRevision ||
    p.sessionRevision ||
    1,
    0,
    2147483647
  );
}

function trainerArtifactUpdatedAt(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  return String(p.updatedAt || p.lastUpdatedAt || p.completedAt || p.createdAt || new Date().toISOString());
}

function trainerArtifactSourceSessionId(artifact, payload, fallback) {
  const p = payload && typeof payload === "object" ? payload : {};
  return String(
    (artifact && artifact.sourceSessionId) ||
    p.sourceSessionId ||
    p.lastCompletedSessionId ||
    p.sessionId ||
    fallback ||
    ""
  ).trim();
}

function trainerSanitizeExerciseSkipFields(ex) {
  if (!ex || typeof ex !== "object") return ex;
  const out = { ...ex };
  const raw = String(out.skipped || "").trim().toLowerCase();
  const isSkipped = raw === "yes" || raw === "true" || raw === "1" || raw === "skipped";
  out.skipped = isSkipped ? "yes" : "";
  out.skipReason = isSkipped ? String(out.skipReason || "").trim() : "";
  return out;
}

function trainerSanitizePayload(payload, artifactType) {
  if (!payload || typeof payload !== "object") return payload;
  const out = { ...payload };
  const type = String(artifactType || out.artifactType || out.type || "").toLowerCase();
  if (type === "session" && Array.isArray(out.exercises)) {
    out.exercises = out.exercises.map(trainerSanitizeExerciseSkipFields);
  }
  if (type === "session" && out.payloadJson) {
    try {
      const nested = JSON.parse(String(out.payloadJson || "{}"));
      if (nested && typeof nested === "object") {
        const cleanNested = trainerSanitizePayload(nested, "session");
        out.payloadJson = JSON.stringify(cleanNested);
      }
    } catch (_) {}
  }
  return out;
}

async function handleTrainerCacheUpsert(body, env) {
  if (!hasD1(env)) {
    return {
      status: "ok",
      type: "trainer-cache-upsert",
      d1Configured: false,
      skipped: true,
      message: "D1 DB binding is not configured"
    };
  }
  await ensureTrainerCacheSchema(env);
  const artifacts = Array.isArray(body.artifacts) ? body.artifacts : [];
  const sourceSessionId = String(body.sourceSessionId || "").trim();
  const results = [];
  for (const artifact of artifacts) {
    const artifactType = trainerArtifactType(artifact);
    const payload = trainerSanitizePayload(trainerArtifactPayload(artifact), artifactType);
    const artifactId = trainerArtifactId(artifact, payload);
    const planSlot = trainerArtifactSlot(artifact, payload);
    if (!artifactType || !artifactId) {
      results.push({ status: "error", errorCode: "missing_artifact_key", artifactType, artifactId, planSlot });
      continue;
    }
    const payloadJson = JSON.stringify(payload || {});
    await env.DB.prepare(`
      INSERT INTO trainer_artifacts (
        artifact_type, artifact_id, plan_slot, source_session_id, revision, updated_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(artifact_type, artifact_id, plan_slot) DO UPDATE SET
        source_session_id = excluded.source_session_id,
        revision = excluded.revision,
        updated_at = excluded.updated_at,
        payload_json = excluded.payload_json
    `).bind(
      artifactType,
      artifactId,
      planSlot,
      trainerArtifactSourceSessionId(artifact, payload, sourceSessionId),
      trainerArtifactRevision(artifact, payload),
      trainerArtifactUpdatedAt(payload),
      payloadJson
    ).run();
    results.push({ status: "ok", artifactType, artifactId, planSlot });
  }
  const failedCount = results.filter(r => r.status !== "ok").length;
  return {
    status: failedCount ? "partial" : "ok",
    type: "trainer-cache-upsert",
    d1Configured: true,
    results,
    successCount: results.length - failedCount,
    failedCount
  };
}

function parseTrainerPayload(row) {
  if (!row) return null;
  let payload = null;
  try { payload = row.payload_json ? JSON.parse(row.payload_json) : null; } catch (_) {}
  if (!payload || typeof payload !== "object") payload = {};
  const out = trainerSanitizePayload(Object.assign({}, payload, {
    payloadJson: row.payload_json || "{}",
    artifactType: row.artifact_type || "",
    artifactId: row.artifact_id || "",
    planSlot: row.plan_slot || "",
    sourceSessionId: payload.sourceSessionId || row.source_session_id || "",
    revision: payload.revision || row.revision || 0,
    updatedAt: payload.updatedAt || payload.lastUpdatedAt || row.updated_at || ""
  }), row.artifact_type || payload.artifactType || payload.type || "");
  const jsonPayload = { ...out };
  delete jsonPayload.payloadJson;
  out.payloadJson = JSON.stringify(jsonPayload);
  return out;
}

function trainerPlanIsUsable(payload) {
  const status = String(payload && payload.status || "").toLowerCase();
  const validation = String(payload && payload.validationStatus || "").toLowerCase();
  if (validation.indexOf("invalid") >= 0) return false;
  return status === "active" || status === "fallback_used" || status === "ready" || status === "";
}

function artifactDateMs(value) {
  const raw = String(value || "").trim();
  if (!raw) return 0;
  let normalized = raw;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) normalized = `${raw}T12:00:00Z`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : 0;
}

function trainerArtifactFreshnessMs(payload, artifactType) {
  const p = payload && typeof payload === "object" ? payload : {};
  const type = String(artifactType || "").toLowerCase();
  if (type === "session") {
    return artifactDateMs(p.completedAt || p.workoutDate || p.normalizedWorkoutDate || p.date || p.timestamp || p.updatedAt);
  }
  if (type === "generated_plan") {
    return artifactDateMs(p.updatedAt || p.generatedAt || p.createdAt);
  }
  if (type === "post_workout_review") {
    return artifactDateMs(p.completedAt || p.workoutDate || p.sessionDate || p.updatedAt || p.createdAt);
  }
  if (type === "coach_state") {
    return artifactDateMs(p.lastUpdatedAt || p.updatedAt || p.createdAt);
  }
  return artifactDateMs(p.updatedAt || p.lastUpdatedAt || p.createdAt);
}

function trainerArtifactTieBreak(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const revision = clampInt(p.revision || p.coachStateRevision || p.sessionRevision || 0, 0, 2147483647);
  return (artifactDateMs(p.updatedAt || p.lastUpdatedAt || p.createdAt) * 1000) + revision;
}

function trainerPayloadIsTest(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const ids = [
    p.sessionId,
    p.sourceSessionId,
    p.planId,
    p.reviewId,
    p.coachStateId,
    p.artifactId,
    p.clientMutationId
  ].map(v => String(v || ""));
  return ids.some(v =>
    /^test_/i.test(v) ||
    /^appdoctor/i.test(v) ||
    /^phase7_/i.test(v) ||
    /^smoke[_-]/i.test(v) ||
    /^diagnostic[_-]/i.test(v) ||
    /(^|[_-])(d1[_-])?fallback[_-]?check([_-]|$)/i.test(v)
  );
}

function pickLatestTrainerPayload(rows, artifactType) {
  let parsed = (Array.isArray(rows) ? rows : []).map(parseTrainerPayload).filter(Boolean);
  parsed = parsed.filter(payload => !trainerPayloadIsTest(payload));
  if (!parsed.length) return null;
  const usable = String(artifactType || "").toLowerCase() === "generated_plan"
    ? parsed.filter(trainerPlanIsUsable)
    : parsed;
  const candidates = usable.length ? usable : parsed;
  candidates.sort((a, b) => {
    const af = trainerArtifactFreshnessMs(a, artifactType);
    const bf = trainerArtifactFreshnessMs(b, artifactType);
    if (bf !== af) return bf - af;
    return trainerArtifactTieBreak(b) - trainerArtifactTieBreak(a);
  });
  return candidates[0] || null;
}

async function latestTrainerArtifact(env, artifactType, planSlot) {
  const slot = String(planSlot || "").toUpperCase();
  const rows = slot
    ? await env.DB.prepare(`
        SELECT * FROM trainer_artifacts
        WHERE artifact_type = ? AND plan_slot = ?
        ORDER BY updated_at DESC, revision DESC
        LIMIT 100
      `).bind(artifactType, slot).all()
    : await env.DB.prepare(`
        SELECT * FROM trainer_artifacts
        WHERE artifact_type = ?
        ORDER BY updated_at DESC, revision DESC
        LIMIT 100
      `).bind(artifactType).all();
  const list = rows && Array.isArray(rows.results) ? rows.results : [];
  return pickLatestTrainerPayload(list, artifactType);
}

async function latestTrainerArtifactForSourceSession(env, artifactType, planSlot, sourceSessionId) {
  const sid = String(sourceSessionId || "").trim();
  if (!sid) return null;
  const slot = String(planSlot || "").toUpperCase();
  const rows = slot
    ? await env.DB.prepare(`
        SELECT * FROM trainer_artifacts
        WHERE artifact_type = ? AND plan_slot = ? AND source_session_id = ?
        ORDER BY updated_at DESC, revision DESC
        LIMIT 100
      `).bind(artifactType, slot, sid).all()
    : await env.DB.prepare(`
        SELECT * FROM trainer_artifacts
        WHERE artifact_type = ? AND source_session_id = ?
        ORDER BY updated_at DESC, revision DESC
        LIMIT 100
      `).bind(artifactType, sid).all();
  const list = rows && Array.isArray(rows.results) ? rows.results : [];
  return pickLatestTrainerPayload(list, artifactType);
}

async function handleTrainerCacheGet(body, env) {
  if (!hasD1(env)) {
    return {
      status: "ok",
      type: "trainer-cache-get",
      d1Configured: false,
      data: { d1Configured: false }
    };
  }
  await ensureTrainerCacheSchema(env);
  const trainerContext = await latestTrainerArtifact(env, "trainer_context", "");
  const authoritySessionId = String(
    trainerContext && trainerContext.sheetAuthority && trainerContext.sheetAuthority.latestSessionId || ""
  ).trim();
  const latestCompletedSession = (authoritySessionId ? await latestTrainerArtifactForSourceSession(env, "session", "", authoritySessionId) : null)
    || await latestTrainerArtifact(env, "session", "");
  const latestSessionId = String(latestCompletedSession && latestCompletedSession.sessionId || "");
  const strictToSheetSession = !!(authoritySessionId && latestSessionId);
  const activeHomePlan = (await latestTrainerArtifactForSourceSession(env, "generated_plan", "HOME_NEXT", latestSessionId))
    || (strictToSheetSession ? null : (await latestTrainerArtifact(env, "generated_plan", "HOME_NEXT")));
  const activeHotelPlan = (await latestTrainerArtifactForSourceSession(env, "generated_plan", "HOTEL_NEXT", latestSessionId))
    || (strictToSheetSession ? null : (await latestTrainerArtifact(env, "generated_plan", "HOTEL_NEXT")));
  let latestCoachState = await latestTrainerArtifact(env, "coach_state", "");
  if (strictToSheetSession && latestCoachState && latestCoachState.lastCompletedSessionId && String(latestCoachState.lastCompletedSessionId) !== latestSessionId) {
    latestCoachState = null;
  }
  const latestReview = (await latestTrainerArtifactForSourceSession(env, "post_workout_review", "", latestSessionId))
    || (strictToSheetSession ? null : (await latestTrainerArtifact(env, "post_workout_review", "")));
  const equipmentProfile = await latestTrainerArtifact(env, "equipment_profile", "");
  return {
    status: "ok",
    type: "trainer-cache-get",
    d1Configured: true,
    data: {
      d1Configured: true,
      source: "cloudflare_d1",
      latestCompletedSession,
      latestSession: latestCompletedSession,
      activeHomePlan,
      activeHotelPlan,
      latestCoachState,
      latestReview,
      equipmentProfile,
      trainerContext
    }
  };
}

function trainerBrainEvent(value) {
  return String(value || "manual_refresh")
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, "_")
    .slice(0, 80) || "manual_refresh";
}

function trainerBrainBool(value, fallback) {
  if (value === true || value === false) return value;
  if (value === 1 || value === "1" || String(value).toLowerCase() === "true") return true;
  if (value === 0 || value === "0" || String(value).toLowerCase() === "false") return false;
  return !!fallback;
}

function trainerBrainFallbackDecision(eventType, body, cloudState) {
  const type = trainerBrainEvent(eventType);
  const ctx = body && body.context && typeof body.context === "object" ? body.context : {};
  const latestSession = cloudState && (cloudState.latestCompletedSession || cloudState.latestSession) || null;
  const hasHome = !!(cloudState && cloudState.activeHomePlan);
  const hasHotel = !!(cloudState && cloudState.activeHotelPlan);
  const completed = /workout_completed|session_completed|finish_workout/.test(type);
  const manual = /manual|retry|refresh/.test(type);
  const material = /settings|autopilot|calendar|goal|equipment|coach/.test(type);
  const startup = /startup|boot/.test(type);
  const allowPlanGeneration = trainerBrainBool(body && body.allowPlanGeneration, trainerBrainBool(ctx.allowPlanGeneration, true));
  const missingPlan = !hasHome || !hasHotel;
  const queuePlans = allowPlanGeneration && (completed || manual || material || (!startup && missingPlan));
  const reasons = [];
  if (completed) reasons.push("completed_workout_updates_next_plans");
  if (material) reasons.push("coach_context_changed");
  if (manual) reasons.push("manual_refresh_requested");
  if (missingPlan) reasons.push("missing_active_plan");
  if (!queuePlans && startup) reasons.push("startup_read_only");
  return {
    source: "deterministic",
    eventType: type,
    latestSessionId: String(latestSession && latestSession.sessionId || body && body.sourceSessionId || ""),
    queueReview: completed,
    queueCoachState: completed || material || manual,
    queueHomePlan: queuePlans,
    queueHotelPlan: queuePlans,
    syncToSheet: completed || material || manual,
    preserveCurrentOnFailure: true,
    useD1First: true,
    useAppsScriptFallback: true,
    confidence: "medium",
    summary: reasons.length ? reasons.join("; ") : "no_action_needed",
    reasons
  };
}

function trainerBrainSlimState(state) {
  const s = state && typeof state === "object" ? state : {};
  function slimPlan(plan) {
    if (!plan) return null;
    return {
      planId: String(plan.planId || ""),
      planSlot: String(plan.planSlot || ""),
      targetType: String(plan.targetType || ""),
      sourceSessionId: String(plan.sourceSessionId || ""),
      status: String(plan.status || ""),
      fallbackUsed: !!plan.fallbackUsed,
      validationStatus: String(plan.validationStatus || ""),
      updatedAt: String(plan.updatedAt || plan.generatedAt || "")
    };
  }
  return {
    latestSession: s.latestCompletedSession ? {
      sessionId: String(s.latestCompletedSession.sessionId || ""),
      date: String(s.latestCompletedSession.date || s.latestCompletedSession.workoutDate || ""),
      workoutType: String(s.latestCompletedSession.workoutType || ""),
      targetType: String(s.latestCompletedSession.targetType || ""),
      completedAt: String(s.latestCompletedSession.completedAt || s.latestCompletedSession.updatedAt || "")
    } : null,
    latestReview: s.latestReview ? {
      reviewId: String(s.latestReview.reviewId || ""),
      sessionId: String(s.latestReview.sessionId || s.latestReview.sourceSessionId || ""),
      verdict: String(s.latestReview.sessionVerdict || ""),
      mainLimiter: String(s.latestReview.mainLimiter || ""),
      nextChange: String(s.latestReview.nextChange || ""),
      fallbackUsed: !!s.latestReview.fallbackUsed,
      updatedAt: String(s.latestReview.updatedAt || "")
    } : null,
    latestCoachState: s.latestCoachState ? {
      coachStateId: String(s.latestCoachState.coachStateId || ""),
      coachStateRevision: clampInt(s.latestCoachState.coachStateRevision || 0, 0, 2147483647),
      mainLimiter: String(s.latestCoachState.mainLimiter || ""),
      nextAction: String(s.latestCoachState.nextAction || ""),
      lastCompletedSessionId: String(s.latestCoachState.lastCompletedSessionId || ""),
      updatedAt: String(s.latestCoachState.updatedAt || s.latestCoachState.lastUpdatedAt || "")
    } : null,
    activeHomePlan: slimPlan(s.activeHomePlan),
    activeHotelPlan: slimPlan(s.activeHotelPlan),
    equipmentProfile: s.equipmentProfile ? {
      equipmentProfileId: String(s.equipmentProfile.equipmentProfileId || ""),
      equipmentProfileHash: String(s.equipmentProfile.equipmentProfileHash || ""),
      updatedAt: String(s.equipmentProfile.updatedAt || "")
    } : null,
      trainerContext: s.trainerContext ? {
      goals: s.trainerContext.goals || null,
      bodyMetrics: s.trainerContext.bodyMetrics || null,
      profile: s.trainerContext.profile ? {
        homeDuration: s.trainerContext.profile.homeDuration,
        hotelDuration: s.trainerContext.profile.hotelDuration,
        progressionStyle: s.trainerContext.profile.progressionStyle,
        nextTestDate: s.trainerContext.profile.nextTestDate,
        goalNote: String(s.trainerContext.profile.goalNote || "").slice(0, 240)
      } : null,
      voiceMins: s.trainerContext.voiceMins || null,
      calendar: s.trainerContext.calendar || null,
      calendarMemoryRuleCount: s.trainerContext.calendarRules && Array.isArray(s.trainerContext.calendarRules.calendarMemoryRules)
        ? s.trainerContext.calendarRules.calendarMemoryRules.length
        : 0,
      sheetAuthority: s.trainerContext.sheetAuthority || null,
      coachNotes: String(s.trainerContext.coachNotes || "").slice(0, 600),
      updatedAt: String(s.trainerContext.updatedAt || "")
    } : null
  };
}

function trainerBrainPrompt(eventType, body, cloudState, fallbackDecision) {
  const ctx = body && body.context && typeof body.context === "object" ? body.context : {};
  return [
    "You are the controller for an autonomous personal trainer app.",
    "Return one JSON object only. Do not generate a workout plan here.",
    "Your job is to decide which background jobs the app should queue.",
    "Rules:",
    "- After a completed strength workout, review the workout, update coach state, regenerate HOME and HOTEL next plans, sync D1, and keep Sheet backup.",
    "- After material coach settings, goal, calendar, or equipment changes, regenerate affected plans when plan generation is allowed.",
    "- On startup, prefer read-only D1/bootstrap unless plans are missing or a manual refresh was requested.",
    "- Always preserve the current startable plan if a new AI plan fails.",
    "- D1 is fast state, Sheets remain durable backup, Apps Script remains fallback.",
    "Output shape:",
    "{\"summary\":\"<=20 words\",\"queueReview\":true,\"queueCoachState\":true,\"queueHomePlan\":true,\"queueHotelPlan\":true,\"syncToSheet\":true,\"preserveCurrentOnFailure\":true,\"confidence\":\"low|medium|high\",\"reasons\":[\"short_reason\"]}",
    "",
    "Event: " + trainerBrainEvent(eventType),
    "Context: " + JSON.stringify({
      allowPlanGeneration: trainerBrainBool(body && body.allowPlanGeneration, trainerBrainBool(ctx.allowPlanGeneration, true)),
      trigger: String(ctx.trigger || body && body.trigger || ""),
      reason: String(ctx.reason || body && body.reason || ""),
      appVersion: String(body && body.clientVersion || "")
    }),
    "Cloud trainer state: " + JSON.stringify(trainerBrainSlimState(cloudState)),
    "Deterministic safe decision: " + JSON.stringify(fallbackDecision)
  ].join("\n");
}

function trainerBrainNormalizeDecision(raw, fallback) {
  const f = fallback && typeof fallback === "object" ? fallback : {};
  const p = raw && typeof raw === "object" ? raw : {};
  const reasons = Array.isArray(p.reasons) ? p.reasons.map(v => String(v || "").slice(0, 80)).filter(Boolean) : [];
  return {
    source: p.source ? String(p.source).slice(0, 40) : (raw ? "ai" : String(f.source || "deterministic")),
    eventType: String(f.eventType || p.eventType || ""),
    latestSessionId: String(f.latestSessionId || p.latestSessionId || ""),
    queueReview: trainerBrainBool(p.queueReview, !!f.queueReview) || !!f.queueReview,
    queueCoachState: trainerBrainBool(p.queueCoachState, !!f.queueCoachState) || !!f.queueCoachState,
    queueHomePlan: trainerBrainBool(p.queueHomePlan, !!f.queueHomePlan) || !!f.queueHomePlan,
    queueHotelPlan: trainerBrainBool(p.queueHotelPlan, !!f.queueHotelPlan) || !!f.queueHotelPlan,
    syncToSheet: trainerBrainBool(p.syncToSheet, !!f.syncToSheet) || !!f.syncToSheet,
    preserveCurrentOnFailure: trainerBrainBool(p.preserveCurrentOnFailure, true),
    useD1First: true,
    useAppsScriptFallback: true,
    confidence: ["low", "medium", "high"].includes(String(p.confidence || "").toLowerCase())
      ? String(p.confidence).toLowerCase()
      : String(f.confidence || "medium"),
    summary: String(p.summary || f.summary || "trainer_brain_decision").slice(0, 240),
    reasons: reasons.length ? reasons : (Array.isArray(f.reasons) ? f.reasons : [])
  };
}

async function handleTrainerBrainRun(body, env) {
  const eventType = trainerBrainEvent(body && (body.eventType || body.trigger));
  const sourceSessionId = String(body && body.sourceSessionId || "").trim();
  const artifacts = Array.isArray(body && body.artifacts) ? body.artifacts : [];
  let cacheUpsert = null;
  let cloudState = null;
  if (hasD1(env)) {
    await ensureTrainerCacheSchema(env);
    if (artifacts.length) {
      cacheUpsert = await handleTrainerCacheUpsert({ artifacts, sourceSessionId }, env);
    }
    const loaded = await handleTrainerCacheGet({ sourceSessionId }, env);
    cloudState = loaded && loaded.data || null;
  }
  const fallbackDecision = trainerBrainFallbackDecision(eventType, body || {}, cloudState || {});
  let aiDecision = null;
  let aiError = "";
  if (env.OPENAI_API_KEY && !(body && body.runAi === false)) {
    try {
      const result = await handleChatJson({
        payload: {
          model: String(body && body.model || "gpt-5.4-mini"),
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "Return valid JSON only." },
            { role: "user", content: trainerBrainPrompt(eventType, body || {}, cloudState || {}, fallbackDecision) }
          ],
          max_completion_tokens: clampInt(body && body.max_completion_tokens || 650, 128, 1600)
        }
      }, env, false);
      const parsed = extractJsonObject(responseLikeText(result && result.data));
      aiDecision = trainerBrainNormalizeDecision(Object.assign({ source: "ai" }, parsed), fallbackDecision);
    } catch (err) {
      aiError = String(err && err.message || err || "trainer_brain_ai_failed").slice(0, 300);
    }
  }
  const decision = trainerBrainNormalizeDecision(aiDecision, fallbackDecision);
  const brainRunId = String(body && body.brainRunId || `brain_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  const brainArtifact = {
    brainRunId,
    eventType,
    sourceSessionId: decision.latestSessionId || sourceSessionId,
    decision,
    aiError,
    openaiConfigured: !!env.OPENAI_API_KEY,
    d1Configured: hasD1(env),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  let brainUpsert = null;
  if (hasD1(env)) {
    brainUpsert = await handleTrainerCacheUpsert({
      sourceSessionId: brainArtifact.sourceSessionId,
      artifacts: [{
        artifactType: "trainer_brain_run",
        artifactId: brainRunId,
        revision: 1,
        data: brainArtifact
      }]
    }, env);
  }
  return {
    status: "ok",
    type: "trainer-brain-run",
    brainRunId,
    d1Configured: hasD1(env),
    openaiConfigured: !!env.OPENAI_API_KEY,
    source: aiDecision ? "ai" : "deterministic",
    decision,
    aiError,
    cacheUpsert,
    brainUpsert,
    cloudState: trainerBrainSlimState(cloudState)
  };
}

function providerKeyMissing(provider, secretName) {
  return {
    status: "error",
    errorCode: `${provider}_key_missing`,
    message: `${secretName} missing`
  };
}

async function handleGeminiJson(body, env) {
  const payload = body.payload && typeof body.payload === "object" ? body.payload : body;
  const req = geminiPayloadFromChat(payload);
  const model = String(payload.model || body.model || DEFAULT_GEMINI_MODEL);
  const result = await geminiJson(model, req, env);
  return normalizeGeminiResult(result, model);
}

async function handleGeminiVisionJson(body, env) {
  const b64 = String(body.imageBase64 || body.b64 || "").replace(/^data:[^,]+,/, "");
  const prompt = String(body.prompt || "");
  if (!b64 || !prompt) {
    return { status: "error", errorCode: "missing_image_or_prompt", message: "Missing imageBase64 or prompt" };
  }
  const mime = String(body.mime || body.mediaType || "image/jpeg");
  const model = String(body.model || DEFAULT_GEMINI_MODEL);
  const req = {
    contents: [{
      role: "user",
      parts: [
        { inline_data: { mime_type: mime, data: b64 } },
        { text: prompt }
      ]
    }],
    generationConfig: geminiGenerationConfig(body, true)
  };
  const result = await geminiJson(model, req, env);
  return normalizeGeminiResult(result, model);
}

async function handleClaudeJson(body, env) {
  const payload = body.payload && typeof body.payload === "object" ? body.payload : body;
  const req = claudePayloadFromChat(payload);
  const result = await anthropicJson("/messages", req, env);
  return normalizeClaudeResult(result, req.model);
}

async function handleClaudeVisionJson(body, env) {
  const b64 = String(body.imageBase64 || body.b64 || "").replace(/^data:[^,]+,/, "");
  const prompt = String(body.prompt || "");
  if (!b64 || !prompt) {
    return { status: "error", errorCode: "missing_image_or_prompt", message: "Missing imageBase64 or prompt" };
  }
  const mime = String(body.mime || body.mediaType || "image/jpeg");
  const req = {
    model: String(body.model || DEFAULT_CLAUDE_MODEL),
    max_tokens: clampInt(body.max_output_tokens || body.max_completion_tokens || body.max_tokens || 1200, 64, 6000),
    system: String(body.system || "Return ONLY valid JSON. No markdown, no prose."),
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mime, data: b64 } },
        { type: "text", text: prompt }
      ]
    }]
  };
  const result = await anthropicJson("/messages", req, env);
  return normalizeClaudeResult(result, req.model);
}

async function handleClaudeNutrition(body, env) {
  const query = String(body.query || "").trim();
  const serving = clampNumber(body.serving || 100, 1, 5000);
  if (!query) return { source: "Claude", status: "error", message: "No query" };
  const req = {
    model: String(body.model || DEFAULT_CLAUDE_MODEL),
    max_tokens: clampInt(body.max_tokens || body.max_output_tokens || 400, 64, 2000),
    system: "Return ONLY a JSON object, no markdown.",
    messages: [{
      role: "user",
      content: `Estimate nutrition for: "${query}", approximately ${serving}g serving. Return JSON: {"calories":0,"protein":0,"carbs":0,"fat":0,"fibre":0,"satFat":0,"sodium":0}. All values per that serving. Sodium in mg. No other text.`
    }]
  };
  const result = await anthropicJson("/messages", req, env);
  return nutritionProviderResult("Claude", anthropicText(result));
}

async function handleClaudeVisionNutrition(body, env) {
  const query = String(body.query || "").trim();
  const serving = clampNumber(body.serving || 100, 1, 5000);
  const imageB64 = String(body.imageBase64 || body.b64 || "").replace(/^data:[^,]+,/, "");
  const imageMime = String(body.imageMime || body.mime || body.mediaType || "image/jpeg");
  if (!query && !imageB64) return { source: "Claude", status: "error", message: "No query or image" };
  const userContent = [];
  if (imageB64) {
    userContent.push({ type: "image", source: { type: "base64", media_type: imageMime, data: imageB64 } });
  }
  const brandNote = /mcdonald|starbucks|kfc|chipotle|subway|wagamama|coco ichi|nando|burger king|wendy|taco bell|chick-fil|popeyes|panda express|domino|pizza hut|five guys/i.test(query)
    ? "This is a known chain restaurant, so use exact published nutrition when confidently identifiable. "
    : "";
  userContent.push({
    type: "text",
    text:
      `You are a nutrition expert verifying a food estimate. The item appears to be: "${query || "visible food"}". ` +
      brandNote +
      `Approximate serving hint: ${serving}g.\n\n` +
      "Analyze the image carefully and estimate the total nutrition for what you see. Use visible scale cues when possible. " +
      "Calories must roughly equal (Protein*4)+(Carbs*4)+(Fat*9), and satFat must be <= fat. " +
      'Return ONLY JSON for the total visible portion: {"calories":0,"protein":0,"carbs":0,"fat":0,"fibre":0,"satFat":0,"sodium":0}. Sodium in mg. No other text.'
  });
  const req = {
    model: String(body.model || DEFAULT_CLAUDE_MODEL),
    max_tokens: clampInt(body.max_tokens || body.max_output_tokens || 400, 64, 2000),
    system: "Return ONLY a JSON object, no markdown.",
    messages: [{ role: "user", content: userContent }]
  };
  const result = await anthropicJson("/messages", req, env);
  return nutritionProviderResult("Claude", anthropicText(result));
}

async function handleScanFood(body, env) {
  const b64 = String(body.imageBase64 || body.b64 || "").replace(/^data:[^,]+,/, "");
  const mime = String(body.mediaType || body.mime || "image/jpeg");
  if (!b64) return { status: "error", errorCode: "missing_image", message: "No image data" };
  const errors = [];
  if (env.GEMINI_API_KEY) {
    try {
      const gemini = await handleGeminiVisionJson({
        model: body.geminiModel || DEFAULT_GEMINI_MODEL,
        prompt: body.prompt || SCAN_PROMPT,
        imageBase64: b64,
        mime,
        max_output_tokens: body.max_output_tokens || 700
      }, env);
      const text = responseLikeText(gemini.data);
      const parsed = sanitizeNutritionObject(extractJsonObject(text));
      return { status: "ok", data: parsed, source: "gemini" };
    } catch (err) {
      errors.push({ source: "gemini", message: String(err && err.message || err) });
    }
  }
  if (env.ANTHROPIC_API_KEY) {
    try {
      const claude = await handleClaudeVisionJson({
        model: body.claudeModel || DEFAULT_CLAUDE_MODEL,
        prompt: body.prompt || SCAN_PROMPT,
        imageBase64: b64,
        mime,
        max_output_tokens: body.max_output_tokens || 700
      }, env);
      const text = responseLikeText(claude.data);
      const parsed = sanitizeNutritionObject(extractJsonObject(text));
      return { status: "ok", data: parsed, source: "claude" };
    } catch (err) {
      errors.push({ source: "claude", message: String(err && err.message || err) });
    }
  }
  return {
    status: "error",
    errorCode: "scan_provider_unavailable",
    message: "No Gemini or Claude scan provider succeeded",
    providerErrors: errors
  };
}

async function handleChatJson(body, env, background) {
  const payload = body.payload && typeof body.payload === "object" ? body.payload : body;
  const req = chatPayloadToResponses(payload, background);
  const result = await openaiJson("/responses", {
    method: "POST",
    body: JSON.stringify(req)
  }, env);
  return normalizeResponseResult(result);
}

function chatPayloadToResponses(payload, background) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const instructions = [];
  const input = [];

  for (const msg of messages) {
    const role = String(msg && msg.role || "user").toLowerCase();
    if (role === "system" || role === "developer") {
      const t = messageText(msg.content);
      if (t) instructions.push(t);
      continue;
    }
    input.push({
      role: role === "assistant" ? "assistant" : "user",
      content: messageContentToResponses(msg.content)
    });
  }

  const req = {
    model: String(payload.model || "gpt-5.4-mini"),
    input: input.length ? input : String(payload.input || ""),
    max_output_tokens: clampInt(payload.max_output_tokens || payload.max_completion_tokens || payload.max_tokens || 1200, 64, 8000)
  };
  if (instructions.length) req.instructions = instructions.join("\n\n");
  const format = responseFormatToTextFormat(payload.response_format);
  if (format) req.text = { format };
  if (background) {
    req.background = true;
    req.store = true;
  }
  return req;
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(p => p && (p.text || p.content || "")).filter(Boolean).join("\n");
  }
  return "";
}

function messageContentToResponses(content) {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  if (!Array.isArray(content)) return [{ type: "input_text", text: String(content || "") }];
  return content.map(part => {
    if (!part || typeof part !== "object") return null;
    if (part.type === "text") return { type: "input_text", text: String(part.text || "") };
    if (part.type === "image_url") {
      const image = part.image_url || {};
      return { type: "input_image", image_url: String(image.url || ""), detail: String(image.detail || "high") };
    }
    if (part.type === "input_text" || part.type === "input_image") return part;
    return { type: "input_text", text: String(part.text || part.content || "") };
  }).filter(Boolean);
}

function responseFormatToTextFormat(responseFormat) {
  if (!responseFormat || typeof responseFormat !== "object") return null;
  if (responseFormat.type === "json_schema") {
    const js = responseFormat.json_schema || {};
    return {
      type: "json_schema",
      name: String(js.name || "structured_output"),
      strict: js.strict === true,
      schema: js.schema || { type: "object", additionalProperties: true }
    };
  }
  if (responseFormat.type === "json_object") {
    return { type: "json_object" };
  }
  return null;
}

function geminiPayloadFromChat(payload) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const systemParts = [];
  const contents = [];
  for (const msg of messages) {
    const role = String(msg && msg.role || "user").toLowerCase();
    if (role === "system" || role === "developer") {
      const txt = messageText(msg.content);
      if (txt) systemParts.push({ text: txt });
      continue;
    }
    const parts = messageContentToGeminiParts(msg.content);
    if (parts.length) {
      contents.push({
        role: role === "assistant" ? "model" : "user",
        parts
      });
    }
  }
  if (!contents.length) {
    contents.push({ role: "user", parts: [{ text: String(payload.input || "") }] });
  }
  const req = {
    contents,
    generationConfig: geminiGenerationConfig(payload, wantsJson(payload))
  };
  if (systemParts.length) req.system_instruction = { parts: systemParts };
  return req;
}

function messageContentToGeminiParts(content) {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: String(content || "") }];
  return content.map(part => {
    if (!part || typeof part !== "object") return null;
    if (part.type === "text" || part.type === "input_text") {
      return { text: String(part.text || "") };
    }
    if (part.type === "image_url" || part.type === "input_image") {
      const src = part.image_url && part.image_url.url || part.image_url || part.image || part.url || "";
      const img = parseDataUrlImage(String(src || ""));
      if (img) return { inline_data: { mime_type: img.mime, data: img.data } };
    }
    return { text: String(part.text || part.content || "") };
  }).filter(Boolean);
}

function geminiGenerationConfig(payload, jsonMode) {
  const cfg = {
    maxOutputTokens: clampInt(payload.max_output_tokens || payload.max_completion_tokens || payload.max_tokens || 1200, 64, 8000)
  };
  if (jsonMode) cfg.responseMimeType = "application/json";
  if (payload.temperature !== undefined) {
    const temp = Number(payload.temperature);
    if (Number.isFinite(temp)) cfg.temperature = Math.max(0, Math.min(2, temp));
  }
  return cfg;
}

function wantsJson(payload) {
  const rf = payload && payload.response_format;
  if (rf && (rf.type === "json_object" || rf.type === "json_schema")) return true;
  return /\bjson\b/i.test(messageText(payload && payload.messages && payload.messages[0] && payload.messages[0].content || ""));
}

async function geminiJson(model, req, env) {
  const path = geminiModelPath(model);
  const resp = await fetch(`${GEMINI_BASE}/${path}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req)
  });
  const text = await resp.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) {
    throw new Error(`Gemini returned non-JSON (${resp.status})`);
  }
  if (!resp.ok) {
    const msg = data && data.error && data.error.message ? data.error.message : `Gemini HTTP ${resp.status}`;
    throw new Error(msg);
  }
  return data;
}

function geminiModelPath(model) {
  const m = String(model || DEFAULT_GEMINI_MODEL).replace(/^models\//, "");
  return `models/${encodeURIComponent(m)}`;
}

function normalizeGeminiResult(result, model) {
  const text = geminiText(result);
  return {
    status: "ok",
    type: "gemini",
    model: String(model || ""),
    data: {
      choices: [{
        message: { content: text },
        finish_reason: geminiFinishReason(result)
      }],
      usage: result.usageMetadata || null
    },
    message: ""
  };
}

function geminiText(result) {
  const candidates = result && Array.isArray(result.candidates) ? result.candidates : [];
  const parts = candidates[0] && candidates[0].content && Array.isArray(candidates[0].content.parts)
    ? candidates[0].content.parts
    : [];
  return parts.map(p => p && p.text ? String(p.text) : "").filter(Boolean).join("\n").trim();
}

function geminiFinishReason(result) {
  const candidates = result && Array.isArray(result.candidates) ? result.candidates : [];
  return String(candidates[0] && candidates[0].finishReason || "stop");
}

function claudePayloadFromChat(payload) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const system = [];
  const out = [];
  for (const msg of messages) {
    const role = String(msg && msg.role || "user").toLowerCase();
    if (role === "system" || role === "developer") {
      const txt = messageText(msg.content);
      if (txt) system.push(txt);
      continue;
    }
    const content = messageContentToClaude(msg.content);
    out.push({
      role: role === "assistant" ? "assistant" : "user",
      content
    });
  }
  if (!out.length) out.push({ role: "user", content: String(payload.input || "") });
  return {
    model: String(payload.model || DEFAULT_CLAUDE_MODEL),
    max_tokens: clampInt(payload.max_tokens || payload.max_completion_tokens || payload.max_output_tokens || 1200, 64, 8000),
    system: system.join("\n\n") || String(payload.system || ""),
    messages: out
  };
}

function messageContentToClaude(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content || "");
  const parts = content.map(part => {
    if (!part || typeof part !== "object") return null;
    if (part.type === "text" || part.type === "input_text") {
      return { type: "text", text: String(part.text || "") };
    }
    if (part.type === "image_url" || part.type === "input_image") {
      const src = part.image_url && part.image_url.url || part.image_url || part.image || part.url || "";
      const img = parseDataUrlImage(String(src || ""));
      if (img) return { type: "image", source: { type: "base64", media_type: img.mime, data: img.data } };
    }
    return { type: "text", text: String(part.text || part.content || "") };
  }).filter(Boolean);
  const hasImage = parts.some(p => p && p.type === "image");
  if (!hasImage) return parts.map(p => p.text || "").filter(Boolean).join("\n");
  return parts;
}

async function anthropicJson(path, body, env) {
  const resp = await fetch(ANTHROPIC_BASE + path, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const text = await resp.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) {
    throw new Error(`Claude returned non-JSON (${resp.status})`);
  }
  if (!resp.ok) {
    const msg = data && data.error && data.error.message ? data.error.message : `Claude HTTP ${resp.status}`;
    throw new Error(msg);
  }
  return data;
}

function normalizeClaudeResult(result, model) {
  const text = anthropicText(result);
  return {
    status: "ok",
    type: "claude",
    model: String(model || ""),
    data: {
      choices: [{
        message: { content: text },
        finish_reason: String(result && result.stop_reason || "stop")
      }],
      usage: result && result.usage || null
    },
    message: ""
  };
}

function anthropicText(result) {
  const content = result && Array.isArray(result.content) ? result.content : [];
  return content.map(p => p && p.type === "text" ? String(p.text || "") : "").filter(Boolean).join("\n").trim();
}

function parseDataUrlImage(src, fallbackMime) {
  const s = String(src || "");
  const m = s.match(/^data:([^;,]+);base64,(.+)$/i);
  if (m) return { mime: m[1] || fallbackMime || "image/jpeg", data: m[2] || "" };
  if (s && /^[A-Za-z0-9+/]+=*$/.test(s.slice(0, 80))) return { mime: fallbackMime || "image/jpeg", data: s };
  return null;
}

function responseLikeText(data) {
  try { return String(((((data || {}).choices || [])[0] || {}).message || {}).content || ""); }
  catch (_) { return ""; }
}

function extractJsonObject(text) {
  const raw = String(text || "").replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  if (!raw) throw new Error("empty_json_text");
  try { return JSON.parse(raw); } catch (_) {}
  const balanced = firstBalancedJson(raw, "{", "}");
  if (balanced) return JSON.parse(balanced);
  const arrStart = raw.indexOf("[");
  const arrEnd = raw.lastIndexOf("]");
  if (arrStart >= 0 && arrEnd > arrStart) return { items: JSON.parse(raw.slice(arrStart, arrEnd + 1)) };
  throw new Error("json_parse_failed");
}

function firstBalancedJson(raw, open, close) {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === open) {
      if (start < 0) start = i;
      depth++;
      continue;
    }
    if (ch === close && start >= 0) {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return "";
}

function nutritionProviderResult(source, text) {
  try {
    const p = sanitizeNutritionObject(extractJsonObject(text));
    return {
      source,
      status: "ok",
      calories: p.calories,
      protein: p.protein,
      carbs: p.carbs,
      fat: p.fat,
      fibre: p.fibre,
      satFat: p.satFat,
      sodium: p.sodium
    };
  } catch (err) {
    return { source, status: "error", message: String(err && err.message || err || "JSON parse failed") };
  }
}

function sanitizeNutritionObject(obj) {
  const o = obj && typeof obj === "object" ? Object.assign({}, obj) : {};
  o.name = String(o.name || o.food || o.item || "");
  o.serving = clampNumber(o.serving || o.amount || o.qty || 100, 0, 10000);
  o.unit = String(o.unit || o.serving_unit || "g");
  o.calories = Math.round(clampNumber(o.calories || o.kcal || o.cal, 0, 3000));
  o.protein = round1(clampNumber(o.protein || o.protein_g || o.prot, 0, 200));
  o.carbs = round1(clampNumber(o.carbs || o.carbs_g || o.carbohydrates, 0, 400));
  o.fat = round1(clampNumber(o.fat || o.fat_g || o.totalFat, 0, 200));
  o.fibre = round1(clampNumber(o.fibre || o.fiber || o.fibre_g || o.fiber_g, 0, 80));
  o.satFat = round1(Math.min(o.fat, clampNumber(o.satFat || o.saturatedFat || o.sat_fat || o.saturated_fat, 0, 200)));
  o.sodium = Math.round(clampNumber(o.sodium || o.sodium_mg || o.sod, 0, 12000));
  return o;
}

async function handleImageJson(body, env) {
  let fileId = "";
  try {
    const b64 = String(body.imageBase64 || body.b64 || "").replace(/^data:[^,]+,/, "");
    const prompt = String(body.prompt || "");
    if (!b64 || !prompt) {
      return { status: "error", errorCode: "missing_image_or_prompt", message: "Missing imageBase64 or prompt" };
    }
    const mime = String(body.mime || "image/jpeg");
    const model = String(body.model || "gpt-5.4-mini");
    const bytes = base64ToUint8Array(b64);
    const fd = new FormData();
    fd.append("purpose", "vision");
    fd.append("file", new File([bytes], "nutrition-photo.jpg", { type: mime }));

    const upload = await openaiJson("/files", {
      method: "POST",
      body: fd,
      skipContentType: true
    }, env);
    fileId = String(upload.id || "");
    if (!fileId) {
      return { status: "error", errorCode: "file_upload_failed", message: "OpenAI file upload did not return an id" };
    }

    const req = {
      model,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", file_id: fileId, detail: String(body.detail || "high") }
        ]
      }],
      max_output_tokens: clampInt(body.max_output_tokens || body.max_completion_tokens || body.max_tokens || 1800, 64, 6000),
      text: { format: { type: "json_object" } }
    };
    const result = await openaiJson("/responses", {
      method: "POST",
      body: JSON.stringify(req)
    }, env);
    return normalizeResponseResult(result);
  } finally {
    if (fileId) {
      try {
        await openaiJson(`/files/${encodeURIComponent(fileId)}`, { method: "DELETE" }, env);
      } catch (_) {}
    }
  }
}

async function openaiJson(path, opts, env) {
  const headers = Object.assign({
    Authorization: `Bearer ${env.OPENAI_API_KEY}`
  }, opts && opts.headers || {});
  if (!(opts && opts.skipContentType)) headers["Content-Type"] = "application/json";
  const resp = await fetch(OPENAI_BASE + path, Object.assign({}, opts || {}, { headers }));
  const text = await resp.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) {
    throw new Error(`OpenAI returned non-JSON (${resp.status})`);
  }
  if (!resp.ok) {
    const msg = data && data.error && data.error.message ? data.error.message : `OpenAI HTTP ${resp.status}`;
    const err = new Error(msg);
    err.openai = data;
    throw err;
  }
  return data;
}

function normalizeResponseResult(result) {
  const text = responseText(result);
  const terminal = result.status && !["queued", "in_progress"].includes(result.status);
  return {
    status: result.status === "failed" || result.status === "cancelled" ? "error" : "ok",
    type: "responses",
    responseId: String(result.id || ""),
    responseStatus: String(result.status || (terminal ? "completed" : "")),
    data: {
      choices: [{
        message: { content: text },
        finish_reason: String(result.status || "stop")
      }],
      responseId: String(result.id || ""),
      usage: result.usage || null
    },
    message: result.error && result.error.message ? String(result.error.message) : ""
  };
}

function responseText(result) {
  if (!result) return "";
  if (typeof result.output_text === "string") return result.output_text;
  const out = [];
  function walk(x) {
    if (!x) return;
    if (typeof x === "string") return;
    if (Array.isArray(x)) return x.forEach(walk);
    if (typeof x !== "object") return;
    if (x.type === "output_text" && typeof x.text === "string") out.push(x.text);
    if (typeof x.text === "string" && x.type !== "input_text") out.push(x.text);
    if (x.content) walk(x.content);
    if (x.output) walk(x.output);
  }
  walk(result.output);
  return out.join("\n").trim();
}

function base64ToUint8Array(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function clampInt(value, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function clampNumber(value, min, max) {
  const n = Number.parseFloat(String(value === undefined || value === null ? "" : value).replace(/,/g, ""));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function round1(value) {
  return Math.round((Number.parseFloat(value) || 0) * 10) / 10;
}
