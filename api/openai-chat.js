const crypto = require('crypto');

const MAX_BODY_BYTES = 180 * 1024;
const cache = global.__p57OpenAiChatCache || new Map();
global.__p57OpenAiChatCache = cache;

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(data));
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

function validatePayload(payload) {
  return Boolean(
    payload &&
    typeof payload === 'object' &&
    typeof payload.question === 'string' &&
    payload.question.trim().length > 0 &&
    payload.context &&
    typeof payload.context === 'object'
  );
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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return sendJson(res, 503, {
      error: 'OPENAI_API_KEY is not configured.',
      setup: 'Add OPENAI_API_KEY to .env or .env.local, then restart the dev server.'
    });
  }

  try {
    const payload = await readJson(req);
    if (!validatePayload(payload)) return sendJson(res, 400, { error: 'Invalid chat payload.' });

    const question = payload.question.trim().slice(0, 2000);
    const safePayload = {
      question,
      dashboardContext: payload.context,
      conversation: Array.isArray(payload.history) ? payload.history.slice(-8) : []
    };
    const cacheKey = crypto
      .createHash('sha256')
      .update(JSON.stringify(safePayload))
      .digest('hex');
    const cached = cache.get(cacheKey);
    if (cached) return sendJson(res, 200, { answer: cached, cached: true });

    const upstream = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-5',
        reasoning: { effort: 'medium' },
        max_output_tokens: 1100,
        instructions: [
          'You are the Physique 57 India internal operations intelligence chatbot.',
          'Answer leadership and studio-operations questions using only the provided dashboardContext.',
          'Use exact figures from the data when available. Use INR formatting with K, L, or Cr where helpful.',
          'If the answer needs data that is not present, say what is missing and suggest the closest available proxy.',
          'Do not invent members, classes, revenue, dates, or causal claims. Separate facts from recommendations.',
          'Keep answers concise, decision-grade, and specific to the selected studio/month unless the user asks for network or trend context.',
          'Avoid exposing individual member names unless the user explicitly asks for spender/member-level rankings already present in the dashboard context.'
        ].join(' '),
        input: JSON.stringify(safePayload)
      })
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      console.error('OpenAI chat failed', upstream.status, text.slice(0, 500));
      return sendJson(res, upstream.status, { error: 'OpenAI request failed.' });
    }

    const data = await upstream.json();
    const answer = responseText(data);
    if (!answer) return sendJson(res, 502, { error: 'OpenAI returned an empty answer.' });

    cache.set(cacheKey, answer);
    return sendJson(res, 200, { answer, cached: false, model: process.env.OPENAI_MODEL || 'gpt-5' });
  } catch (err) {
    return sendJson(res, err.status || 500, { error: err.message || 'OpenAI chat failed.' });
  }
};
