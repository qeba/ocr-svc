# OCR Microservice

## What

Vision-based OCR API that accepts images and returns structured data (JSON). Works with any vision model — switch providers without changing the API.

## Endpoints

### POST /api/ocr
Upload an image, get structured data back.

**Request:** `multipart/form-data`
- `image` — image file (jpg, png, webp)
- `prompt` — (optional) custom extraction prompt
- `provider` — (optional) `gemini` | `glm` (default: `gemini`)

**Response:**
```json
{
  "success": true,
  "provider": "gemini",
  "model": "gemini-2.5-flash",
  "duration_ms": 2340,
  "data": {
    "merchant": "Shopee",
    "date": "2026-04-01",
    "items": [...],
    "total": "RM 28.89"
  }
}
```

### GET /api/health
Health check — returns provider status.

### GET /api/providers
List available providers and their status.

## Setup

```bash
# Install
npm install

# Set API keys
export GEMINI_API_KEY=your-key
export GLM_API_KEY=your-key  # optional

# Run
npm start
```

## Config (env vars)

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | 3001 | Server port |
| `DEFAULT_PROVIDER` | No | `gemini` | Default vision provider |
| `GEMINI_API_KEY` | Yes* | — | Google AI Studio API key |
| `GLM_API_KEY` | No | — | z.ai API key (fallback) |
| `GLM_BASE_URL` | No | `https://api.z.ai/api/coding/paas/v4` | z.ai endpoint |
| `GLM_MODEL` | No | `glm-4.6v-flash` | z.ai vision model |
| `GEMINI_MODEL` | No | `gemini-2.5-flash` | Gemini model |
| `MAX_FILE_SIZE_MB` | No | 10 | Max upload size |

*At least one provider key is required.

## Default OCR Prompt

Extracts: merchant, date, items (name, qty, price), subtotal, tax, total, category, payment_method. Returns JSON.
