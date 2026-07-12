// Wealth Companion backend — thin orchestration layer.
//   GET  /health       → key presence + model
//   POST /chat         → streams the LLM reply (SSE: {delta} … {done})
//   POST /tts          → Deepgram Aura text-to-speech (audio/mpeg)
//   WS   /stt-stream    → proxies mic audio to Deepgram streaming STT (real-time)
//   POST /stt          → Deepgram batch STT (kept as a fallback)
// The app talks only to this server; keys never reach the client.
// Run: npm start (loads .env). Node >= 20.6 for --env-file (we're on 24).

import http from 'node:http';
import { WebSocketServer, WebSocket as WS } from 'ws';
import { TOOL_SCHEMAS, runTool, toolLabel } from './tools.js';

const {
  LLM_BASE_URL = 'https://openrouter.ai/api/v1',
  LLM_MODEL = 'deepseek/deepseek-v4-flash',
  LLM_API_KEY = '',
  DEEPGRAM_API_KEY = '',                 // STT (streaming)
  CARTESIA_API_KEY = '',                 // TTS (Hindi / code-mixed, Indian voice)
  CARTESIA_MODEL = 'sonic-3.5',
  // Cartesia Hindi voices. Default = female (Asha); male available per-request.
  CARTESIA_VOICE = '95d51f79-c397-46f9-b49a-23763d3eaa2d',       // female
  CARTESIA_VOICE_MALE = '4877b818-c7fe-4c89-b1cf-eadf8e23da72',
  PORT = 8787,
} = process.env;

const SYSTEM_BASE = `You are "Asha", a warm, plain-spoken FEMALE wealth companion inside an Indian bank's mobile app.
Help everyday customers understand their money and make calm, sensible decisions. Keep replies short — one clear point at a time.

LANGUAGE — follow strictly:
- Reply in the SAME language as the user's LATEST message. English in → reply in English. Hindi in → reply in Hindi. If they code-mix, mirror it. When unsure, default to English.
- Write Hindi ONLY in Devanagari and English ONLY in the Latin alphabet — for EVERY word, across the WHOLE message. NEVER romanize Hindi: write "कैसे हैं आप", never "kaise hain aap". Do not slip into Latin-script Hindi even for a single word or clause.
- You are FEMALE (Asha): in Hindi always use feminine self-reference (मैं देख रही हूँ, कर सकती हूँ, समझ गई) — never masculine (सकता/गया).
- Address the user politely as "आप"; never "तू/तेरा".

COMPLIANCE: You are a distributor, not a registered advisor — say "here's what suits you", never promise guaranteed returns or give hard "this is the advice" directives. If something needs a licensed human, offer the Relationship Manager. Never invent account numbers or figures you weren't given.

TOOLS: You can call tools to fetch the customer's accounts (savings, home loan, FD, goals, gold) and to run projections. When you need data, CALL THE TOOL DIRECTLY — do NOT write a preface like "let me check" or "let me pull that up" or "let me run that". After the tool results come back, reply once, briefly, grounded in what they returned. Never guess figures.`;

const PERSONAS = {
  friendly: 'PERSONA: Warm, friendly and reassuring — like a trusted person from the bank who genuinely cares. Encouraging, never pushy.',
  formal: 'PERSONA: Professional, precise and courteous. Measured and businesslike, still kind.',
  respectful: 'PERSONA: Highly respectful and deferential — use honorifics (जी) and speak with utmost courtesy and warmth.',
};
const DEFAULT_PERSONA = 'friendly';

// --- helpers -----------------------------------------------------------------
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- POST /chat : agent loop (streams text deltas + tool events) -------------
// One streamed round to the LLM. Forwards text deltas live and accumulates any
// tool calls the model makes (streamed as fragments).
async function streamRound(convo, send) {
  const resp = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_API_KEY}` },
    body: JSON.stringify({ model: LLM_MODEL, messages: convo, tools: TOOL_SCHEMAS, stream: true }),
  });
  if (!resp.ok || !resp.body) {
    send({ error: (await resp.text().catch(() => '')).slice(0, 300) || 'LLM error' });
    return { content: '', toolCalls: [] };
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', content = '';
  const tcs = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const data = s.slice(5).trim();
      if (data === '[DONE]') continue;
      let j; try { j = JSON.parse(data); } catch { continue; }
      const delta = j.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) { content += delta.content; send({ delta: delta.content }); }
      for (const tc of delta.tool_calls || []) {
        const i = tc.index ?? 0;
        tcs[i] = tcs[i] || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) tcs[i].id = tc.id;
        if (tc.function?.name) tcs[i].function.name = tc.function.name;
        if (tc.function?.arguments) tcs[i].function.arguments += tc.function.arguments;
      }
    }
  }
  return { content, toolCalls: tcs.filter(Boolean) };
}

async function chat(req, res) {
  if (!LLM_API_KEY) return json(res, 500, { error: 'LLM_API_KEY not set in backend/.env' });
  let body;
  try { body = JSON.parse((await readBody(req)).toString() || '{}'); }
  catch { return json(res, 400, { error: 'invalid JSON body' }); }
  const persona = PERSONAS[body.persona] ? body.persona : DEFAULT_PERSONA;
  // Deterministic per-turn language lock — the general rule drifts once tool
  // context is in the conversation, so pin it from the user's actual script.
  const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === 'user');
  const langNow = /[ऀ-ॿ]/.test(lastUser?.content || '')
    ? 'RIGHT NOW the user wrote in Hindi/Hinglish — reply in Hindi (Devanagari script; keep English terms in Latin), never romanized.'
    : 'RIGHT NOW the user wrote in English — reply in ENGLISH only. Do not switch to Hindi.';
  const convo = [{ role: 'system', content: `${SYSTEM_BASE}\n\n${PERSONAS[persona]}\n\n${langNow}` }, ...(body.messages || [])];

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  try {
    for (let round = 0; round < 5; round++) {
      const { content, toolCalls } = await streamRound(convo, send);
      if (toolCalls.length === 0) break;                  // final answer already streamed
      convo.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });
      for (const tc of toolCalls) {
        const name = tc.function.name;
        let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* noop */ }
        send({ tool_start: { id: tc.id, name, label: toolLabel(name, args) } });
        await sleep(550); // let the trace's spinner show before the result lands
        const result = runTool(name, args);
        send({ tool_done: { id: tc.id, name, cards: result.cards || null } });
        convo.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result.data ?? {}) });
      }
    }
  } catch (e) { send({ error: e.message }); }
  send({ done: true });
  res.end();
}

// --- POST /stt (batch fallback) ---------------------------------------------
async function stt(req, res) {
  if (!DEEPGRAM_API_KEY) return json(res, 500, { error: 'DEEPGRAM_API_KEY not set' });
  const audio = await readBody(req);
  const ct = req.headers['content-type'] || 'audio/webm';
  const dg = await fetch('https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&language=multi', {
    method: 'POST', headers: { Authorization: `Token ${DEEPGRAM_API_KEY}`, 'Content-Type': ct }, body: audio,
  });
  const j = await dg.json().catch(() => ({}));
  json(res, dg.ok ? 200 : dg.status, { transcript: j?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '' });
}

// --- POST /tts : Cartesia Sonic (Hindi / code-mixed) -------------------------
async function tts(req, res) {
  if (!CARTESIA_API_KEY) return json(res, 500, { error: 'CARTESIA_API_KEY not set in backend/.env' });
  const { text, gender } = JSON.parse((await readBody(req)).toString() || '{}');
  if (!text) return json(res, 400, { error: 'no text' });
  const voiceId = gender === 'male' ? CARTESIA_VOICE_MALE : CARTESIA_VOICE;
  // Read Devanagari as Hindi and Latin as English: if any Devanagari is present
  // use Hindi as the base (Sonic code-mixes the English parts), else English.
  const language = /[ऀ-ॿ]/.test(text) ? 'hi' : 'en';
  const r = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CARTESIA_API_KEY}`,
      'Cartesia-Version': '2026-03-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: CARTESIA_MODEL,
      transcript: text,
      voice: { mode: 'id', id: voiceId },
      language,
      output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 },
    }),
  });
  if (!r.ok) return json(res, r.status, { error: (await r.text()).slice(0, 300) });
  res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
  res.end(Buffer.from(await r.arrayBuffer()));
}

// --- router ------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = req.url.split('?')[0];
  try {
    if (url === '/health') return json(res, 200, { ok: true, model: LLM_MODEL, llm: !!LLM_API_KEY, deepgram: !!DEEPGRAM_API_KEY, cartesia: !!CARTESIA_API_KEY });
    if (url === '/chat' && req.method === 'POST') return await chat(req, res);
    if (url === '/stt' && req.method === 'POST') return await stt(req, res);
    if (url === '/tts' && req.method === 'POST') return await tts(req, res);
    res.writeHead(404); res.end('not found');
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e.message }); else res.end();
  }
});

// --- WS /stt-stream : real-time STT proxy to Deepgram ------------------------
const wss = new WebSocketServer({ server, path: '/stt-stream' });
wss.on('connection', (client, req) => {
  if (!DEEPGRAM_API_KEY) { client.close(); return; }
  const sr = new URL(req.url, 'http://x').searchParams.get('sampleRate') || '48000';
  const dgUrl = 'wss://api.deepgram.com/v1/listen?' + new URLSearchParams({
    encoding: 'linear16', sample_rate: sr, channels: '1',
    model: 'nova-3', language: 'multi',
    interim_results: 'true', smart_format: 'true', punctuate: 'true',
    endpointing: '1000', utterance_end_ms: '2000',
  }).toString();

  const dg = new WS(dgUrl, { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } });
  const backlog = [];
  dg.on('open', () => { for (const b of backlog) dg.send(b); backlog.length = 0; });
  dg.on('message', (data) => { if (client.readyState === client.OPEN) client.send(data.toString()); });
  dg.on('close', () => { try { client.close(); } catch { /* noop */ } });
  dg.on('error', () => { try { client.close(); } catch { /* noop */ } });

  client.on('message', (data, isBinary) => {
    if (!isBinary) return;
    if (dg.readyState === dg.OPEN) dg.send(data); else backlog.push(data);
  });
  client.on('close', () => {
    try { if (dg.readyState === dg.OPEN) dg.send(JSON.stringify({ type: 'CloseStream' })); dg.close(); }
    catch { /* noop */ }
  });
});

server.listen(PORT, () => {
  console.log(`Wealth Companion backend → http://localhost:${PORT}  (WS /stt-stream ready)`);
  console.log(`  LLM: ${LLM_MODEL} ${LLM_API_KEY ? '✓' : 'MISSING'} | Deepgram STT: ${DEEPGRAM_API_KEY ? '✓' : 'missing'} | Cartesia TTS: ${CARTESIA_API_KEY ? '✓' : 'missing'}`);
});
