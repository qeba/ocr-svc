# 📸 OCR Microservice

Vision-based OCR API that accepts images and returns structured JSON. Built to work as a standalone microservice — any app can call it.

Supports **Google Gemini 2.5 Flash** (primary) and **GLM-4.6V** (fallback) as vision providers. Swap providers without changing your integration.

---

## Features

- 🔌 **REST API** — simple `POST /api/ocr` with multipart image upload
- 🤖 **Multi-provider** — Gemini 2.5 Flash + GLM-4.6V with auto-fallback
- 📦 **Docker-ready** — single `docker-compose up` deployment
- 🧹 **Smart JSON parsing** — strips markdown fences, fixes trailing commas
- 💪 **Auto-retry** — handles rate limits gracefully
- ❤️ **Health checks** — `/api/health` for monitoring

---

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/qeba/ocr-svc.git
cd ocr-svc
npm install
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env — add at least one API key
```

### 3. Run

```bash
# Dev (with auto-reload)
npm run dev

# Production
npm start
```

### Docker

```bash
# Pull from registry
docker pull reg.clouds.my/project/ocr-service:latest

# Or build locally
docker-compose up -d --build
```

---

## Endpoints

### `POST /api/ocr`

Upload an image, get structured OCR data back.

**Request:** `multipart/form-data`

| Field | Type | Required | Description |
|---|---|---|---|
| `image` | File | ✅ | Image file (jpg, png, webp, gif) — max 10MB |
| `prompt` | String | ❌ | Custom extraction prompt (uses default receipt prompt if omitted) |
| `provider` | String | ❌ | `gemini` or `glm` (default: from `DEFAULT_PROVIDER` env) |

**Example — curl:**

```bash
curl -X POST http://localhost:3001/api/ocr \
  -F "image=@receipt.jpg"
```

**Example — custom prompt:**

```bash
curl -X POST http://localhost:3001/api/ocr \
  -F "image=@document.png" \
  -F "prompt=Extract all text from this document. Return as JSON with fields: title, body, language."
```

**Example — specific provider:**

```bash
curl -X POST http://localhost:3001/api/ocr \
  -F "image=@receipt.jpg" \
  -F "provider=glm"
```

**Response (success):**

```json
{
  "success": true,
  "provider": "gemini",
  "model": "gemini-2.5-flash",
  "duration_ms": 4754,
  "data": {
    "merchant": "Shopee",
    "date": "2026-04-01",
    "items": [
      { "name": "USB Cable", "qty": 2, "price": 5.90 },
      { "name": "Phone Case", "qty": 1, "price": 12.50 }
    ],
    "subtotal": 24.30,
    "tax": 1.22,
    "total": 25.52,
    "category": "Online Shopping",
    "payment_method": "Online Banking"
  }
}
```

**Response (error):**

```json
{
  "success": false,
  "error": "No image file provided. Use multipart form with \"image\" field."
}
```

---

### `GET /api/health`

Health check — returns uptime and provider readiness.

```bash
curl http://localhost:3001/api/health
```

```json
{
  "status": "ok",
  "uptime": 1234.5,
  "providers": {
    "gemini": { "ready": true, "model": "gemini-2.5-flash" },
    "glm": { "ready": true, "model": "glm-4.6v-flash" }
  }
}
```

---

### `GET /api/providers`

List all available providers and their status.

```bash
curl http://localhost:3001/api/providers
```

```json
{
  "gemini": {
    "ready": true,
    "model": "gemini-2.5-flash"
  },
  "glm": {
    "ready": true,
    "model": "glm-4.6v-flash"
  }
}
```

---

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3001` | Server listen port |
| `DEFAULT_PROVIDER` | No | `gemini` | Default provider when none specified |
| `GEMINI_API_KEY` | Yes\* | — | Google AI Studio API key |
| `GEMINI_MODEL` | No | `gemini-2.5-flash` | Gemini model to use |
| `GLM_API_KEY` | No | — | z.ai API key (fallback provider) |
| `GLM_BASE_URL` | No | `https://api.z.ai/api/coding/paas/v4` | z.ai API endpoint |
| `GLM_MODEL` | No | `glm-4.6v-flash` | GLM vision model |
| `MAX_FILE_SIZE_MB` | No | `10` | Maximum upload file size |

\*At least one provider API key is required.

### Getting API Keys

**Google Gemini (recommended):**
1. Go to [Google AI Studio](https://aistudio.google.com)
2. Sign in with Google account
3. Click **Get API Key** → Create new key
4. Free tier: 250 requests/day on Gemini 2.5 Flash

**GLM (z.ai):**
1. Sign up at [z.ai](https://z.ai)
2. Get API key from dashboard
3. GLM-4.6V-Flash is free within rate limits

---

## Default OCR Prompt

The built-in prompt extracts receipt data and returns JSON:

```json
{
  "merchant": "Store Name",
  "date": "2026-04-01",
  "items": [
    { "name": "Item", "qty": 1, "price": 9.99 }
  ],
  "subtotal": 9.99,
  "tax": 0.50,
  "total": 10.49,
  "category": "Food|Transport|Bills|Shopping|Online Shopping|Entertainment|Health|Education|Travel|Other",
  "payment_method": "Cash|Card|Online"
}
```

Override with the `prompt` field for custom extraction (invoices, documents, IDs, etc.).

---

## Provider Comparison

| | Gemini 2.5 Flash | GLM-4.6V |
|---|---|---|
| **Speed** | ~4-7 seconds | ~13-14 seconds |
| **Free Tier** | 250 req/day | Rate limited |
| **Vision** | ✅ | ✅ |
| **Accuracy** | High | Good |
| **Best For** | Production use | Fallback |

---

## Docker

### Pull from Registry

```bash
docker pull reg.clouds.my/project/ocr-service:latest
```

### Build Locally

```bash
docker-compose up -d --build
```

### docker-compose.yml

```yaml
services:
  ocr-service:
    image: reg.clouds.my/project/ocr-service:latest
    # or build: . for local build
    container_name: ocr-service
    restart: unless-stopped
    ports:
      - "3001:3001"
    env_file:
      - .env
    environment:
      - PORT=3001
```

---

## Integration Example

Call from any Node.js app:

```javascript
const formData = new FormData();
formData.append('image', imageBuffer, { filename: 'receipt.jpg', type: 'image/jpeg' });

const res = await fetch('http://localhost:3001/api/ocr', {
  method: 'POST',
  body: formData
});

const result = await res.json();
if (result.success) {
  console.log(result.data.merchant);  // "Shopee"
  console.log(result.data.total);     // 25.52
}
```

---

## License

MIT
