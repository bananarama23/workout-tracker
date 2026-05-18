const TRACKER_DEFAULT_EMAIL = "phil.ksmith@gmail.com";
const TRACKER_MAX_TEXT = 22000;
const TRACKER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export function trackerHealth(env) {
  return {
    trackerRoutes: true,
    trackerEmailConfigured: !!(env && env.TRACKER_EMAIL),
    trackerBrowserConfigured: trackerBrowserConfigured(env),
    trackerBrowserRestConfigured: trackerBrowserRestConfigured(env)
  };
}

export async function handleTrackerRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);
  const method = request.method;
  if (!path.startsWith("/tracker/")) return null;
  if (!hasD1(env)) return err("d1_missing", "D1 DB binding is not configured. Tracker Watch needs the DB binding.", 500);
  await ensureTrackerSchema(env);

  if (method === "GET" && path === "/tracker/list") return ok(await trackerList(env));
  if (method === "GET" && path === "/tracker/alerts") return ok(await trackerAlerts(env));
  if (method === "GET" && path === "/tracker/settings") return ok(await trackerSettings(env));

  let body = {};
  if (method === "POST") {
    try { body = await request.json(); } catch (_) { body = {}; }
  }
  if (method === "GET") {
    body = Object.fromEntries(url.searchParams.entries());
  }
  if (method === "POST" && path === "/tracker/add") return ok(await trackerAdd(env, body));
  if (method === "POST" && path === "/tracker/update") return ok(await trackerUpdate(env, body));
  if (method === "POST" && path === "/tracker/delete") return ok(await trackerDelete(env, body));
  if (method === "POST" && path === "/tracker/check-now") return ok(await trackerCheckNow(env, body, ctx));
  if (method === "POST" && path === "/tracker/alerts/seen") return ok(await trackerAlertsSeen(env, body));
  if (method === "POST" && path === "/tracker/settings") return ok(await trackerSettingsSave(env, body));
  return err("tracker_route_not_found", "Unknown Tracker Watch route", 404);
}

export async function handleTrackerScheduled(env, ctx) {
  if (!hasD1(env)) return { status: "ok", skipped: true, reason: "d1_missing" };
  await ensureTrackerSchema(env);
  const rows = await env.DB.prepare("SELECT * FROM tracker_items WHERE enabled = 1 ORDER BY created_at ASC").all();
  const items = rows && Array.isArray(rows.results) ? rows.results : [];
  const due = items.filter(item => trackerIsDue(item));
  const out = [];
  for (const item of due.slice(0, 12)) {
    try {
      out.push(await runTrackerCheck(env, item, ctx || {}, "scheduled"));
    } catch (e) {
      out.push({ itemId: item.id, status: "error", message: String(e && e.message || e || "tracker check failed") });
    }
  }
  return { status: "ok", type: "tracker-scheduled", checked: out.length, results: out };
}

async function ensureTrackerSchema(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS tracker_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      label TEXT,
      url TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      check_frequency TEXT DEFAULT 'daily',
      last_checked_at TEXT,
      created_at TEXT NOT NULL
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS tracker_snapshots (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      title TEXT,
      price TEXT,
      status TEXT,
      raw_summary TEXT,
      checked_at TEXT NOT NULL
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS tracker_alerts (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      source TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      title TEXT,
      old_value TEXT,
      new_value TEXT,
      message TEXT,
      created_at TEXT NOT NULL,
      seen_at TEXT
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS tracker_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_tracker_items_enabled ON tracker_items (enabled, kind, last_checked_at)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_tracker_snapshots_item_checked ON tracker_snapshots (item_id, checked_at)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_tracker_alerts_seen_created ON tracker_alerts (seen_at, created_at)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_tracker_alerts_item_created ON tracker_alerts (item_id, created_at)").run();
}

async function trackerList(env) {
  const itemsRes = await env.DB.prepare(`
    SELECT i.*,
      (SELECT title FROM tracker_snapshots s WHERE s.item_id = i.id ORDER BY checked_at DESC LIMIT 1) AS current_title,
      (SELECT price FROM tracker_snapshots s WHERE s.item_id = i.id ORDER BY checked_at DESC LIMIT 1) AS current_price,
      (SELECT status FROM tracker_snapshots s WHERE s.item_id = i.id ORDER BY checked_at DESC LIMIT 1) AS current_status,
      (SELECT raw_summary FROM tracker_snapshots s WHERE s.item_id = i.id ORDER BY checked_at DESC LIMIT 1) AS current_summary
    FROM tracker_items i
    ORDER BY created_at DESC
  `).all();
  const snapRes = await env.DB.prepare(`
    SELECT item_id, title, price, status, raw_summary, checked_at
    FROM tracker_snapshots
    ORDER BY checked_at DESC
    LIMIT 240
  `).all();
  const historyByItem = buildTrackerHistory(snapRes.results || []);
  const items = (itemsRes.results || []).map(item => Object.assign({}, item, {
    price_history: historyByItem[item.id] || []
  }));
  const alertsRes = await env.DB.prepare(`
    SELECT a.*, i.label, i.kind, i.url
    FROM tracker_alerts a
    LEFT JOIN tracker_items i ON i.id = a.item_id
    ORDER BY a.created_at DESC
    LIMIT 25
  `).all();
  return {
    type: "tracker-list",
    items,
    alerts: alertsRes.results || [],
    settings: await trackerSettings(env)
  };
}

function buildTrackerHistory(rows) {
  const grouped = {};
  for (const row of rows || []) {
    const itemId = String(row.item_id || "");
    if (!itemId) continue;
    if (!grouped[itemId]) grouped[itemId] = [];
    grouped[itemId].push(row);
  }
  const out = {};
  for (const itemId of Object.keys(grouped)) {
    const chronological = grouped[itemId].slice().sort((a, b) => String(a.checked_at || "").localeCompare(String(b.checked_at || "")));
    const changes = [];
    let lastKey = "";
    for (const row of chronological) {
      const price = clean(row.price || "");
      const status = normalizeStatus(row.status || "");
      const title = clean(row.title || "");
      const summary = clean(row.raw_summary || "");
      const key = [price, status, title].join("|");
      if (!price && status === "unknown" && !title) continue;
      if (key === lastKey) continue;
      lastKey = key;
      changes.push({
        title,
        price,
        status,
        summary,
        checked_at: row.checked_at || ""
      });
    }
    out[itemId] = changes.reverse().slice(0, 12);
  }
  return out;
}

async function trackerAdd(env, body) {
  const input = String(body && (body.url || body.query || body.address) || "").trim();
  const parsed = safeUrl(input);
  const kind = parsed ? trackerKind(parsed.href) : trackerKindFromQuery(input);
  if (!input) throw statusError("invalid_tracker_input", "Enter a Costco URL, home listing URL, or house address.", 400);
  if (!kind) throw statusError("unsupported_tracker_url", "Tracker Watch supports Costco URLs and house addresses or listing URLs.", 400);
  const settings = await trackerSettings(env);
  const frequency = String(body.check_frequency || body.frequency || defaultFrequencyForKind(kind, settings) || "daily");
  const now = new Date().toISOString();
  const id = makeId("trk");
  const storedUrl = parsed ? parsed.href : `address:${input}`;
  const label = String(body.label || (!parsed && input) || "").trim().slice(0, 160);
  await env.DB.prepare(`
    INSERT INTO tracker_items (id, kind, label, url, enabled, check_frequency, created_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `).bind(id, kind, label, storedUrl, frequency, now).run();
  return { type: "tracker-add", id, kind };
}

async function trackerDelete(env, body) {
  let id = trackerIdFromBody(body);
  const url = String(body && body.url || "").trim();
  if (!id && url) {
    const row = await env.DB.prepare("SELECT id FROM tracker_items WHERE url = ? LIMIT 1").bind(url).first();
    id = row && row.id ? String(row.id) : "";
  }
  if (!id) throw statusError("missing_tracker_id", "Missing tracker item id.", 400);
  await env.DB.prepare("DELETE FROM tracker_alerts WHERE item_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM tracker_snapshots WHERE item_id = ?").bind(id).run();
  const byId = await env.DB.prepare("DELETE FROM tracker_items WHERE id = ?").bind(id).run();
  let deleted = d1Changes(byId);
  if (deleted <= 0 && url) {
    const matches = await env.DB.prepare("SELECT id FROM tracker_items WHERE url = ?").bind(url).all();
    const ids = (matches.results || []).map(row => String(row.id || "")).filter(Boolean);
    for (const matchId of ids) {
      await env.DB.prepare("DELETE FROM tracker_alerts WHERE item_id = ?").bind(matchId).run();
      await env.DB.prepare("DELETE FROM tracker_snapshots WHERE item_id = ?").bind(matchId).run();
    }
    const byUrl = await env.DB.prepare("DELETE FROM tracker_items WHERE url = ?").bind(url).run();
    deleted = d1Changes(byUrl);
  }
  return { type: "tracker-delete", id, deleted };
}

async function trackerUpdate(env, body) {
  const id = trackerIdFromBody(body);
  if (!id) throw statusError("missing_tracker_id", "Missing tracker item id.", 400);
  const item = await env.DB.prepare("SELECT * FROM tracker_items WHERE id = ? LIMIT 1").bind(id).first();
  if (!item) throw statusError("tracker_item_missing", "Tracker item was not found.", 404);
  const enabled = body.enabled === undefined ? Number(item.enabled) !== 0 : !!body.enabled;
  const label = body.label === undefined ? String(item.label || "") : String(body.label || "").trim().slice(0, 160);
  const frequency = body.check_frequency === undefined ? String(item.check_frequency || "daily") : String(body.check_frequency || "daily").trim();
  await env.DB.prepare("UPDATE tracker_items SET enabled = ?, label = ?, check_frequency = ? WHERE id = ?").bind(enabled ? 1 : 0, label, frequency, id).run();
  return { type: "tracker-update", id, enabled: enabled ? 1 : 0 };
}

async function trackerCheckNow(env, body, ctx) {
  const id = trackerIdFromBody(body);
  if (!id) throw statusError("missing_tracker_id", "Missing tracker item id.", 400);
  const item = await env.DB.prepare("SELECT * FROM tracker_items WHERE id = ? LIMIT 1").bind(id).first();
  if (!item) throw statusError("tracker_item_missing", "Tracker item was not found.", 404);
  const enabled = body.enabled;
  if (enabled !== undefined) {
    await env.DB.prepare("UPDATE tracker_items SET enabled = ? WHERE id = ?").bind(enabled ? 1 : 0, id).run();
    item.enabled = enabled ? 1 : 0;
  }
  return await runTrackerCheck(env, item, ctx || {}, "manual");
}

async function trackerAlerts(env) {
  const rows = await env.DB.prepare(`
    SELECT a.*, i.label, i.kind, i.url
    FROM tracker_alerts a
    LEFT JOIN tracker_items i ON i.id = a.item_id
    ORDER BY a.created_at DESC
    LIMIT 50
  `).all();
  return {
    type: "tracker-alerts",
    alerts: rows.results || [],
    unseenCount: (rows.results || []).filter(a => !a.seen_at).length
  };
}

async function trackerAlertsSeen(env, body) {
  const now = new Date().toISOString();
  const ids = Array.isArray(body && body.ids) ? body.ids.map(x => String(x || "").trim()).filter(Boolean) : [];
  if (ids.length) {
    for (const id of ids.slice(0, 100)) {
      await env.DB.prepare("UPDATE tracker_alerts SET seen_at = COALESCE(seen_at, ?) WHERE id = ?").bind(now, id).run();
    }
  } else {
    await env.DB.prepare("UPDATE tracker_alerts SET seen_at = COALESCE(seen_at, ?) WHERE seen_at IS NULL").bind(now).run();
  }
  return { type: "tracker-alerts-seen", seenAt: now };
}

async function trackerSettings(env) {
  const rows = await env.DB.prepare("SELECT key, value FROM tracker_settings").all();
  const map = {};
  for (const row of rows.results || []) map[row.key] = row.value;
  return {
    zillow_frequency: map.zillow_frequency || "2h",
    costco_frequency: map.costco_frequency || "twice_daily",
    email_alerts: map.email_alerts || "on",
    alert_email: map.alert_email || TRACKER_DEFAULT_EMAIL
  };
}

async function trackerSettingsSave(env, body) {
  const allowed = {
    zillow_frequency: new Set(["1h", "2h", "3h", "daily"]),
    costco_frequency: new Set(["6h", "twice_daily", "daily"]),
    email_alerts: new Set(["on", "off"]),
    alert_email: null
  };
  for (const key of Object.keys(allowed)) {
    if (!Object.prototype.hasOwnProperty.call(body || {}, key)) continue;
    let value = String(body[key] || "").trim();
    if (key === "alert_email") value = value.slice(0, 180) || TRACKER_DEFAULT_EMAIL;
    else if (!allowed[key].has(value)) continue;
    await env.DB.prepare(`
      INSERT INTO tracker_settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).bind(key, value).run();
  }
  return { type: "tracker-settings", settings: await trackerSettings(env) };
}

async function runTrackerCheck(env, item, ctx, source) {
  const now = new Date().toISOString();
  const fetched = await fetchVisibleText(item.url, env);
  let extractError = "";
  let snap = {
    title: item.label || item.url || "",
    price: "",
    status: "unknown",
    summary: fetched.summary || "checked"
  };
  if (!env.OPENAI_API_KEY) {
    extractError = "OPENAI_API_KEY missing; fetched page but could not extract price/status.";
    snap.summary = [snap.summary, extractError].filter(Boolean).join("; ");
  } else {
    try {
      snap = await extractTrackerSnapshotWithFallback(env, item, fetched, ctx);
    } catch (err) {
      extractError = String(err && err.message || err || "extract failed");
      snap.summary = [fetched.summary || "", "extract_failed: " + extractError].filter(Boolean).join("; ");
    }
  }
  const prev = await env.DB.prepare(`
    SELECT * FROM tracker_snapshots
    WHERE item_id = ?
    ORDER BY checked_at DESC
    LIMIT 1
  `).bind(item.id).first();
  const snapshotId = makeId("snap");
  await env.DB.prepare(`
    INSERT INTO tracker_snapshots (id, item_id, title, price, status, raw_summary, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    snapshotId,
    item.id,
    snap.title || "",
    snap.price || "",
    snap.status || "unknown",
    snap.summary || fetched.summary || "",
    now
  ).run();
  await env.DB.prepare("UPDATE tracker_items SET last_checked_at = ? WHERE id = ?").bind(now, item.id).run();
  const alerts = await createAlertsForChanges(env, item, prev, snap, source, now);
  if (alerts.length) {
    const settings = await trackerSettings(env);
    if (settings.email_alerts !== "off") {
      const emailJobs = alerts.map(alert => sendTrackerEmail(env, settings, item, alert).catch(() => null));
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(Promise.all(emailJobs));
      else await Promise.all(emailJobs);
    }
  }
  return {
    type: "tracker-check-now",
    itemId: item.id,
    snapshotId,
    checkedAt: now,
    title: snap.title || "",
    price: snap.price || "",
    itemStatus: snap.status || "unknown",
    summary: snap.summary || "",
    extractionError: extractError,
    alertsCreated: alerts.length,
    fetchMode: fetched.mode,
    browserRenderingAvailable: fetched.browserRenderingAvailable
  };
}

async function extractTrackerSnapshotWithFallback(env, item, fetched, ctx) {
  const homeListing = item.kind === "zillow" || item.kind === "property";
  if (homeListing) {
    try { return await extractPropertyViaWebSearch(env, item, fetched, ctx); } catch (_) {}
  }
  const shouldSearch = homeListing && (trackerAccessDeniedText(fetched.text) || String(fetched.text || "").length < 500);
  if (shouldSearch) {
    try {
      return await extractPropertyViaWebSearch(env, item, fetched, ctx);
    } catch (searchErr) {
      try {
        const snap = await extractSnapshot(env, item, fetched, ctx);
        snap.summary = [snap.summary, "web_search_failed: " + String(searchErr && searchErr.message || searchErr || "")].filter(Boolean).join("; ");
        return snap;
      } catch (_) {
        throw searchErr;
      }
    }
  }
  try {
    const snap = await extractSnapshot(env, item, fetched, ctx);
    if (homeListing && trackerSnapshotNeedsSearch(snap)) {
      try { return await extractPropertyViaWebSearch(env, item, fetched, ctx); } catch (_) {}
    }
    return snap;
  } catch (err) {
    if (homeListing) return await extractPropertyViaWebSearch(env, item, fetched, ctx);
    throw err;
  }
}

async function extractPropertyViaWebSearch(env, item, fetched, ctx) {
  const query = propertySearchQuery(item);
  const prompt = [
    "Search the public web for the current real estate listing represented by this URL/address.",
    "Use any reliable public listing source you can find, such as Realtor.com, Redfin, Homes.com, Compass, Trulia, brokerage/MLS pages, or the original URL if available.",
    "Return strict JSON only with this exact shape: {\"title\":\"\",\"price\":\"\",\"status\":\"unknown\",\"summary\":\"\"}.",
    "For status use active, pending, sold, off_market, or unknown. Do not guess a price; leave it empty if not found.",
    "Include the source site/date hint in summary when visible.",
    "URL/address/query:",
    query,
    "Direct fetch summary:",
    fetched.summary || "",
    "Direct fetch visible text:",
    String(fetched.text || "").slice(0, 1200)
  ].join("\n");
  const result = await openaiWebSearchJson(env, prompt, ctx);
  const parsed = parseStrictJson(responseText(result));
  if (!parsed) throw statusError("tracker_bad_search_json", "Web search returned unreadable JSON.", 502);
  return {
    title: clean(parsed.title || parsed.address || ""),
    price: clean(parsed.price || ""),
    status: normalizeStatus(parsed.status || ""),
    summary: clean(parsed.summary || "OpenAI web search fallback")
  };
}

async function createAlertsForChanges(env, item, prev, snap, source, now) {
  if (!prev) return [];
  const changes = [];
  addChange(changes, "price", prev.price, snap.price);
  addChange(changes, "status", prev.status, snap.status);
  addChange(changes, "title", prev.title, snap.title);
  const alerts = [];
  for (const c of changes) {
    const alert = {
      id: makeId("alert"),
      itemId: item.id,
      source,
      alertType: c.type,
      title: snap.title || item.label || item.url,
      oldValue: c.oldValue,
      newValue: c.newValue,
      message: trackerAlertMessage(item, c, snap),
      createdAt: now
    };
    await env.DB.prepare(`
      INSERT INTO tracker_alerts (id, item_id, source, alert_type, title, old_value, new_value, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(alert.id, alert.itemId, alert.source, alert.alertType, alert.title, alert.oldValue, alert.newValue, alert.message, alert.createdAt).run();
    alerts.push(alert);
  }
  return alerts;
}

function addChange(out, type, oldValue, newValue) {
  const oldNorm = normalizeValue(oldValue);
  const newNorm = normalizeValue(newValue);
  if (!newNorm || oldNorm === newNorm) return;
  if (type === "title" && oldNorm && similarity(oldNorm, newNorm) > 0.9) return;
  out.push({ type, oldValue: String(oldValue || ""), newValue: String(newValue || "") });
}

async function fetchVisibleText(url, env) {
  let text = "";
  let summary = "";
  try {
    const resp = await fetch(url, {
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": TRACKER_USER_AGENT
      }
    });
    const html = await resp.text();
    text = htmlToVisibleText(html);
    summary = `fetch_http_${resp.status}`;
  } catch (e) {
    summary = `fetch_failed: ${String(e && e.message || e || "unknown")}`;
  }
  const blocked = trackerAccessDeniedText(text);
  const browserRenderingAvailable = trackerBrowserConfigured(env);
  if (text.length < 500 || blocked) {
    const rendered = await fetchRenderedText(url, env);
    if (rendered.text && rendered.text.length > text.length && !trackerAccessDeniedText(rendered.text)) {
      return {
        mode: rendered.mode,
        text: rendered.text.slice(0, TRACKER_MAX_TEXT),
        summary: [summary, rendered.summary].filter(Boolean).join("; "),
        browserRenderingAvailable: true
      };
    }
    summary = [summary, rendered.summary].filter(Boolean).join("; ");
  }
  if (trackerAccessDeniedText(text)) {
    summary += "; source_blocked_access_denied";
  }
  if ((text.length < 500 || trackerAccessDeniedText(text)) && !browserRenderingAvailable) {
    summary += "; browser_rendering_unavailable_configure_CLOUDFLARE_ACCOUNT_ID_and_CLOUDFLARE_BROWSER_RENDERING_TOKEN";
  }
  return {
    mode: text.length >= 500 && !trackerAccessDeniedText(text) ? "fetch" : "fetch_limited",
    text: (text || summary).slice(0, TRACKER_MAX_TEXT),
    summary,
    browserRenderingAvailable
  };
}

async function fetchRenderedText(url, env) {
  if (trackerBrowserRestConfigured(env)) {
    const markdown = await fetchRenderedRest(url, env, "markdown");
    if (markdown.text && !trackerAccessDeniedText(markdown.text)) return markdown;
    const content = await fetchRenderedRest(url, env, "content");
    if (content.text && content.text.length > (markdown.text || "").length) {
      return {
        mode: "browser_rendering_content_rest",
        text: htmlToVisibleText(content.text),
        summary: [markdown.summary, content.summary].filter(Boolean).join("; ")
      };
    }
    return markdown.text ? markdown : content;
  }
  if (trackerBrowserConfigured(env)) {
    return { mode: "browser_rendering_binding", text: "", summary: "browser_rendering_binding_present_but_runtime_adapter_missing" };
  }
  return { mode: "none", text: "", summary: "browser_rendering_not_configured" };
}

async function fetchRenderedRest(url, env, endpoint) {
  const accountId = String(env.CLOUDFLARE_ACCOUNT_ID || env.CF_ACCOUNT_ID || "").trim();
  const token = String(env.CLOUDFLARE_BROWSER_RENDERING_TOKEN || env.CF_BROWSER_RENDERING_TOKEN || env.CLOUDFLARE_API_TOKEN || "").trim();
  if (!accountId || !token) return { mode: `browser_rendering_${endpoint}_rest`, text: "", summary: "browser_rendering_rest_missing_account_or_token" };
  try {
    const resp = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/browser-rendering/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        url,
        userAgent: TRACKER_USER_AGENT,
        gotoOptions: { waitUntil: "networkidle2", timeout: 20000 }
      })
    });
    const raw = await resp.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (_) {}
    if (!resp.ok || !data || data.success === false) {
      const msg = data && data.errors && data.errors[0] && data.errors[0].message ? data.errors[0].message : `HTTP ${resp.status}`;
      return { mode: `browser_rendering_${endpoint}_rest`, text: "", summary: `browser_rendering_${endpoint}_failed: ${msg}` };
    }
    const result = data.result;
    const rendered = typeof result === "string" ? result : JSON.stringify(result || "");
    return { mode: `browser_rendering_${endpoint}_rest`, text: rendered, summary: `browser_rendering_${endpoint}_ok` };
  } catch (err) {
    return { mode: `browser_rendering_${endpoint}_rest`, text: "", summary: `browser_rendering_${endpoint}_failed: ${String(err && err.message || err || "unknown")}` };
  }
}

async function extractSnapshot(env, item, fetched, ctx) {
  const prompt = trackerPrompt(item.kind, item.url, fetched.text);
  const result = await openaiResponsesJson(env, prompt, ctx);
  const parsed = parseStrictJson(responseText(result));
  if (!parsed) throw statusError("tracker_bad_ai_json", "Tracker AI extractor returned unreadable JSON.", 502);
  return {
    title: clean(parsed.title || parsed.address || ""),
    price: clean(parsed.price || ""),
    status: normalizeStatus(parsed.status || ""),
    summary: clean(parsed.summary || parsed.raw_summary || fetched.summary || "")
  };
}

async function openaiResponsesJson(env, prompt, ctx) {
  const payload = {
    model: String(env.TRACKER_OPENAI_MODEL || env.OPENAI_MODEL || "gpt-4.1-mini"),
    input: [
      { role: "system", content: "Return strict JSON only. No markdown, prose, or comments." },
      { role: "user", content: prompt }
    ],
    text: { format: { type: "json_object" } },
    max_output_tokens: 700
  };
  if (ctx && typeof ctx.openaiJson === "function") {
    return await ctx.openaiJson("/responses", {
      method: "POST",
      body: JSON.stringify(payload)
    }, env);
  }
  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`
    },
    body: JSON.stringify(payload)
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw statusError("tracker_openai_error", data && data.error && data.error.message ? data.error.message : `OpenAI HTTP ${resp.status}`, 502);
  return data;
}

async function openaiWebSearchJson(env, prompt, ctx) {
  const payload = {
    model: String(env.TRACKER_SEARCH_MODEL || env.TRACKER_OPENAI_MODEL || env.OPENAI_MODEL || "gpt-4.1-mini"),
    tools: [{ type: "web_search" }],
    tool_choice: "auto",
    input: [
      { role: "system", content: "Use web search when needed. Return strict JSON only, no markdown or prose." },
      { role: "user", content: prompt }
    ],
    text: { format: { type: "json_object" } },
    max_output_tokens: 900
  };
  try {
    if (ctx && typeof ctx.openaiJson === "function") {
      return await ctx.openaiJson("/responses", {
        method: "POST",
        body: JSON.stringify(payload)
      }, env);
    }
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`
      },
      body: JSON.stringify(payload)
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw statusError("tracker_openai_search_error", data && data.error && data.error.message ? data.error.message : `OpenAI HTTP ${resp.status}`, 502);
    return data;
  } catch (err) {
    const msg = String(err && err.message || err || "");
    if (!/web_search/i.test(msg)) throw err;
    const fallback = Object.assign({}, payload, { tools: [{ type: "web_search_preview", search_context_size: "medium" }] });
    if (ctx && typeof ctx.openaiJson === "function") {
      return await ctx.openaiJson("/responses", {
        method: "POST",
        body: JSON.stringify(fallback)
      }, env);
    }
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`
      },
      body: JSON.stringify(fallback)
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw statusError("tracker_openai_search_error", data && data.error && data.error.message ? data.error.message : `OpenAI HTTP ${resp.status}`, 502);
    return data;
  }
}

function trackerPrompt(kind, url, text) {
  const fields = kind === "zillow"
    ? "title/address, price, status (active, pending, sold, off_market, unknown), summary including any visible price change or listing note"
    : kind === "property"
      ? "property title/address, listing price, status (active, pending, sold, off_market, unknown), summary including any visible price change or listing note"
    : "product title, price, status (in_stock, out_of_stock, unknown), summary including obvious promo text";
  return [
    `You are extracting a ${kind} tracker snapshot from visible page text.`,
    `URL: ${url}`,
    `Extract: ${fields}.`,
    "Return exactly this JSON shape: {\"title\":\"\",\"price\":\"\",\"status\":\"unknown\",\"summary\":\"\"}.",
    "If a field is not visible, use an empty string or unknown status. Do not guess.",
    "Visible text:",
    text || ""
  ].join("\n");
}

async function sendTrackerEmail(env, settings, item, alert) {
  const binding = env && env.TRACKER_EMAIL;
  if (!binding || typeof binding.send !== "function") return { skipped: true, reason: "send_email_missing" };
  const to = String(settings.alert_email || TRACKER_DEFAULT_EMAIL).trim() || TRACKER_DEFAULT_EMAIL;
  const subject = `Tracker Watch: ${alert.alertType} changed`;
  const body = `${alert.message}\n\n${item.url}`;
  try {
    if (typeof EmailMessage !== "undefined") {
      await binding.send(new EmailMessage("tracker-watch@plusultra.local", to, rawEmail(to, subject, body)));
    } else {
      await binding.send({ to, subject, text: body });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String(e && e.message || e || "email failed") };
  }
}

function rawEmail(to, subject, body) {
  return [
    `To: ${to}`,
    "From: tracker-watch@plusultra.local",
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body
  ].join("\r\n");
}

function trackerIsDue(item) {
  const last = Date.parse(item.last_checked_at || "");
  if (!Number.isFinite(last) || last <= 0) return true;
  return Date.now() - last >= frequencyMs(item.check_frequency || defaultFrequencyForKind(item.kind));
}

function frequencyMs(value) {
  const v = String(value || "").trim();
  if (v === "1h") return 3600000;
  if (v === "2h") return 2 * 3600000;
  if (v === "3h") return 3 * 3600000;
  if (v === "6h") return 6 * 3600000;
  if (v === "twice_daily") return 12 * 3600000;
  return 24 * 3600000;
}

function defaultFrequencyForKind(kind, settings) {
  if (kind === "zillow" || kind === "property") return settings && settings.zillow_frequency || "2h";
  if (kind === "costco") return settings && settings.costco_frequency || "twice_daily";
  return "daily";
}

function trackerKind(url) {
  const host = safeUrl(url) && safeUrl(url).hostname.toLowerCase();
  if (!host) return "";
  if (host.includes("costco.")) return "costco";
  if (host.includes("zillow.")) return "zillow";
  if (host.includes("redfin.") || host.includes("realtor.") || host.includes("homes.") || host.includes("compass.") || host.includes("trulia.") || host.includes("properties.")) return "property";
  return "";
}

function trackerKindFromQuery(input) {
  const s = String(input || "").trim();
  if (!s) return "";
  if (/\d+.+\b(?:st|street|ave|avenue|rd|road|dr|drive|ct|court|ln|lane|way|blvd|circle|cir|place|pl)\b/i.test(s)) return "property";
  if (/\b(?:las vegas|henderson|north las vegas|nv|ca|az|ut|tx|fl|home|house|property)\b/i.test(s) && /\d/.test(s)) return "property";
  return "";
}

function propertySearchQuery(item) {
  const rawUrl = String(item && item.url || "");
  if (/^address:/i.test(rawUrl)) return rawUrl.replace(/^address:/i, "").trim();
  let fromPath = "";
  try {
    const u = new URL(rawUrl);
    fromPath = decodeURIComponent((u.pathname || "")
      .replace(/[_/]+/g, " ")
      .replace(/\b(?:homedetails|realestateandhomes-detail|home|property|for-sale)\b/ig, " ")
      .replace(/\b(?:zpid|mls|pid|m)[a-z0-9-]*\b/ig, " ")
      .replace(/\s+/g, " ")
      .trim());
  } catch (_) {}
  return [String(item && item.label || "").trim(), fromPath, rawUrl]
    .filter(Boolean)
    .join(" | ")
    .slice(0, 1200);
}

function normalizeStatus(value) {
  const s = String(value || "").toLowerCase().replace(/[^a-z_ ]+/g, " ").trim();
  if (/(out of stock|sold out|unavailable)/.test(s)) return "out_of_stock";
  if (/(in stock|available|add to cart)/.test(s)) return "in_stock";
  if (/pending/.test(s)) return "pending";
  if (/sold/.test(s)) return "sold";
  if (/(off market|off_market)/.test(s)) return "off_market";
  if (/active/.test(s)) return "active";
  return s ? s.replace(/\s+/g, "_").slice(0, 40) : "unknown";
}

function trackerAlertMessage(item, change, snap) {
  const name = snap.title || item.label || item.url;
  const label = trackerAlertShortLabel(change);
  return `${label} · ${name}`;
}

function trackerAlertShortLabel(change) {
  if (!change) return "Tracker changed";
  if (change.type === "price") {
    const oldPrice = moneyNumber(change.oldValue);
    const newPrice = moneyNumber(change.newValue);
    if (Number.isFinite(oldPrice) && Number.isFinite(newPrice)) {
      const delta = newPrice - oldPrice;
      if (delta !== 0) return `Price ${delta > 0 ? "+" : "-"}${formatMoney(Math.abs(delta))} (${formatMoney(newPrice)})`;
    }
    return `Price ${change.oldValue || "unknown"} -> ${change.newValue || "unknown"}`;
  }
  if (change.type === "status") {
    const next = normalizeStatus(change.newValue || "");
    if (next === "sold") return "Now sold";
    if (next === "pending") return "Now pending";
    if (next === "active") return "Back active";
    if (next === "off_market") return "Now off market";
    if (next === "out_of_stock") return "Now out of stock";
    if (next === "in_stock") return "Back in stock";
    return `Status ${String(change.newValue || "unknown").replace(/_/g, " ")}`;
  }
  if (change.type === "title") return "Listing details changed";
  return "Tracker changed";
}

function moneyNumber(value) {
  const raw = String(value || "").replace(/[^0-9.]/g, "");
  if (!raw) return NaN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

function formatMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "$0";
  return "$" + Math.round(n).toLocaleString("en-US");
}

function htmlToVisibleText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function trackerAccessDeniedText(text) {
  const s = String(text || "").toLowerCase();
  return /(?:access to this page has been denied|access denied|request blocked|forbidden|captcha|verify you are human|unusual traffic|bot detection|are you a robot|enable cookies|pardon our interruption)/i.test(s);
}

function trackerSnapshotNeedsSearch(snap) {
  if (!snap) return true;
  const combined = [snap.title, snap.price, snap.status, snap.summary].join(" ");
  if (trackerAccessDeniedText(combined)) return true;
  return !String(snap.price || "").trim() && normalizeStatus(snap.status || "") === "unknown";
}

function trackerBrowserConfigured(env) {
  return !!(env && (env.BROWSER || env.MYBROWSER || env.BROWSER_RENDERING || trackerBrowserRestConfigured(env)));
}

function trackerBrowserRestConfigured(env) {
  return !!(env && String(env.CLOUDFLARE_ACCOUNT_ID || env.CF_ACCOUNT_ID || "").trim() &&
    String(env.CLOUDFLARE_BROWSER_RENDERING_TOKEN || env.CF_BROWSER_RENDERING_TOKEN || env.CLOUDFLARE_API_TOKEN || "").trim());
}

function responseText(result) {
  if (!result) return "";
  if (typeof result.output_text === "string") return result.output_text;
  const out = [];
  const walk = value => {
    if (!value) return;
    if (typeof value === "string") { out.push(value); return; }
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (typeof value === "object") {
      if (typeof value.text === "string") out.push(value.text);
      if (typeof value.content === "string") out.push(value.content);
      else if (Array.isArray(value.content)) value.content.forEach(walk);
      if (Array.isArray(value.output)) value.output.forEach(walk);
    }
  };
  walk(result.output);
  return out.join("\n").trim();
}

function parseStrictJson(text) {
  try { return JSON.parse(String(text || "").trim()); } catch (_) {}
  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch (_) { return null; }
}

function safeUrl(value) {
  try {
    const u = new URL(String(value || "").trim());
    if (!/^https?:$/i.test(u.protocol)) return null;
    return u;
  } catch (_) {
    return null;
  }
}

function normalizePath(pathname) {
  const path = String(pathname || "/");
  let out = path;
  if (out === "/api") out = "/";
  else if (out.indexOf("/api/") === 0) out = out.slice(4) || "/";
  if (out.indexOf("/v1/tracker/") === 0) out = out.slice(3);
  if (out.length > 1) out = out.replace(/\/+$/g, "");
  return out;
}

function trackerIdFromBody(body) {
  return String(
    body && (body.id || body.itemId || body.item_id || body.trackerId || body.tracker_id) || ""
  ).trim();
}

function normalizeValue(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function similarity(a, b) {
  if (!a || !b) return 0;
  const aa = new Set(a.split(" "));
  const bb = new Set(b.split(" "));
  let hit = 0;
  aa.forEach(x => { if (bb.has(x)) hit++; });
  return hit / Math.max(aa.size, bb.size, 1);
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function d1Changes(result) {
  const n = result && result.meta && Number(result.meta.changes);
  return Number.isFinite(n) ? n : 0;
}

function hasD1(env) {
  return !!(env && env.DB && typeof env.DB.prepare === "function");
}

function makeId(prefix) {
  const rand = crypto && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return `${prefix}_${rand}`;
}

function ok(data) {
  return Object.assign({ status: "ok" }, data || {});
}

function err(errorCode, message, status) {
  return { status: "error", errorCode, message, httpStatus: status || 500 };
}

function statusError(errorCode, message, status) {
  const e = new Error(message);
  e.errorCode = errorCode;
  e.httpStatus = status || 500;
  return e;
}
