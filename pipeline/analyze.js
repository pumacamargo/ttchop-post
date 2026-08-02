import fetch from 'node-fetch';

const WEBHOOK_URL = 'https://flows.lemonsushi.com/webhook/ttchop_video_dissect';

// Llama al webhook de análisis de video
export async function analyzeVideo(videoUrl) {
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: videoUrl }),
  });
  if (!res.ok) throw new Error(`Video webhook failed: ${res.status}`);
  const data = await res.json();
  return data.data ?? data;
}

// Scrape básico del producto desde ttchop.web.app
export async function scrapeProduct(productUrl) {
  const res = await fetch(productUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ttchop-post/1.0)' },
  });
  if (!res.ok) throw new Error(`Product fetch failed: ${res.status}`);
  const html = await res.text();

  // Extraer datos del HTML con regex básicos
  const get = (pattern) => {
    const m = html.match(pattern);
    return m ? m[1].trim() : null;
  };

  // Detectar mercado por moneda/idioma
  const hasYen = html.includes('¥') || html.includes('円');
  const hasMxn = html.includes('$') && (html.includes('MXN') || html.includes('mx'));
  const market = hasYen ? 'jp' : hasMxn ? 'mx' : 'jp';

  // Extraer precio actual
  const priceMatch = html.match(/[¥$]([\d,]+(?:\.\d{2})?)/);
  const price = priceMatch ? priceMatch[0] : null;

  // Extraer texto visible para el LLM (primeros 3000 chars del texto limpio)
  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 3000);

  return { url: productUrl, market, price, rawText: text };
}

// Obtiene duración del video via ffprobe
export async function getVideoDuration(videoUrl) {
  const { execSync } = await import('child_process');
  try {
    const out = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoUrl}"`,
      { timeout: 15000 }
    ).toString().trim();
    return parseFloat(out) || 30;
  } catch {
    return 30;
  }
}
