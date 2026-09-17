import { execSync } from 'child_process';
import { createWriteStream, unlinkSync, existsSync, mkdirSync } from 'fs';
import { pipeline } from 'stream/promises';
import fetch from 'node-fetch';
import path from 'path';

const REMOTION_DIR = '/tmp/cacho_inmotion';
const PUBLIC_DIR   = `${REMOTION_DIR}/public`;
const ENTRY        = `${REMOTION_DIR}/index.ts`;

// Descarga el video base al directorio público de Remotion
export async function downloadVideo(videoUrl, jobId) {
  const filename = `auto_${jobId}.mp4`;
  const destPath = path.join(PUBLIC_DIR, filename);

  // Defensivo: public/ está en .gitignore de cacho_inmotion (se rellena en runtime),
  // así que un clone fresco del repo no la trae. Sin esto, cualquier reclonación
  // (ej. tras corrupción de .git) tumba todos los renders con ENOENT.
  if (!existsSync(PUBLIC_DIR)) mkdirSync(PUBLIC_DIR, { recursive: true });

  const res = await fetch(videoUrl);
  if (!res.ok) throw new Error(`Error descargando video: ${res.status}`);

  await pipeline(res.body, createWriteStream(destPath));
  return filename; // solo el nombre, para staticFile()
}

// Descarga cualquier asset (imagen o video) a public/, igual que downloadVideo.
// Usado para los mascotSegments: el colorKey en tiempo real de MascotOverlay.jsx
// (igual que el de los FX de green screen) solo funciona con assets servidos desde
// el mismo origen (staticFile) -- una URL remota de Firebase Storage choca con CORS
// en el navegador del renderer y Remotion cae a un modo sin efectos. Descargarlo
// local antes de renderizar evita el problema por completo.
async function downloadAsset(url, filename) {
  const destPath = path.join(PUBLIC_DIR, filename);
  if (!existsSync(PUBLIC_DIR)) mkdirSync(PUBLIC_DIR, { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Error descargando asset de mascota: ${res.status}`);
  await pipeline(res.body, createWriteStream(destPath));
  return filename;
}

// Descarga todos los mascotSegments a public/ y devuelve una copia del array con
// `url` reemplazado por el nombre de archivo local (para usar con staticFile()).
// No falla el render completo si un asset individual no se puede descargar --
// esa línea simplemente no muestra mascota, mejor que tumbar todo el video.
export async function downloadMascotAssets(mascotSegments, jobId) {
  if (!Array.isArray(mascotSegments) || mascotSegments.length === 0) return [];
  const localSegments = [];
  const downloadedFilenames = [];
  for (let i = 0; i < mascotSegments.length; i++) {
    const seg = mascotSegments[i];
    const ext = seg.type === 'video' ? 'mp4' : 'png';
    const filename = `mascot_${jobId}_${i}.${ext}`;
    try {
      await downloadAsset(seg.url, filename);
      localSegments.push({ ...seg, url: filename });
      downloadedFilenames.push(filename);
    } catch (e) {
      console.warn(`[${jobId}] No se pudo descargar mascot segment ${i}:`, e.message);
    }
  }
  return { segments: localSegments, filenames: downloadedFilenames };
}

// Renderiza el overlay con Remotion CLI
export async function renderOverlay({ compositionId, config, jobId }) {
  const outPath = `/tmp/ttchop_post_${jobId}.mp4`;
  const propsJson = JSON.stringify(config).replace(/'/g, "'\\''"); // escape single quotes

  const cmd = `cd ${REMOTION_DIR} && npx remotion render ${ENTRY} ${compositionId} ${outPath} --props='${propsJson}'`;

  execSync(cmd, { timeout: 1_800_000, stdio: 'inherit' });

  return outPath;
}

// Limpia archivos temporales después de enviar la respuesta
// mascotFilenames: opcional, nombres devueltos por downloadMascotAssets.
export function cleanup(videoFile, outPath, mascotFilenames = []) {
  try {
    if (videoFile) {
      const fullPath = path.join(PUBLIC_DIR, videoFile);
      if (existsSync(fullPath)) unlinkSync(fullPath);
    }
    for (const f of mascotFilenames) {
      const fullPath = path.join(PUBLIC_DIR, f);
      if (existsSync(fullPath)) unlinkSync(fullPath);
    }
    if (outPath && existsSync(outPath)) unlinkSync(outPath);
  } catch (e) {
    console.warn('Cleanup error:', e.message);
  }
}
