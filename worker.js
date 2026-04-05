/**
 * RentalComp Map — Cloudflare Worker v1.0
 * Proxies Rentcast API (key stored as secret) + scrapes Zillow asking price
 *
 * Environment variables (set in Cloudflare dashboard → Workers → Settings → Variables):
 *   RENTCAST_KEY   6ad16d1257704fe2a61813c6f6115040
 *   ALLOWED_ORIGIN your Carrd site URL e.g. https://alikrupnik.carrd.co (or * for dev)
 */

const RENTCAST_BASE = 'https://api.rentcast.io/v1';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '*';
    const allowed = env.ALLOWED_ORIGIN || '*';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders(allowed),
      });
    }

    const url = new URL(request.url);
    const path = url.pathname; // e.g. /rentcast/avm/rent/long-term

    // ── Route: /zillow-price?address=... ──
    if (path === '/zillow-price') {
      const address = url.searchParams.get('address');
      if (!address) return jsonError('address required', 400, allowed);
      try {
        const price = await scrapeZillowPrice(address);
        return jsonResponse({ price }, allowed);
      } catch (e) {
        return jsonError(e.message, 502, allowed);
      }
    }

    // ── Route: /rentcast/* → proxy to Rentcast ──
    if (path.startsWith('/rentcast/')) {
      const rcPath = path.replace('/rentcast/', '');
      const rcUrl = `${RENTCAST_BASE}/${rcPath}${url.search}`;
      try {
        const rcRes = await fetch(rcUrl, {
          headers: {
            'X-Api-Key': env.RENTCAST_KEY,
            'accept': 'application/json',
          },
        });
        const data = await rcRes.text();
        return new Response(data, {
          status: rcRes.status,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders(allowed),
          },
        });
      } catch (e) {
        return jsonError('Rentcast fetch failed: ' + e.message, 502, allowed);
      }
    }

    return jsonError('Unknown route', 404, allowed);
  },
};

// ── Zillow scraper ──
async function scrapeZillowPrice(address) {
  // Build Zillow search URL from address
  const slug = address
    .replace(/,/g, '')
    .trim()
    .replace(/\s+/g, '-');

  const searchUrl = `https://www.zillow.com/homes/for_rent/${encodeURIComponent(slug)}_rb/`;

  const res = await fetch(searchUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!res.ok) throw new Error(`Zillow returned ${res.status}`);

  const html = await res.text();

  // Zillow embeds listing data as JSON in a <script> tag
  // Look for "price" near the address in the __NEXT_DATA__ blob
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      // Walk the tree to find listingPrice or price
      const str = JSON.stringify(nextData);
      // Find price associated with the listing — look for hdpData.homeInfo.price
      const priceMatch = str.match(/"price":(\d+)/);
      if (priceMatch) return parseInt(priceMatch[1]);
    } catch(e) { /* fall through to regex */ }
  }

  // Fallback: regex scan for price pattern like "$3,650/mo" in the HTML
  const priceMatch = html.match(/\$([0-9,]+)\/mo/);
  if (priceMatch) {
    return parseInt(priceMatch[1].replace(/,/g, ''));
  }

  throw new Error('Price not found in Zillow response');
}

// ── Helpers ──
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(data, origin) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function jsonError(msg, status, origin) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}
