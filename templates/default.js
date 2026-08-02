// Template: default
// Prompt del sistema para que el LLM genere el config JSON del overlay

export const COMPOSITION_ID = 'auto-overlay-default';

export const buildPrompt = ({ videoAnalysis, product }) => {
  const market = product.market || 'jp';
  const isJp = market === 'jp';

  return {
    system: `Eres un experto en videos virales de TikTok Shop. Generas configuraciones JSON para overlays de video de productos.
Responde ÚNICAMENTE con JSON válido, sin markdown, sin explicaciones.`,

    user: `Genera el config JSON para un overlay de TikTok Shop.

DATOS DEL PRODUCTO:
${JSON.stringify(product, null, 2)}

ANÁLISIS DEL VIDEO (timestamps + speech):
${JSON.stringify(videoAnalysis, null, 2)}

REGLAS:
- language: "${isJp ? 'jp' : 'mx'}"
- hook: array de 1-2 strings (máx 14 chars cada uno para JP, 22 para ES). Hook impactante que enganche en 0-2s. Emoji al final. Amarillo glow.
- features: array de exactamente 4 objetos {line1, line2}. Extraídos del video/producto. Emoji al inicio de line1.
  ${isJp ? '- Japonés: line1 puede ser larga (kanji compacto), line2 complementa' : '- Español: ambas líneas cortas (máx 22 chars) por overflow. SIEMPRE 2 líneas.'}
- reviews: array de exactamente 5 objetos {username, stars, text}. Inventadas pero realistas en ${isJp ? 'japonés' : 'español mexicano'}. Stars entre 4-5. Text máx 45 chars.
- fomo: {line1, line2} — datos reales del producto (ventas, rating, etc). Sin precio.
- cta:
  ${isJp ? '- showPrice: true (Japón siempre muestra precio)' : '- showPrice: false (México nunca muestra precio)'}
  - priceLine: ${isJp ? `"${product.price || ''}" (solo si showPrice=true)` : 'null'}
  - discountLine: ${isJp && product.originalPrice ? `"${product.originalPrice} → ${product.discountPercent}% OFF"` : 'null'}
  - fomoLine: frase de urgencia/FOMO en ${isJp ? 'japonés' : 'español mexicano'}. ${isJp ? 'Emoji 🔥 al final.' : 'Emoji 🔥. Máx 22 chars.'}

RESPONDE SOLO CON ESTE JSON (sin markdown):
{
  "language": "${isJp ? 'jp' : 'mx'}",
  "hook": [...],
  "features": [
    {"line1": "...", "line2": "..."},
    {"line1": "...", "line2": "..."},
    {"line1": "...", "line2": "..."},
    {"line1": "...", "line2": "..."}
  ],
  "reviews": [
    {"username": "...", "stars": 5, "text": "..."},
    {"username": "...", "stars": 5, "text": "..."},
    {"username": "...", "stars": 5, "text": "..."},
    {"username": "...", "stars": 5, "text": "..."},
    {"username": "...", "stars": 4, "text": "..."}
  ],
  "fomo": {"line1": "...", "line2": "..."},
  "cta": {
    "showPrice": ${isJp ? 'true' : 'false'},
    "priceLine": ${isJp ? '"..."' : 'null'},
    "discountLine": ${isJp && product.originalPrice ? '"..."' : 'null'},
    "fomoLine": "..."
  }
}`
  };
};
