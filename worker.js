/**
 * RentalComp Intelligence — Cloudflare Worker
 *
 * Changelog:
 * *   v2.10 2026-04-15  /admin/update-lead: writes jiraUrl field to existing KV key record
 *                     // Commit: add update-lead endpoint for Jira URL tracking
 *   v2.9  2026-04-10  Email notifications via Cloudflare Email Routing send binding:
 *                     - /request-access: sends email to NOTIFY_EMAIL when new request comes in
 *                     - /log-search: sends email to NOTIFY_EMAIL when user hits their limit
 *                     Requires wrangler.toml send_email binding + Email Routing enabled.
 *                     See DEPLOY.md for setup instructions.
 *                     // Commit: add email notifications for access requests and limit hits
 *   v2.8  2026-04-09  In-session limit enforcement: /rentcast/avm/rent/long-term checks limit
 *                     BEFORE proxying. Returns 429 {error:'limit_reached'} if over addressLimit.
 *                     // Commit: enforce search limit server-side before proxying Rentcast call
 *   v2.7  2026-04-09  Demo address skip list in log-search
 *   v2.6  2026-04-08  Magic link returns just the key
 *   v2.5  2026-04-08  Dedup on propertyId
 *   v2.4  2026-04-08  Simple exact dedup
 *   v2.3  2026-04-08  Magic link points to prod r25prod repo
 *   v2.2  2026-04-08  Unique address tracking, addressLimit per key
 *   v2.1  2026-04-08  Fix CORS: use * origin
 *   v2.0  2026-04-07  KV access control + admin endpoints
 *   v1.0–v1.2  Rentcast proxy, Zillow scrape attempts
 *
 * Environment variables (Cloudflare dashboard → Workers → Settings → Variables):
 *   RENTCAST_KEY    Rentcast X-Api-Key (Secret)
 *   ALLOWED_ORIGIN  your Carrd site URL or *
 *   ADMIN_SECRET    secret token for /admin/* routes (Secret)
 *   NOTIFY_EMAIL    your email address to receive notifications (e.g. alik@realty25az.com)
 *
 * KV Namespace bindings:
 *   RC_KV  → your KV namespace
 *
 * Email binding (wrangler.toml only — cannot be set in dashboard):
 *   [[send_email]]
 *   name = "SEND_EMAIL"
 *   destination_address = "alik@realty25az.com"
 *
 * ⚠ Email Routing must be enabled on your domain in Cloudflare dashboard first.
 *   Dashboard → Email → Email Routing → Enable
 *   Then verify alik@realty25az.com as a destination address.
 *   No DNS changes needed if realty25az.com is already on Cloudflare nameservers.
 */

const RENTCAST_BASE = 'https://api.rentcast.io/v1';
const DEMO_ADDRS = ['10394 e morning star dr, scottsdale, az 85255'];

function generateKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let k = 'R25-';
  for (let i = 0; i < 8; i++) k += chars[Math.floor(Math.random() * chars.length)];
  return k;
}

// ── Email helper ──
// Uses Cloudflare Email Routing send binding (env.SEND_EMAIL).
// Fails silently — email is a nice-to-have notification, never blocks the response.
async function sendNotification(env, subject, body) {
  try {
    if (!env.SEND_EMAIL) return; // binding not configured — skip silently
    // Build a minimal RFC 2822 message
    const to = env.NOTIFY_EMAIL || 'alik@realty25az.com';
    const from = 'rentalcomp@realty25az.com';
    const boundary = '----=_RCBoundary';
    const raw = [
      `From: RentalComp <${from}>`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      body
    ].join('\r\n');
    const { EmailMessage } = await import('cloudflare:email');
    const msg = new EmailMessage(from, to, raw);
    await env.SEND_EMAIL.send(msg);
  } catch(e) {
    // Never let email failure break the API response
    console.error('Email send failed:', e.message);
  }
}

// ── Shared limit check ──
async function checkLimit(key, address, env) {
  if (!key) return { allowed: true };
  const isDemo = DEMO_ADDRS.includes((address || '').trim().toLowerCase());
  if (isDemo) return { allowed: true, demo: true };
  const raw = await env.RC_KV.get('key:' + key);
  if (!raw) return { allowed: false, reason: 'not_found' };
  const rec = JSON.parse(raw);
  if (!rec.active) return { allowed: false, reason: 'inactive' };
  if (rec.expires && new Date(rec.expires) < new Date()) {
    return { allowed: false, reason: 'expired', email: rec.email };
  }
  const addressLimit = rec.addressLimit || null;
  if (!addressLimit) return { allowed: true };
  const uniqueAddresses = [...new Set((rec.searches || []).map(s => s.address.toLowerCase()))];
  const alreadySeen = uniqueAddresses.includes((address || '').trim().toLowerCase());
  if (alreadySeen) return { allowed: true, cached: true };
  if (uniqueAddresses.length >= addressLimit) {
    return { allowed: false, reason: 'limit_reached', email: rec.email, addressLimit, used: uniqueAddresses.length };
  }
  return { allowed: true };
}

export default {
  async fetch(request, env) {
    const allowed = env.ALLOWED_ORIGIN || '*';
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(allowed) });
    }
    const url = new URL(request.url);
    const path = url.pathname;

    // ── /request-access ──
    if (path === '/request-access') {
      if (request.method !== 'POST') return jsonError('POST required', 405, allowed);
      try {
        const body = await request.json();
        const email = (body.email || '').trim().toLowerCase();
        if (!email || !email.includes('@')) return jsonError('valid email required', 400, allowed);

        const existing = await env.RC_KV.get('request:' + email);
        if (existing) {
          const rec = JSON.parse(existing);
          if (rec.status === 'approved') return jsonResponse({ status: 'already_approved' }, allowed);
          return jsonResponse({ status: 'already_requested' }, allowed);
        }

        await env.RC_KV.put('request:' + email, JSON.stringify({
          email, requestedAt: new Date().toISOString(), status: 'pending'
        }));

        // Notify you — fire and forget, doesn't block response
        sendNotification(env,
          `RentalComp: New access request from ${email}`,
          `New access request received.\n\nEmail: ${email}\nTime: ${new Date().toUTCString()}\n\nApprove via admin panel:\nhttps://r25sandbox.github.io/rentcomps/admin.html`
        );

        return jsonResponse({ status: 'requested' }, allowed);
      } catch(e) {
        return jsonError(e.message, 500, allowed);
      }
    }

    // ── /validate-key ──
    if (path === '/validate-key') {
      const key = url.searchParams.get('key') || '';
      if (!key) return jsonResponse({ valid: false, reason: 'no_key' }, allowed);
      try {
        const raw = await env.RC_KV.get('key:' + key);
        if (!raw) return jsonResponse({ valid: false, reason: 'not_found' }, allowed);
        const rec = JSON.parse(raw);
        if (!rec.active) return jsonResponse({ valid: false, reason: 'inactive' }, allowed);
        if (rec.expires && new Date(rec.expires) < new Date()) {
          return jsonResponse({ valid: false, reason: 'expired', email: rec.email }, allowed);
        }
        const uniqueAddresses = [...new Set((rec.searches||[]).map(s=>s.address.toLowerCase()))];
        const addressLimit = rec.addressLimit || null;
        return jsonResponse({
          valid: true, email: rec.email, expires: rec.expires,
          searchedAddresses: uniqueAddresses,
          addressLimit, addressesUsed: uniqueAddresses.length
        }, allowed);
      } catch(e) {
        return jsonError(e.message, 500, allowed);
      }
    }

    // ── /log-search ──
    if (path === '/log-search') {
      if (request.method !== 'POST') return jsonError('POST required', 405, allowed);
      try {
        const body = await request.json();
        const { key, address, propertyId } = body;
        if (!key || !address) return jsonError('key and address required', 400, allowed);
        const isDemo = DEMO_ADDRS.includes((address || '').trim().toLowerCase());
        if (isDemo) return jsonResponse({ ok: true, demo: true }, allowed);

        const raw = await env.RC_KV.get('key:' + key);
        if (!raw) return jsonResponse({ ok: false }, allowed);
        const rec = JSON.parse(raw);
        rec.searches = rec.searches || [];
        const alreadySearched = propertyId
          ? rec.searches.some(s => s.propertyId === propertyId)
          : rec.searches.some(s => s.address.toLowerCase() === address.toLowerCase());

        if (!alreadySearched) {
          rec.searches.push({ address, propertyId: propertyId||null, at: new Date().toISOString() });
          await env.RC_KV.put('key:' + key, JSON.stringify(rec));

          // Check if they just hit their limit — notify (nice to have)
          const addressLimit = rec.addressLimit || null;
          if (addressLimit) {
            const uniqueNow = [...new Set(rec.searches.map(s => s.address.toLowerCase()))];
            if (uniqueNow.length >= addressLimit) {
              sendNotification(env,
                `RentalComp: ${rec.email} hit their ${addressLimit}-search trial limit`,
                `Trial limit reached.\n\nEmail: ${rec.email}\nKey: ${key}\nSearches used: ${uniqueNow.length}/${addressLimit}\nAddresses searched:\n${uniqueNow.map(a=>'  - '+a).join('\n')}\n\nTime: ${new Date().toUTCString()}`
              );
            }
          }
        }
        return jsonResponse({ ok: true }, allowed);
      } catch(e) {
        return jsonError(e.message, 500, allowed);
      }
    }

    // ── Admin routes ──
    const adminSecret = request.headers.get('x-admin-secret');
    const isAdmin = adminSecret && adminSecret === env.ADMIN_SECRET;

    if (path === '/admin/requests') {
      if (!isAdmin) return jsonError('unauthorized', 401, allowed);
      try {
        const list = await env.RC_KV.list({ prefix: 'request:' });
        const requests = await Promise.all(list.keys.map(async k => {
          const raw = await env.RC_KV.get(k.name);
          return raw ? JSON.parse(raw) : null;
        }));
        return jsonResponse(requests.filter(Boolean).sort((a,b) => new Date(b.requestedAt) - new Date(a.requestedAt)), allowed);
      } catch(e) { return jsonError(e.message, 500, allowed); }
    }

    if (path === '/admin/keys') {
      if (!isAdmin) return jsonError('unauthorized', 401, allowed);
      try {
        const list = await env.RC_KV.list({ prefix: 'key:' });
        const keys = await Promise.all(list.keys.map(async k => {
          const raw = await env.RC_KV.get(k.name);
          return raw ? JSON.parse(raw) : null;
        }));
        return jsonResponse(keys.filter(Boolean).sort((a,b) => new Date(b.created) - new Date(a.created)), allowed);
      } catch(e) { return jsonError(e.message, 500, allowed); }
    }

    if (path === '/admin/approve') {
      if (!isAdmin) return jsonError('unauthorized', 401, allowed);
      if (request.method !== 'POST') return jsonError('POST required', 405, allowed);
      try {
        const body = await request.json();
        const email = (body.email || '').trim().toLowerCase();
        const days = body.days || 7;
        const addressLimit = body.addressLimit || 3;
        if (!email) return jsonError('email required', 400, allowed);
        const key = generateKey();
        const now = new Date();
        const expires = new Date(now.getTime() + days * 86400000).toISOString();
        await env.RC_KV.put('key:' + key, JSON.stringify({
          key, email, created: now.toISOString(), expires, active: true, addressLimit, searches: []
        }));
        const reqRaw = await env.RC_KV.get('request:' + email);
        if (reqRaw) {
          const req = JSON.parse(reqRaw);
          req.status = 'approved'; req.key = key;
          await env.RC_KV.put('request:' + email, JSON.stringify(req));
        }
        return jsonResponse({ key, email, expires, magicLink: key }, allowed);
      } catch(e) { return jsonError(e.message, 500, allowed); }
    }

    if (path === '/admin/update-lead') {
      if (!isAdmin) return jsonError('unauthorized', 401, allowed);
      if (request.method !== 'POST') return jsonError('POST required', 405, allowed);
      try {
        const body = await request.json();
        const key = (body.key || '').trim();
        const jiraUrl = (body.jiraUrl || '').trim();
        if (!key) return jsonError('key required', 400, allowed);
        const raw = await env.RC_KV.get('key:' + key);
        if (!raw) return jsonError('key not found', 404, allowed);
        const rec = JSON.parse(raw);
        rec.jiraUrl = jiraUrl; // empty string clears it
        await env.RC_KV.put('key:' + key, JSON.stringify(rec));
        return jsonResponse({ ok: true }, allowed);
      } catch(e) { return jsonError(e.message, 500, allowed); }
    }

    if (path === '/admin/revoke') {
      if (!isAdmin) return jsonError('unauthorized', 401, allowed);
      if (request.method !== 'POST') return jsonError('POST required', 405, allowed);
      try {
        const body = await request.json();
        const key = (body.key || '').trim();
        const raw = await env.RC_KV.get('key:' + key);
        if (!raw) return jsonError('key not found', 404, allowed);
        const rec = JSON.parse(raw);
        rec.active = false;
        await env.RC_KV.put('key:' + key, JSON.stringify(rec));
        return jsonResponse({ ok: true }, allowed);
      } catch(e) { return jsonError(e.message, 500, allowed); }
    }

    // ── /zillow-price ──
    if (path === '/zillow-price') {
      const address = url.searchParams.get('address');
      if (!address) return jsonError('address required', 400, allowed);
      try {
        const rcUrl = `${RENTCAST_BASE}/listings/rental/long-term?address=${encodeURIComponent(address)}&status=Active&limit=1`;
        const rcRes = await fetch(rcUrl, { headers: { 'X-Api-Key': env.RENTCAST_KEY, 'accept': 'application/json' } });
        if (!rcRes.ok) return jsonResponse({ price: null, status: null, source: null }, allowed);
        const data = await rcRes.json();
        const listings = Array.isArray(data) ? data : (data.listings || []);
        if (!listings.length) return jsonResponse({ price: null, status: null, source: null }, allowed);
        return jsonResponse({ price: listings[0].price||null, status: listings[0].status||null, daysOnMarket: listings[0].daysOnMarket||null, source: 'rentcast' }, allowed);
      } catch(e) { return jsonError(e.message, 502, allowed); }
    }

    // ── /rentcast/* proxy with limit enforcement ──
    if (path.startsWith('/rentcast/')) {
      const isSearchCall = path === '/rentcast/avm/rent/long-term';
      if (isSearchCall) {
        const address = url.searchParams.get('address') || '';
        const key = url.searchParams.get('_key') || request.headers.get('x-access-key') || '';
        const limitCheck = await checkLimit(key, address, env);
        if (!limitCheck.allowed) {
          return new Response(JSON.stringify({
            error: 'limit_reached', reason: limitCheck.reason,
            email: limitCheck.email || null,
            addressLimit: limitCheck.addressLimit || null,
            used: limitCheck.used || null
          }), { status: 429, headers: { 'Content-Type': 'application/json', ...corsHeaders(allowed) } });
        }
      }
      const rcPath = path.replace('/rentcast', '');
      const forwardParams = new URLSearchParams(url.search);
      forwardParams.delete('_key');
      const rcUrl = `${RENTCAST_BASE}${rcPath}?${forwardParams.toString()}`;
      try {
        const res = await fetch(rcUrl, { headers: { 'X-Api-Key': env.RENTCAST_KEY, 'accept': 'application/json' } });
        const data = await res.json();
        return jsonResponse(data, allowed);
      } catch(e) { return jsonError(e.message, 502, allowed); }
    }

    return jsonError('not found', 404, allowed);
  }
};

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret, x-access-key',
    'Access-Control-Max-Age': '86400',
  };
}
function jsonResponse(data, origin) {
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } });
}
function jsonError(msg, status, origin) {
  return new Response(JSON.stringify({ error: msg }), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } });
}
