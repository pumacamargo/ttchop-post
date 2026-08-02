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

// Detecta mercado desde el speech del video (señal más confiable que el HTML de la SPA)
// Japonés (kanji/hiragana/katakana) → 'jp'; cualquier otro idioma → 'mx'
export function detectMarketFromSpeech(videoAnalysis) {
  const speech = JSON.stringify(videoAnalysis);
  const hasJapanese = /[぀-龯＀-￯]/.test(speech);
  return hasJapanese ? 'jp' : 'mx';
}

// Scrape básico del producto desde ttchop.web.app
// NOTA: ttchop.web.app es una SPA React — el HTML inicial no contiene datos del producto.
// El mercado se detecta desde el speech del video (ver detectMarketFromSpeech).
export async function scrapeProduct(productUrl) {
  const res = await fetch(productUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ttchop-post/1.0)' },
  });
  if (!res.ok) throw new Error(`Product fetch failed: ${res.status}`);
  const html = await res.text();

  // Extraer texto visible para el LLM (primeros 3000 chars del texto limpio)
  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 3000);

  // Precios del HTML (mejor esfuerzo — puede no estar disponible en SPAs)
  const yenMatch = html.match(/¥([\d,]+)/);
  const price = yenMatch ? `¥${yenMatch[1]}` : null;

  return { url: productUrl, price, rawText: text };
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
