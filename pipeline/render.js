import { execSync } from 'child_process';
import { createWriteStream, unlinkSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { pipeline } from 'stream/promises';
import { createHash } from 'crypto';
import fetch from 'node-fetch';
import path from 'path';
import { initializeApp as fbInitApp, cert as fbCert, getApp as fbGetApp } from 'firebase-admin/app';
import { getStorage as fbGetStorage } from 'firebase-admin/storage';

// remove.bg API — quita el fondo de imágenes de mascota con IA, sin tocar la RAM local.
// 50 imágenes/mes gratis en el plan free. Key en REMOVEBG_API_KEY.
// Caché en Firebase Storage (MASCOT_PROCESSED_BUCKET): evita llamar remove.bg dos veces
// por la misma imagen. Path: mascot_processed/{sha256_de_url}.png
const REMOVEBG_API_KEY = process.env.REMOVEBG_API_KEY;
const MASCOT_PROCESSED_BUCKET = process.env.MASCOT_PROCESSED_BUCKET || 'ttchop2.firebasestorage.app';
const SA_PATH = process.env.FIREBASE_SA_PATH || '/root/ttchop2-service-account.json';

// Inicializa Firebase Admin para el bucket de caché de mascotas (solo una vez)
let _storageBucket = null;
function getMascotBucket() {
  if (_storageBucket) return _storageBucket;
  const appName = 'overlay-mascot-cache';
  let app;
  try {
    app = fbGetApp(appName);
  } catch {
    app = fbInitApp({
      credential: fbCert(JSON.parse(readFileSync(SA_PATH, 'utf8'))),
      storageBucket: MASCOT_PROCESSED_BUCKET,
    }, appName);
  }
  _storageBucket = fbGetStorage(app).bucket();
  return _storageBucket;
}

const REMOTION_DIR = '/root/projects/ttchop/ttchop-post_templates';
const PUBLIC_DIR   = `${REMOTION_DIR}/public`;
const ENTRY        = `${REMOTION_DIR}/index.ts`;

// Green screen anime FX — fuente de verdad en Firebase Storage.
// El colorKey de Remotion necesita staticFile() (CORS bloquea URLs remotas en headless Chrome),
// así que se descargan a public/ si no existen. No se borran en cleanup — persisten entre renders.
// Pack completo: part1..part24. Los usados actualmente: 18, 20, 21.
// Para agregar más: añadir el número al array GS_PARTS_USED.
const GS_BUCKET = process.env.FIREBASE_STORAGE_BUCKET || 'ttchop.firebasestorage.app';
const GS_PARTS_USED = [18, 20, 21];

export async function ensureGreenScreenAssets() {
  const gsDir = path.join(PUBLIC_DIR, 'greenscreen', 'anime', 'videos');
  if (!existsSync(gsDir)) mkdirSync(gsDir, { recursive: true });

  for (const n of GS_PARTS_USED) {
    const localPath = path.join(gsDir, `gs_anime_${n}.mp4`);
    if (existsSync(localPath)) continue;
    const url = `https://firebasestorage.googleapis.com/v0/b/${GS_BUCKET}/o/greenscreen%2Fanime%2Fpart${n}.mp4?alt=media`;
    console.log(`[GS] Descargando gs_anime_${n}.mp4 desde Firebase...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`No se pudo descargar gs_anime_${n}.mp4: ${res.status}`);
    await pipeline(res.body, createWriteStream(localPath));
    console.log(`[GS] gs_anime_${n}.mp4 listo`);
  }
}

// Descarga el video base al directorio público de Remotion
export async function downloadVideo(videoUrl, jobId) {
  const filename = `auto_${jobId}.mp4`;
  const destPath = path.join(PUBLIC_DIR, filename);

  // Defensivo: public/ está en .gitignore de ttchop-post_templates (se rellena en runtime),
  // así que un clone fresco del repo no la trae. Sin esto, cualquier reclonación
  // (ej. tras corrupción de .git) tumba todos los renders con ENOENT.
  if (!existsSync(PUBLIC_DIR)) mkdirSync(PUBLIC_DIR, { recursive: true });

  const res = await fetch(videoUrl);
  if (!res.ok) throw new Error(`Error descargando video: ${res.status}`);

  await pipeline(res.body, createWriteStream(destPath));
  return filename; // solo el nombre, para staticFile()
}

// Descarga un asset de mascota a public/.
// Para imágenes: primero busca PNG procesado en caché (Firebase Storage mascot_processed/).
// Si no existe, llama a remove.bg → guarda en caché → descarga local.
// Para videos: descarga directo (colorKey de Remotion se aplica en tiempo real).
async function downloadAsset(url, filename, isImage) {
  if (!existsSync(PUBLIC_DIR)) mkdirSync(PUBLIC_DIR, { recursive: true });
  const destPath = path.join(PUBLIC_DIR, filename);

  if (isImage) {
    const urlHash = createHash('sha256').update(url).digest('hex').slice(0, 16);
    const cachePath = `mascot_processed/${urlHash}.png`;
    const bucket = getMascotBucket();

    // 1. Revisar caché en Firebase Storage
    const [cacheExists] = await bucket.file(cachePath).exists();
    if (cacheExists) {
      console.log(`[mascot-cache] HIT ${urlHash} — saltando remove.bg`);
      const [contents] = await bucket.file(cachePath).download();
      writeFileSync(destPath, contents);
      return filename;
    }

    // 2. Descargar imagen original
    console.log(`[mascot-cache] MISS ${urlHash} — llamando remove.bg`);
    const imgRes = await fetch(url);
    if (!imgRes.ok) throw new Error(`Error descargando mascota imagen: ${imgRes.status}`);
    const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

    // 3. remove.bg → PNG sin fondo
    const formData = new FormData();
    formData.append('image_file', new Blob([imgBuffer]), 'mascot.jpg');
    formData.append('size', 'auto');
    const bgRes = await fetch('https://api.remove.bg/v1.0/removebg', {
      method: 'POST',
      headers: { 'X-Api-Key': REMOVEBG_API_KEY },
      body: formData,
    });
    if (!bgRes.ok) {
      const err = await bgRes.text();
      throw new Error(`remove.bg error ${bgRes.status}: ${err.slice(0, 200)}`);
    }
    const pngBuffer = Buffer.from(await bgRes.arrayBuffer());

    // 4. Guardar en caché y en disco local en paralelo
    writeFileSync(destPath, pngBuffer);
    await bucket.file(cachePath).save(pngBuffer, { metadata: { contentType: 'image/png' } });
    console.log(`[mascot-cache] Guardado ${urlHash} en ${cachePath}`);
  } else {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Error descargando mascota video: ${res.status}`);
    await pipeline(res.body, createWriteStream(destPath));
  }
  return filename;
}

// Descarga todos los mascotSegments a public/ y devuelve una copia del array con
// `url` reemplazado por el nombre de archivo local (para usar con staticFile()).
// No falla el render completo si un asset individual no se puede descargar —
// esa segmento simplemente no muestra mascota, mejor que tumbar todo el video.
export async function downloadMascotAssets(mascotSegments, jobId) {
  if (!Array.isArray(mascotSegments) || mascotSegments.length === 0) return { segments: [], filenames: [] };
  const localSegments = [];
  const downloadedFilenames = [];
  for (let i = 0; i < mascotSegments.length; i++) {
    const seg = mascotSegments[i];
    const isImage = seg.type !== 'video';
    const filename = `mascot_${jobId}_${i}.${isImage ? 'png' : 'mp4'}`;
    try {
      await downloadAsset(seg.url, filename, isImage);
      localSegments.push({ ...seg, url: filename });
      downloadedFilenames.push(filename);
    } catch (e) {
      console.warn(`[${jobId}] No se pudo procesar mascot segment ${i}:`, e.message);
    }
  }
  return { segments: localSegments, filenames: downloadedFilenames };
}

// Sube el base overlay (Remotion sin mascota) a Firebase Storage para poder re-aplicar
// mascota después sin re-renderizar. Path: base_overlays/base_{jobId}.mp4
// Devuelve la URL pública con token.
export async function uploadBaseOverlay(localPath, jobId) {
  const bucket      = getMascotBucket();
  const remotePath  = `base_overlays/base_${jobId}.mp4`;
  // Generar token explícito — el admin SDK no lo asigna automáticamente al subir
  const token       = createHash('sha256').update(`base_${jobId}_${Date.now()}`).digest('hex').slice(0, 32);
  await bucket.upload(localPath, {
    destination: remotePath,
    metadata: {
      contentType: 'video/mp4',
      metadata: { firebaseStorageDownloadTokens: token },
    },
  });
  const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(remotePath)}?alt=media&token=${token}`;
  console.log(`[${jobId}] Base overlay subido: ${remotePath}`);
  return url;
}

// Aplica los mascotSegments (ya descargados a public/) sobre el video base con ffmpeg.
// Mucho más rápido que colorKey en Remotion: ffmpeg hace el compositing en segundos.
// localMascotSegments: array devuelto por downloadMascotAssets (url = nombre de archivo local).
export async function applyMascotWithFfmpeg(inputPath, outputPath, localMascotSegments, jobId) {
  if (!localMascotSegments || localMascotSegments.length === 0) return;

  // Mismos valores que MascotOverlay.jsx (MASCOT_WIDTH_FRACTION=0.6, MASCOT_MARGIN_PX=40, bottom-right)
  const W      = Math.round(1080 * 0.6); // 648px
  const MARGIN = 40;
  const OX     = 1080 - W - MARGIN;      // 392
  const OY     = 1920 - W - MARGIN;      // 1232

  // Un -i por segmento (los archivos locales ya están en PUBLIC_DIR)
  const inputArgs = localMascotSegments
    .map(seg => `-i "${path.join(PUBLIC_DIR, seg.url)}"`)
    .join(' ');

  // Shadow CSS original: drop-shadow(14px 18px 10px rgba(0,0,0,0.75))
  const SHADOW_DX = 14;
  const SHADOW_DY = 18;

  // filter_complex: por cada PNG → escalar + split en imagen y sombra,
  // luego dos overlays por segmento (sombra offset primero, imagen encima).
  const scaleParts   = [];
  const overlayParts = [];
  let prevLabel = '0:v';

  for (let i = 0; i < localMascotSegments.length; i++) {
    const seg       = localMascotSegments[i];
    const imgLabel  = `img${i}`;
    const shadSrc   = `ss${i}`;
    const shadLabel = `sh${i}`;
    const vShadow   = `vs${i}`;
    const outLabel  = i === localMascotSegments.length - 1 ? 'vout' : `r${i}`;
    const enable    = `enable='between(t,${seg.startSec},${seg.endSec})'`;

    // Escalar PNG a WxW y dividir en dos streams: imagen y fuente de sombra
    scaleParts.push(
      `[${i + 1}:v]scale=${W}:${W}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${W}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba,split=2[${imgLabel}][${shadSrc}]`
    );
    // Sombra: hacer todos los pixels negros con 75% del alpha original, luego blur
    scaleParts.push(
      `[${shadSrc}]colorchannelmixer=rr=0:rg=0:rb=0:ra=0:gr=0:gg=0:gb=0:ga=0:` +
      `br=0:bg=0:bb=0:ba=0:ar=0:ag=0:ab=0:aa=0.75,gblur=sigma=5[${shadLabel}]`
    );
    // Primero overlay de sombra (offset), luego imagen encima
    overlayParts.push(
      `[${prevLabel}][${shadLabel}]overlay=${OX + SHADOW_DX}:${OY + SHADOW_DY}:${enable}[${vShadow}]`
    );
    overlayParts.push(
      `[${vShadow}][${imgLabel}]overlay=${OX}:${OY}:${enable}[${outLabel}]`
    );
    prevLabel = outLabel;
  }

  const filterComplex = [...scaleParts, ...overlayParts].join(';');

  const cmd = [
    'ffmpeg',
    `-i "${inputPath}"`,
    inputArgs,
    `-filter_complex "${filterComplex}"`,
    '-map "[vout]" -map 0:a',
    '-c:v libx264 -preset fast -crf 18',
    '-c:a copy',
    `-y "${outputPath}"`,
  ].join(' ');

  console.log(`[${jobId}] ffmpeg mascota: ${localMascotSegments.length} segmentos...`);
  execSync(cmd, { timeout: 300_000, stdio: 'inherit' });
  console.log(`[${jobId}] ffmpeg mascota: listo`);
}

// Renderiza el overlay con Remotion CLI
export async function renderOverlay({ compositionId, config, jobId }) {
  const outPath = `/tmp/ttchop_post_${jobId}.mp4`;
  const propsJson = JSON.stringify(config).replace(/'/g, "'\\''"); // escape single quotes

  const cmd = `cd ${REMOTION_DIR} && npx remotion render ${ENTRY} ${compositionId} ${outPath} --props='${propsJson}'`;

  execSync(cmd, { timeout: 1_800_000, stdio: 'inherit' });

  return outPath;
}

// ── Personaje animado (Rive + character-clip) ──────────────────────────────────
// Verde de fondo del personaje — DEBE coincidir con CHARACTER_GREEN en CharacterClip.jsx.
const CHARACTER_GREEN = '0x00b140';
const CHARACTER_RIV_NAME = 'aato02.riv';

// Descarga el .riv del personaje a public/ si no está ya ahí. Fuente de verdad:
// Firebase Storage character/aato01_jointtest01.riv (bucket ttchop2, vía admin SDK
// igual que el caché de mascotas — no depende de que el bucket sea público).
export async function ensureCharacterAssets() {
  const localPath = path.join(PUBLIC_DIR, CHARACTER_RIV_NAME);
  if (existsSync(localPath)) return;
  if (!existsSync(PUBLIC_DIR)) mkdirSync(PUBLIC_DIR, { recursive: true });
  console.log('[character] Descargando .riv desde Firebase Storage...');
  const bucket = getMascotBucket();
  const [contents] = await bucket.file(`character/${CHARACTER_RIV_NAME}`).download();
  writeFileSync(localPath, contents);
  console.log('[character] .riv listo');
}

// Renderiza el personaje (composición "character-clip") sobre fondo verde con Remotion CLI.
// props: { rivFile, audioFile, duration, mouthCues, browCues, bodyCues, blinkTimes }
// rivFile y audioFile deben estar ya en PUBLIC_DIR (usar staticFile() del lado de Remotion).
export async function renderCharacterClip({ props, jobId, frames }) {
  const outPath = `/tmp/character_${jobId}.mp4`;
  const propsJson = JSON.stringify(props).replace(/'/g, "'\\''");
  const framesFlag = frames ? `--frames=0-${frames - 1}` : '';
  const cmd = `cd ${REMOTION_DIR} && npx remotion render ${ENTRY} character-clip ${outPath} --props='${propsJson}' --concurrency=1 ${framesFlag}`.trim();
  execSync(cmd, { timeout: 1_800_000, stdio: 'inherit' });
  return outPath;
}

// Compone el clip del personaje (fondo verde) sobre el video base con chromakey de ffmpeg.
// NO usa el audio del clip del personaje — el video base ya trae el audio final del diálogo
// (viene del collage), meter el audio del personaje otra vez causaría eco.
// W/MARGIN: mismos valores que MascotOverlay.jsx / applyMascotWithFfmpeg (abajo, centrado horizontal).
export async function applyCharacterWithFfmpeg(inputPath, outputPath, characterClipPath, jobId, duration, variant = 'a', forceDuration = null) {
  let W, OX, OY;
  if (variant === 'b') {
    // Variante B: VTuber esquina inferior derecha.
    // W=1053 (mismo tamaño). OX=350 hace que el canvas desborde por la derecha
    // y el personaje quede visible en la mitad derecha de la pantalla.
    // OY=867 → pies al borde inferior de pantalla.
    W  = Math.round(1080 * 0.65 * 1.5); // 1053px
    OX = 200;
    OY = 1100; // medium shot — corta de cintura para abajo
  } else {
    const MARGIN = 0;
    W  = Math.round(1080 * 0.65); // 702px
    OX = Math.round((1080 - W) / 2);
    OY = 1920 - W - MARGIN;
  }

  // `duration` es la duración del diálogo del PERSONAJE (su propio TTS), no la del
  // audio real del video base (que es el que queda en el output vía -map 0:a). Si el
  // guion del personaje es más corto que el del video base (caso típico: el collage
  // ya trae su propio diálogo, más largo), usar `duration` como -t cortaba el audio
  // real a la mitad de la frase. Usamos la duración real del video base (o la del
  // personaje si por algún motivo es más larga) para nunca truncar el audio real.
  const probeCmd = `ffprobe -v error -show_entries format=duration -of csv=p=0 "${inputPath}"`;
  const baseDuration = parseFloat(execSync(probeCmd).toString().trim()) || duration;
  const finalDuration = forceDuration ?? Math.max(duration, baseDuration);

  // Mismo truco de sombra que applyMascotWithFfmpeg: split el personaje ya keado en
  // imagen + fuente de sombra, la sombra se pone toda negra con 75% del alpha original
  // + blur, y se overlea offseteada ANTES que la imagen real (drop-shadow(14px 18px 10px
  // rgba(0,0,0,0.75)), igual que MascotOverlay.jsx).
  const SHADOW_DX = 14;
  const SHADOW_DY = 18;

  // despill quita el tinte verde que queda pegado en los bordes por el antialiasing
  // del chromakey — sin esto se ve un fleco verde delgado alrededor del personaje.
  const filterComplex = [
    `[1:v]chromakey=${CHARACTER_GREEN}:0.10:0.05,despill=type=green:mix=0.5:expand=0,scale=${W}:${W},format=rgba,split=2[img][shadSrc]`,
    `[shadSrc]colorchannelmixer=rr=0:rg=0:rb=0:ra=0:gr=0:gg=0:gb=0:ga=0:br=0:bg=0:bb=0:ba=0:ar=0:ag=0:ab=0:aa=0.75,gblur=sigma=5[shadow]`,
    `[0:v][shadow]overlay=${OX + SHADOW_DX}:${OY + SHADOW_DY}[vshadow]`,
    `[vshadow][img]overlay=${OX}:${OY}[vout]`,
  ].join(';');

  // -stream_loop -1 hace infinito el input 0 (video base) para que alcance a cubrir
  // audio/personaje más largos. Con un input infinito, "-shortest" NO corta el output
  // (el overlay filter repite el último frame del input corto pero nunca da EOF real,
  // así que ffmpeg nunca termina solo) — hay que forzar el corte con "-t duration".
  const cmd = [
    'ffmpeg',
    '-stream_loop -1',
    `-i "${inputPath}"`,
    `-i "${characterClipPath}"`,
    `-filter_complex "${filterComplex}"`,
    '-map "[vout]" -map 0:a',
    `-t ${finalDuration}`,
    '-c:v libx264 -preset fast -crf 18',
    '-c:a aac -b:a 192k', // -c:a copy falla porque el loop reinicia el stream de audio
    `-y "${outputPath}"`,
  ].join(' ');

  console.log(`[${jobId}] ffmpeg personaje: componiendo...`);
  execSync(cmd, { timeout: 1_800_000, stdio: 'inherit' });
  console.log(`[${jobId}] ffmpeg personaje: listo`);
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
