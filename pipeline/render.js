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

// Renderiza el overlay con Remotion CLI
export async function renderOverlay({ compositionId, config, jobId }) {
  const outPath = `/tmp/ttchop_post_${jobId}.mp4`;
  const propsJson = JSON.stringify(config).replace(/'/g, "'\\''"); // escape single quotes

  const cmd = `cd ${REMOTION_DIR} && npx remotion render ${ENTRY} ${compositionId} ${outPath} --props='${propsJson}'`;

  execSync(cmd, { timeout: 1_800_000, stdio: 'inherit' });

  return outPath;
}

// Limpia archivos temporales después de enviar la respuesta
export function cleanup(videoFile, outPath) {
  try {
    if (videoFile) {
      const fullPath = path.join(PUBLIC_DIR, videoFile);
      if (existsSync(fullPath)) unlinkSync(fullPath);
    }
    if (outPath && existsSync(outPath)) unlinkSync(outPath);
  } catch (e) {
    console.warn('Cleanup error:', e.message);
  }
}
