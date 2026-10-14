import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';
import { createWriteStream, existsSync, mkdirSync, unlinkSync } from 'fs';
import { pipeline as streamPipeline } from 'stream/promises';
import path from 'path';
import fetch from 'node-fetch';
import archiver from 'archiver';

const REMOTION_DIR = '/root/projects/ttchop/ttchop-post_templates';
const PUBLIC_DIR = `${REMOTION_DIR}/public`;
const ENTRY = `${REMOTION_DIR}/index.ts`;
const COMPOSITION_ID = 'CarouselSlide';

// Descarga cada fondo (ya re-subido a Firebase Storage por ttchop-server en la Fase 1)
// a public/ — Remotion headless no puede leer URLs remotas por CORS, mismo patrón que
// downloadVideo() en pipeline/render.js.
async function downloadBg(url, filename) {
  if (!existsSync(PUBLIC_DIR)) mkdirSync(PUBLIC_DIR, { recursive: true });
  const destPath = path.join(PUBLIC_DIR, filename);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Error descargando fondo: ${res.status} (${url})`);
  await streamPipeline(res.body, createWriteStream(destPath));
  return filename;
}

// bundle() UNA sola vez por job (plan TTC-55 §2): "npx remotion render" por slide
// re-empaquetaría cada vez (~20-40s por slide). bundle()+renderStill() hace el bundle
// 1 vez (~15-20s) y cada still toma 1-3s — así un carrusel de 7 slides tarda ~40s
// como dice el plan §11, no 7x el costo de un bundle completo.
export async function renderCarouselSlides({ jobId, slides, style }) {
  if (!Array.isArray(slides) || slides.length === 0) throw new Error('slides es requerido y no puede estar vacío');

  const localBgFilenames = [];
  for (const slide of slides) {
    if (!slide.bgUrl) throw new Error(`slide index ${slide.index} no tiene bgUrl`);
    const filename = `carousel_${jobId}_bg_${slide.index}.png`;
    await downloadBg(slide.bgUrl, filename);
    localBgFilenames.push(filename);
  }

  console.log(`[carousel-render] [${jobId}] bundling...`);
  const serveUrl = await bundle({ entryPoint: ENTRY });

  const outputs = [];
  try {
    for (let i = 0; i < slides.length; i++) {
      const slide = slides[i];
      const inputProps = {
        bg: localBgFilenames[i],
        text: slide.text || '',
        role: slide.role || 'body',
        slideIndex: slide.index,
        total: slides.length,
        style: style || {},
      };

      const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps });
      const outPath = `/tmp/carousel_${jobId}_slide_${slide.index}.png`;
      console.log(`[carousel-render] [${jobId}] rendering slide ${slide.index} (${i + 1}/${slides.length})...`);
      await renderStill({ composition, serveUrl, output: outPath, inputProps, imageFormat: 'png' });
      outputs.push({ index: slide.index, path: outPath });
    }
  } finally {
    // Los fondos descargados son temporales — no hace falta dejarlos en public/
    // (a diferencia de los assets de mascota/green screen, que sí persisten entre renders).
    for (const filename of localBgFilenames) {
      try { unlinkSync(path.join(PUBLIC_DIR, filename)); } catch {}
    }
  }

  return outputs; // [{ index, path }]
}

export async function zipSlides(jobId, outputs) {
  const zipPath = `/tmp/carousel_${jobId}_package.zip`;
  await new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    for (const o of outputs) {
      archive.file(o.path, { name: `slide_${o.index}.png` });
    }
    archive.finalize();
  });
  return zipPath;
}
