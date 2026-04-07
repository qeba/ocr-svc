require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const MAX_FILE_SIZE = (parseInt(process.env.MAX_FILE_SIZE_MB) || 10) * 1024 * 1024;
const DEFAULT_PROVIDER = process.env.DEFAULT_PROVIDER || 'gemini';

// ── Middleware ──
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ── Multer (memory storage — no temp files) ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${file.mimetype}`));
  }
});

// ── OCR Prompt ──
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

// ── Provider: Gemini ──
async function ocrGemini(imageBuffer, mimeType, prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
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
      maxOutputTokens: 2048,
      responseMimeType: 'application/json'
    }
  };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned empty response');

  return parseJSON(text);
}

// ── Provider: GLM (z.ai) ──
async function ocrGLM(imageBuffer, mimeType, prompt) {
  const apiKey = process.env.GLM_API_KEY;
  if (!apiKey) throw new Error('GLM_API_KEY not set');

  const baseUrl = process.env.GLM_BASE_URL || 'https://api.z.ai/api/coding/paas/v4';
  const model = process.env.GLM_MODEL || 'glm-4.6v-flash';
  const base64 = imageBuffer.toString('base64');

  const body = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
        { type: 'text', text: prompt }
      ]
    }],
    temperature: 0.1,
    max_tokens: 2048
  };

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GLM API ${res.status}: ${err}`);
  }

  const data = await res.json();
  // GLM-4.6V returns answers in reasoning_content, not content
  const text = data?.choices?.[0]?.message?.content
    || data?.choices?.[0]?.message?.reasoning_content
    || '';
  if (!text) throw new Error('GLM returned empty response');

  return parseJSON(text);
}

// ── JSON Parser (handles markdown fences, extra text) ──
function parseJSON(text) {
  // Strip markdown code fences
  let cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();

  // Try to find JSON object in the text
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found in response');

  try {
    return JSON.parse(match[0]);
  } catch (e) {
    // Try to fix common issues
    let fixed = match[0]
      .replace(/,\s*}/g, '}')     // trailing commas
      .replace(/,\s*]/g, ']')     // trailing commas in arrays
      .replace(/'/g, '"');        // single quotes
    try {
      return JSON.parse(fixed);
    } catch (e2) {
      throw new Error(`Failed to parse JSON: ${e2.message}`);
    }
  }
}

// ── Routes ──

// Health check
app.get('/api/health', (req, res) => {
  const providers = getProviders();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    providers: Object.fromEntries(
      Object.entries(providers).map(([k, v]) => [k, { ready: v.ready, model: v.model }])
    )
  });
});

// List providers
app.get('/api/providers', (req, res) => {
  res.json(getProviders());
});

function getProviders() {
  return {
    gemini: {
      ready: !!process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash'
    },
    glm: {
      ready: !!process.env.GLM_API_KEY,
      model: process.env.GLM_MODEL || 'glm-4.6v-flash'
    }
  };
}

// OCR endpoint
app.post('/api/ocr', upload.single('image'), async (req, res) => {
  const start = Date.now();

  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No image file provided. Use multipart form with "image" field.' });
  }

  const prompt = req.body.prompt || DEFAULT_PROMPT;
  let provider = (req.body.provider || DEFAULT_PROVIDER).toLowerCase();

  if (provider !== 'gemini' && provider !== 'glm') {
    return res.status(400).json({ success: false, error: `Unknown provider: ${provider}. Use "gemini" or "glm".` });
  }

  try {
    let data;
    let model;

    if (provider === 'gemini') {
      if (!process.env.GEMINI_API_KEY) {
        // Fallback to GLM if Gemini not configured
        console.log('[OCR] Gemini not configured, falling back to GLM');
        provider = 'glm';
      }
    }

    if (provider === 'glm' && !process.env.GLM_API_KEY) {
      return res.status(503).json({ success: false, error: 'No API key configured. Set GEMINI_API_KEY or GLM_API_KEY.' });
    }

    if (provider === 'gemini') {
      model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
      console.log(`[OCR] Using Gemini: ${model}`);
      data = await ocrGemini(req.file.buffer, req.file.mimetype, prompt);
    } else {
      model = process.env.GLM_MODEL || 'glm-4.6v-flash';
      console.log(`[OCR] Using GLM: ${model}`);
      data = await ocrGLM(req.file.buffer, req.file.mimetype, prompt);
    }

    const duration = Date.now() - start;
    console.log(`[OCR] ${provider}/${model} — ${duration}ms`);

    res.json({
      success: true,
      provider,
      model,
      duration_ms: duration,
      data
    });

  } catch (err) {
    console.error(`[OCR] Error: ${err.message}`);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ── Start ──
app.listen(PORT, () => {
  const providers = getProviders();
  const ready = Object.values(providers).filter(p => p.ready).map(p => p.model);
  console.log(`\n  📸 OCR Service running on port ${PORT}`);
  console.log(`  📦 Providers ready: ${ready.length > 0 ? ready.join(', ') : 'NONE — set API keys in .env'}`);
  console.log(`  🔑 Default: ${DEFAULT_PROVIDER}\n`);
});
