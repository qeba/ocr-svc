require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const MAX_FILE_SIZE = (parseInt(process.env.MAX_FILE_SIZE_MB) || 10) * 1024 * 1024;

// ── Security config ──
const API_KEY = process.env.API_KEY || '';
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX) || 30;
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000;
const MAX_PROMPT_LENGTH = parseInt(process.env.MAX_PROMPT_LENGTH) || 2000;
const CORS_ORIGINS = process.env.CORS_ORIGINS || '*';
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS) || 15 * 1000;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// ── In-memory per-IP rate limiter ──
const rateLimitStore = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (now - entry.resetTime > RATE_LIMIT_WINDOW_MS) rateLimitStore.delete(key);
  }
}, 5 * 60 * 1000);

function rateLimiter(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const entry = rateLimitStore.get(ip);
  if (!entry || now - entry.resetTime > RATE_LIMIT_WINDOW_MS) {
    rateLimitStore.set(ip, { count: 1, resetTime: now });
    return next();
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    res.set('Retry-After', String(Math.ceil((RATE_LIMIT_WINDOW_MS - (now - entry.resetTime)) / 1000)));
    return res.status(429).json({ success: false, error: 'Rate limit exceeded. Try again later.' });
  }
  next();
}

// ── Auth middleware ──
function authMiddleware(req, res, next) {
  if (!API_KEY) return next();
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ success: false, error: 'Unauthorized.' });
  }
  next();
}

// ── Security headers ──
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.removeHeader('X-Powered-By');
  next();
});

// ── Middleware ──
const corsOptions = CORS_ORIGINS === '*'
  ? { origin: true }
  : { origin: CORS_ORIGINS.split(',').map(s => s.trim()) };
app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));

// ── Multer ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowed.includes(file.mimetype)) return cb(new Error(`Unsupported file type: ${file.mimetype}`));
    cb(null, true);
  }
});

// ── Magic-byte validation ──
function validateImageMagicBytes(buffer, mimetype) {
  if (!buffer || buffer.length < 12) return false;
  switch (mimetype) {
    case 'image/jpeg': return buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
    case 'image/png': return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
    case 'image/gif': return buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38;
    case 'image/webp': return buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP';
    default: return false;
  }
}

// ── Default OCR prompt ──
const DEFAULT_PROMPT = `Extract all information from this receipt image. Return ONLY valid JSON (no markdown, no code fences) with these fields:
- merchant: store/restaurant name (string or null)
- date: purchase date in YYYY-MM-DD format (string or null)
- items: array of objects with name (string), qty (number or null), price (number or null)
- subtotal: subtotal amount (number or null)
- tax: tax amount (number or null)
- total: total amount paid (number or null)
- category: one of [Food, Transport, Bills, Shopping, Online Shopping, Entertainment, Health, Education, Travel, Other]
- payment_method: cash/card/online/etc (string or null)

If a field cannot be determined, use null. Be precise with numbers.`;

// ── Gemini OCR ──
async function ocrGemini(imageBuffer, mimeType, prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const base64 = imageBuffer.toString('base64');

  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType, data: base64 } }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json'
    }
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal }
    );

    if (!res.ok) {
      const err = await res.text();
      console.error(`[Gemini] ${res.status}: ${err.slice(0, 300)}`);
      throw new Error(`Upstream API error (${res.status})`);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Empty response from model');

    return parseJSON(text);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Request timed out');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ── JSON parser ──
function parseJSON(text) {
  let cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in response');
  try {
    return JSON.parse(match[0]);
  } catch (e) {
    let fixed = match[0].replace(/,\s*}/g, '}').replace(/,\s*]/g, ']').replace(/'/g, '"');
    try { return JSON.parse(fixed); } catch (e2) { throw new Error(`Failed to parse JSON: ${e2.message}`); }
  }
}

// ── Landing page ──
app.get('/', (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><title>Cloud Services</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8f9fa;color:#333}.c{text-align:center;padding:2rem}h1{font-size:1.5rem;font-weight:500;margin-bottom:.5rem}p{color:#666;font-size:.9rem}</style></head><body><div class="c"><h1>Cloud Services</h1><p>Internal infrastructure endpoint.</p></div></body></html>`);
});

app.get('/robots.txt', (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.send('User-agent: *\nDisallow: /\n');
});

// ── Health ──
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), model: GEMINI_MODEL });
});

// ── OCR endpoint ──
app.post('/api/ocr', authMiddleware, rateLimiter, upload.single('image'), async (req, res) => {
  const start = Date.now();

  if (!req.file) return res.status(400).json({ success: false, error: 'No image file provided.' });
  if (!validateImageMagicBytes(req.file.buffer, req.file.mimetype)) return res.status(400).json({ success: false, error: 'Invalid file content.' });

  const prompt = req.body.prompt || DEFAULT_PROMPT;
  if (prompt.length > MAX_PROMPT_LENGTH) return res.status(400).json({ success: false, error: `Prompt too long (max ${MAX_PROMPT_LENGTH} chars).` });

  if (!process.env.GEMINI_API_KEY) return res.status(503).json({ success: false, error: 'API key not configured.' });

  try {
    const data = await ocrGemini(req.file.buffer, req.file.mimetype, prompt);
    const duration = Date.now() - start;
    console.log(`[OCR] ${GEMINI_MODEL} — ${duration}ms`);
    res.json({ success: true, provider: 'gemini', model: GEMINI_MODEL, duration_ms: duration, data });
  } catch (err) {
    console.error(`[OCR] Error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Catch-all 404 ──
app.use((req, res) => {
  res.status(404).set('Content-Type', 'text/html');
  res.send('<!DOCTYPE html><html><head><meta name="robots" content="noindex,nofollow"><title>404</title></head><body><h1>Not Found</h1></body></html>');
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`\n  OCR Service — ${GEMINI_MODEL}`);
  console.log(`  Port: ${PORT}`);
  console.log(`  Auth: ${API_KEY ? 'ENABLED' : 'DISABLED'}`);
  console.log(`  Rate limit: ${RATE_LIMIT_MAX} req / ${RATE_LIMIT_WINDOW_MS / 1000}s per IP`);
  console.log(`  Max file size: ${MAX_FILE_SIZE / 1024 / 1024}MB\n`);
});
