const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const HTML_FILE = 'index.html';
const MAX_BODY_BYTES = 180 * 1024;
const cache = new Map();
const openaiChatHandler = require('./api/openai-chat');

function loadEnv() {
  for (const name of ['.env.local', '.env', '.env.development.local']) {
    const envPath = path.join(ROOT, name);
    if (!fs.existsSync(envPath)) continue;
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  }
}

loadEnv();

const PORT = Number(process.env.PORT || 4173);
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, body) => {
    if (err) return sendJson(res, err.code === 'ENOENT' ? 404 : 500, { error: 'File not found' });
    const ext = path.extname(filePath).toLowerCase();
    const type = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml'
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function cleanLines(text) {
  return String(text || '')
    .split(/\n+/)
    .map(line => line.replace(/^[-*\d.)\s]+/, '').trim())
    .map(normalizeRevenueUnits)
    .filter(Boolean)
    .slice(0, 10);
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (typeof payload.month !== 'string' || typeof payload.studio !== 'string') return false;
  if (!payload.current || typeof payload.current !== 'object') return false;
  return true;
}

function validateTablePayload(payload) {
  return Boolean(
    payload &&
    typeof payload === 'object' &&
    typeof payload.tableId === 'string' &&
    typeof payload.title === 'string' &&
    Array.isArray(payload.headers) &&
    Array.isArray(payload.rows)
  );
}

function validateSummaryPayload(payload) {
  return Boolean(
    payload &&
    typeof payload === 'object' &&
    typeof payload.month === 'string' &&
    typeof payload.studio === 'string' &&
    typeof payload.section === 'string' &&
    typeof payload.summary === 'string'
  );
}

function money(v) {
  v = Number(v || 0);
  const sign = v < 0 ? '-' : '';
  v = Math.abs(v);
  if (v >= 10000000) return `${sign}₹${(v / 10000000).toFixed(2)}Cr`;
  if (v >= 100000) return `${sign}₹${(v / 100000).toFixed(1)}L`;
  if (v >= 1000) return `${sign}₹${(v / 1000).toFixed(1)}K`;
  return `${sign}₹${Math.round(v).toLocaleString('en-IN')}`;
}

function normalizeRevenueUnits(line) {
  const revenueContext = /\b(sales|revenue|value|atv|auv|ltv|cash|billing|receipt|income|gross|net|rupee|inr|₹|rs\.?)\b/i;
  if (!revenueContext.test(line)) return line;
  return String(line).replace(/(?:₹|rs\.?|inr)?\s*(-?\d+(?:\.\d+)?)\s*(?:million|mn|m)\b/gi, (_, n) => money(Number(n) * 1000000));
}

function pct(v) {
  return `${(Number(v || 0) * 100).toFixed(1)}%`;
}

function fallbackLines(payload) {
  const current = payload.current || {};
  const previous = payload.previous || {};
  const leaders = payload.leaders || {};
  const change = (key, type = 'number') => {
    if (previous[key] === undefined || previous[key] === null) return 'no prior-month comparator';
    const delta = Number(current[key] || 0) - Number(previous[key] || 0);
    if (type === 'pct') return `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}pp vs prior month`;
    const base = Math.abs(Number(previous[key] || 0));
    return base ? `${delta >= 0 ? '+' : ''}${((delta / base) * 100).toFixed(1)}% vs prior month` : 'no prior-month comparator';
  };
  return [
    `${payload.studio} closed ${payload.month} at ${money(current.sales)} sales, ${change('sales')}.`,
    `Session revenue was ${money(current.sessionRevenue)}, with class average at ${Number(current.classAvg || 0).toFixed(1)} and fill at ${pct(current.fill)}.`,
    `Acquisition produced ${Math.round(Number(current.newMembers || 0)).toLocaleString('en-IN')} first visits and ${Math.round(Number(current.converted || 0)).toLocaleString('en-IN')} conversions, ${change('conversion', 'pct')}.`,
    `Churn risk was ${pct(current.churn)} across ${Math.round(Number(current.expiring || 0)).toLocaleString('en-IN')} expiring memberships.`,
    `Leading signals: format ${leaders.format || '-'}, class ${leaders.class || '-'}, source ${leaders.source || '-'}, and trainer ${leaders.trainer || '-'}.`,
    `Use this readout as the baseline summary; AI can refresh it when the service returns a complete generated response.`
  ];
}

function cleanInsight(text) {
  return normalizeRevenueUnits(String(text || '')
    .split(/\n+/)
    .map(line => line.replace(/^[-*\d.)\s]+/, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()).slice(0, 700);
}

function responseText(data) {
  if (typeof data?.output_text === 'string') return data.output_text.trim();
  const parts = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === 'string') parts.push(content.text);
      if (typeof content?.output_text === 'string') parts.push(content.output_text);
    }
  }
  return parts.join('\n').trim();
}

async function handleReadout(req, res) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return sendJson(res, 503, { error: 'OPENAI_API_KEY is not configured on the server.' });
  }

  try {
    const payload = await readJson(req);
    if (!validatePayload(payload)) return sendJson(res, 400, { error: 'Invalid readout payload.' });

    const cacheKey = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const cached = cache.get(cacheKey);
    if (cached) return sendJson(res, 200, { lines: cached, cached: true });

    const upstream = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-5',
        reasoning: { effort: 'medium' },
        max_output_tokens: 1100,
        instructions: [
          `You are a senior Physique 57 India operations analyst writing a monthly briefing for ${payload.studio} studio leadership for ${payload.month}.`,
          'Write exactly 8 plain-English lines. No markdown, no bullet points, no bold, no headers.',
          'Each line must begin with exactly one of these prefixes (use each once): Read:, Revenue:, Driver:, Demand:, Acquisition:, Retention:, Risk:, Action:',
          'CRITICAL — be hyper-specific: every line must cite exact numbers from the payload (₹ amounts in K/L/Cr, %, counts). Never write a line without at least two specific figures.',
          'Read: overall health verdict with sales figure and fill rate and MoM delta.',
          'Revenue: break down session vs membership vs retail revenue and name the dominant category with its share %.',
          'Driver: identify the single metric that is most driving the current result (positive or negative) and explain the operating mechanism behind it.',
          'Demand: which format/daypart/weekday is carrying or dragging demand — cite attendance, fill, and revenue for the specific segment.',
          'Acquisition: first visits, conversion count and rate, and why conversion is at this level — name the specific barrier or driver.',
          'Retention: churn rate, expiring count, renewal rate, and the specific membership tier with the highest churn risk.',
          'Risk: the single biggest forward risk (concentration, seasonality, capacity, or a declining metric) — quantify it.',
          'Action: one specific, concrete operational move the team can execute this week — name the lever, the target, and the expected outcome.',
          'Each line: 35-55 words. Use only K, L, or Cr for rupee amounts; never write million, mn, or m.'
        ].join(' '),
        input: JSON.stringify(payload)
      })
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      console.error('OpenAI readout failed', upstream.status, text.slice(0, 500));
      return sendJson(res, 200, { lines: fallbackLines(payload), cached: false, fallback: true, error: 'OpenAI request failed.' });
    }

    const data = await upstream.json();
    const raw = responseText(data);
    const lines = cleanLines(raw);
    if (!lines.length) {
      console.error('OpenAI returned an empty readout', JSON.stringify(data).slice(0, 500));
      return sendJson(res, 200, { lines: fallbackLines(payload), cached: false, fallback: true, error: 'OpenAI returned an empty readout.' });
    }

    cache.set(cacheKey, lines);
    return sendJson(res, 200, { lines, cached: false, model: 'gpt-5' });
  } catch (err) {
    return sendJson(res, err.status || 500, { error: err.message || 'Readout generation failed.' });
  }
}

async function handleTableInsight(req, res) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return sendJson(res, 503, { error: 'OPENAI_API_KEY is not configured on the server.' });
  }

  try {
    const payload = await readJson(req);
    if (!validateTablePayload(payload)) return sendJson(res, 400, { error: 'Invalid table insight payload.' });

    const cacheKey = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const cached = cache.get(cacheKey);
    if (cached) return sendJson(res, 200, { insight: cached, cached: true });

    const headers = payload.headers || [];
    const rows = (payload.rows || []).slice(0, 10);

    const upstream = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-5',
        reasoning: { effort: 'medium' },
        max_output_tokens: 400,
        instructions: [
          `You are a Physique 57 India operations analyst writing a dashboard table insight for ${payload.studio || 'the studio'} for ${payload.month || 'this month'}.`,
          'Start your response with exactly "Key insight:" — no other prefix, no bullet, no markdown.',
          'Write 3-4 sentences. Total: 80-120 words. Be hyper-specific — cite exact row names, column values, and percentages from the data.',
          'Sentence 1: Name the primary pattern or concentration the table reveals, with specific figures from the top and bottom rows.',
          'Sentence 2: Explain why this pattern matters for revenue or operations — quantify the risk or opportunity it represents.',
          'Sentence 3: Prescribe a concrete action the team should take this week — name exactly which row/segment to target and what to do.',
          'Sentence 4 (optional): One secondary signal from the data worth watching next month.',
          'Use only K, L, or Cr for rupee amounts. Never write million, mn, or m. No markdown. No bullet points.'
        ].join(' '),
        input: JSON.stringify({ title: payload.title, studio: payload.studio, month: payload.month, headers, rows })
      })
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      console.error('OpenAI table insight failed', upstream.status, text.slice(0, 500));
      return sendJson(res, 200, { insight: payload.fallback || 'Key insight: Table data is available for review.', cached: false, fallback: true });
    }

    const data = await upstream.json();
    const raw = responseText(data);
    let insight = cleanInsight(raw);
    if (!insight) insight = payload.fallback || 'Key insight: Table data is available for review.';
    if (!/^key insight:/i.test(insight)) insight = `Key insight: ${insight}`;
    cache.set(cacheKey, insight);
    return sendJson(res, 200, { insight, cached: false, model: 'gpt-5' });
  } catch (err) {
    return sendJson(res, err.status || 500, { error: err.message || 'Table insight generation failed.' });
  }
}

async function handleSummaryInsights(req, res) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return sendJson(res, 503, { error: 'Supabase is not configured on the server.' });
  }

  try {
    const payload = await readJson(req);
    if (req.method === 'GET') {
      const month = String(payload?.month || '');
      const studio = String(payload?.studio || '');
      const section = String(payload?.section || '');
      if (!month || !studio || !section) return sendJson(res, 400, { error: 'Missing summary lookup params.' });
      const query = new URLSearchParams({ select: 'month,studio,section,summary,updated_at', month: `eq.${month}`, studio: `eq.${studio}`, section: `eq.${section}`, limit: '1' });
      const upstream = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/dashboard_ai_summaries?${query.toString()}`, {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
        }
      });
      const data = await upstream.json();
      return sendJson(res, upstream.status, Array.isArray(data) ? (data[0] || null) : data);
    }

    if (!validateSummaryPayload(payload)) return sendJson(res, 400, { error: 'Invalid summary payload.' });

    const upstream = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/dashboard_ai_summaries?on_conflict=month,studio,section`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        prefer: 'resolution=merge-duplicates,return=representation',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        month: payload.month,
        studio: payload.studio,
        section: payload.section,
        summary: payload.summary,
        updated_at: new Date().toISOString()
      })
    });
    const data = await upstream.json();
    return sendJson(res, upstream.status, data);
  } catch (err) {
    return sendJson(res, err.status || 500, { error: err.message || 'Summary save failed.' });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'POST' && url.pathname === '/api/management-readout') return handleReadout(req, res);
  if (req.method === 'POST' && url.pathname === '/api/table-insight') return handleTableInsight(req, res);
  if (url.pathname === '/api/summary-insights') return handleSummaryInsights(req, res);
  if (req.method === 'POST' && url.pathname === '/api/openai-chat') return openaiChatHandler(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });

  const requested = url.pathname === '/' ? HTML_FILE : decodeURIComponent(url.pathname.slice(1));
  const resolved = path.resolve(ROOT, requested);
  if (!resolved.startsWith(ROOT)) return sendJson(res, 403, { error: 'Forbidden' });
  return sendFile(res, resolved);
});

server.listen(PORT, () => {
  console.log(`P57 dashboard server running at http://localhost:${PORT}`);
});
