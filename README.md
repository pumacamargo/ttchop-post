# ttchop-post 🎬

Servidor de generación automática de overlays para TikTok Shop. Recibe una URL de video y una URL de producto, y devuelve un MP4 listo para publicar.

## Cómo funciona

```
videoUrl + productUrl
    │
    ├─► Webhook de análisis de video (ttchop)
    ├─► Scrape del producto
    └─► LLM (Claude Haiku 4.5 via OpenRouter) → config JSON
                │
                ▼
         Remotion render (AutoOverlay)
                │
                ▼
            MP4 response
```

## Requisitos

- Node.js 18+
- ffprobe (para detectar duración del video)
- [Remotion](https://www.remotion.dev/) instalado en `/tmp/cacho_inmotion`
- Cuenta en [OpenRouter](https://openrouter.ai/)
- PM2 (para correr en producción)

## Instalación

```bash
git clone https://github.com/pumacamargo/ttchop-post.git
cd ttchop-post
npm install
cp .env.example .env
# Editar .env con tu API key
```

## Variables de entorno

```env
OPENROUTER_API_KEY=sk-or-v1-...
PORT=3001
```

## Correr el servidor

**Desarrollo:**
```bash
npm run dev
```

**Producción con PM2:**
```bash
pm2 start server.js --name ttchop-post
pm2 save
pm2 startup  # para que arranque automático al reiniciar el VPS
```

## Endpoints

### `POST /render`

Genera un overlay completo y devuelve el MP4.

**Body:**
```json
{
  "videoUrl": "https://tu-dominio.com/uploads/video.mp4",
  "productUrl": "https://ttchop.web.app/p/prod_xxx",
  "template": "default"
}
```

| Campo | Tipo | Requerido | Default |
|-------|------|-----------|---------|
| `videoUrl` | string | ✅ | — |
| `productUrl` | string | ✅ | — |
| `template` | string | ❌ | `"default"` |

**Response:** archivo MP4 (stream)

Headers de respuesta:
- `Content-Type: video/mp4`
- `X-Job-Id: <id>` — ID único del job para debugging

**Ejemplo con curl:**
```bash
curl -X POST http://localhost:3001/render \
  -H "Content-Type: application/json" \
  -d '{
    "videoUrl": "https://lemonsushi.com/uploads/ttchop/collage/video.mp4",
    "productUrl": "https://ttchop.web.app/p/prod_abc123"
  }' \
  --output overlay.mp4
```

**Ejemplo con fetch (JavaScript):**
```js
const res = await fetch('http://tu-vps:3001/render', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ videoUrl, productUrl }),
});
const buffer = await res.arrayBuffer();
fs.writeFileSync('overlay.mp4', Buffer.from(buffer));
```

**Desde n8n:**
- Nodo: HTTP Request
- Method: POST
- URL: `http://[IP-VPS]:3001/render`
- Body: JSON con `videoUrl` y `productUrl`
- Response: Binary (guardar como archivo)

### `GET /health`

Verifica que el servidor esté corriendo.

```bash
curl http://localhost:3001/health
```

```json
{
  "status": "ok",
  "templates": ["default"],
  "uptime": 3600
}
```

## Templates

Cada template define el estilo visual del overlay y el prompt que usa el LLM para generar el contenido.

### Template: `default`

Estilo anime con efectos de green screen (gs_anime_18, gs_anime_20, gs_anime_21):

- **FASE 1 — HOOK** (0–3.5s): CameraShake + texto amarillo + FX radial naranja
- **FASE 2 — FEATURES** (4s en adelante): 4 features con WaveUpText blanco
- **Transición**: Speed lines (gs_anime_21)
- **FloatingReviews**: 5 tarjetas de reseña dispersas
- **FOMO**: Estadísticas del producto
- **FASE 3 — CTA**: Gold ring FX + precio (Japón) o mensaje FOMO (México)

**Reglas automáticas:**
- 🇯🇵 Japón → muestra precio
- 🇲🇽 México → sin precio, solo FOMO
- Español → texto en 2 líneas para evitar overflow
- Japonés → línea única (kanji compacto)

### Agregar un template nuevo

1. Crear `templates/mi-template.js`:

```js
export const COMPOSITION_ID = 'mi-composicion-remotion';

export const buildPrompt = ({ videoAnalysis, product }) => ({
  system: 'Eres experto en TikTok Shop...',
  user: `Genera config para: ${JSON.stringify(product)}...`,
});
```

2. Registrarlo en `server.js`:

```js
import * as miTemplate from './templates/mi-template.js';

const TEMPLATES = {
  default: defaultTemplate,
  'mi-template': miTemplate,
};
```

3. Crear el componente Remotion correspondiente en `/tmp/cacho_inmotion/src/`

4. Usarlo:
```bash
curl -X POST .../render -d '{"template": "mi-template", ...}'
```

## Estructura del proyecto

```
ttchop-post/
├── server.js              # Express server + routing
├── pipeline/
│   ├── analyze.js         # Webhook análisis de video + scrape producto
│   ├── generate.js        # Llamada a OpenRouter LLM
│   └── render.js          # Descarga video + Remotion CLI render
├── templates/
│   └── default.js         # Template default (estilo anime)
├── .env.example           # Variables de entorno de ejemplo
└── package.json
```

## Config JSON que genera el LLM

El LLM produce un JSON con esta estructura (pasado como `inputProps` a Remotion):

```json
{
  "videoFile": "auto_abc123.mp4",
  "duration": 44.8,
  "language": "jp",
  "hook": ["これ神ガジェット！🔥"],
  "features": [
    { "line1": "⚡ わずか62g", "line2": "超軽量デザイン" },
    { "line1": "💡 1,600ニット", "line2": "直射日光でも鮮明" },
    { "line1": "📺 140インチ相当", "line2": "120Hz対応" },
    { "line1": "🎮 ゲーム・映画", "line2": "まるで本物の体験" }
  ],
  "reviews": [
    { "username": "k***n", "stars": 5, "text": "最高すぎる😂" }
  ],
  "fomo": { "line1": "⭐ 2,100台突破！", "line2": "大人気商品" },
  "cta": {
    "showPrice": true,
    "priceLine": "¥43,980",
    "discountLine": null,
    "fomoLine": "今すぐTikTokショップでチェック🔥"
  }
}
```

## Notas

- El render de un video de ~45s tarda aprox. 5 min
- El servidor procesa una solicitud a la vez (sincrónico)
- Los archivos temporales se limpian automáticamente después de cada render
- Timeout del render: 30 minutos (configurable en `pipeline/render.js`)
