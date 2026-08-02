import 'dotenv/config';
import express from 'express';
import { randomBytes } from 'crypto';
import { createReadStream, statSync } from 'fs';
import { analyzeVideo, scrapeProduct, getVideoDuration } from './pipeline/analyze.js';
import { generateConfig } from './pipeline/generate.js';
import { downloadVideo, renderOverlay, cleanup } from './pipeline/render.js';
import * as defaultTemplate from './templates/default.js';

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

// Mapa de templates disponibles
const TEMPLATES = {
  default: defaultTemplate,
};

// ── POST /render ──────────────────────────────────────────────────────────────
// Body: { videoUrl, productUrl, template? }
// Response: MP4 file stream
app.post('/render', async (req, res) => {
  const { videoUrl, productUrl, template: templateName = 'default' } = req.body;

  if (!videoUrl || !productUrl) {
    return res.status(400).json({ error: 'videoUrl y productUrl son requeridos' });
  }

  const template = TEMPLATES[templateName];
  if (!template) {
    return res.status(400).json({ error: `Template "${templateName}" no existe. Disponibles: ${Object.keys(TEMPLATES).join(', ')}` });
  }

  const jobId = randomBytes(6).toString('hex');
  let videoFile = null;
  let outPath   = null;

  console.log(`[${jobId}] START — ${templateName} | ${videoUrl}`);

  try {
    // 1. Análisis en paralelo
    console.log(`[${jobId}] Analizando video y producto...`);
    const [videoAnalysis, product, duration] = await Promise.all([
      analyzeVideo(videoUrl),
      scrapeProduct(productUrl),
      getVideoDuration(videoUrl),
    ]);
    console.log(`[${jobId}] Duración: ${duration}s | Mercado: ${product.market}`);

    // 2. Generar config con LLM
    console.log(`[${jobId}] Generando config con LLM...`);
    const overlayConfig = await generateConfig({ videoAnalysis, product, template });

    // 3. Descargar video base
    console.log(`[${jobId}] Descargando video...`);
    videoFile = await downloadVideo(videoUrl, jobId);

    // 4. Construir props completas para Remotion
    const props = {
      videoFile,
      duration,
      ...overlayConfig,
    };

    // 5. Renderizar
    console.log(`[${jobId}] Renderizando ${Math.round(duration * 25)} frames...`);
    outPath = await renderOverlay({
      compositionId: template.COMPOSITION_ID,
      config: props,
      jobId,
    });

    const stat = statSync(outPath);
    console.log(`[${jobId}] DONE — ${(stat.size / 1024 / 1024).toFixed(1)}MB`);

    // 6. Responder con el archivo MP4
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="overlay_${jobId}.mp4"`);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('X-Job-Id', jobId);

    const stream = createReadStream(outPath);
    stream.pipe(res);
    stream.on('end', () => cleanup(videoFile, outPath));
    stream.on('error', (e) => { console.error(e); cleanup(videoFile, outPath); });

  } catch (err) {
    console.error(`[${jobId}] ERROR:`, err.message);
    cleanup(videoFile, outPath);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message, jobId });
    }
  }
});

// ── GET /health ───────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({
  status: 'ok',
  templates: Object.keys(TEMPLATES),
  uptime: process.uptime(),
}));

app.listen(PORT, () => {
  console.log(`ttchop-post 🎬 corriendo en puerto ${PORT}`);
  console.log(`Templates: ${Object.keys(TEMPLATES).join(', ')}`);
});
