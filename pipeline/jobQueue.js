// Cola simple de concurrencia 1, adaptada del patrón de ttchop-server/pipeline/jobQueue.js
// (plan TTC-55 §2: "pasa por el jobQueue para no competir en RAM con los renders de
// video"). A diferencia de la versión de ttchop-server (fire-and-forget, el caller no
// espera el resultado), acá el endpoint /carousel/render-slides tiene que devolver el
// ZIP en la misma respuesta HTTP, así que enqueue() devuelve una promesa que resuelve
// cuando el job corre.
const COOLDOWN_MS = 2_000;

const queue = [];
let isRunning = false;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function drain() {
  if (isRunning || queue.length === 0) return;
  isRunning = true;
  const { fn, jobId, resolve, reject } = queue.shift();
  console.log(`[queue] Starting job ${jobId} (${queue.length} remaining in queue)`);
  try {
    resolve(await fn());
  } catch (err) {
    reject(err);
  } finally {
    console.log(`[queue] Job ${jobId} done — cooling down ${COOLDOWN_MS}ms`);
    await sleep(COOLDOWN_MS);
    isRunning = false;
    drain();
  }
}

export function enqueue(jobId, fn) {
  return new Promise((resolve, reject) => {
    queue.push({ jobId, fn, resolve, reject });
    console.log(`[queue] Enqueued ${jobId} (queue length: ${queue.length})`);
    drain();
  });
}
