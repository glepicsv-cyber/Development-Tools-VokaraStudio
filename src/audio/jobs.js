// Gọi việc nền dạng Promise, có báo tiến độ.

let dspWorker = null;
let mp3Worker = null;
let nextId = 1;
const pending = new Map();

function onMessage(event) {
  const { id, progress, result, error } = event.data;
  const job = pending.get(id);
  if (!job) return;
  if (progress !== undefined) {
    if (job.onProgress) job.onProgress(progress);
    return;
  }
  pending.delete(id);
  if (error) job.reject(new Error(error));
  else job.resolve(result);
}

function getDsp() {
  if (!dspWorker) {
    dspWorker = new Worker(new URL('./dsp-worker.js', import.meta.url), { type: 'module' });
    dspWorker.onmessage = onMessage;
  }
  return dspWorker;
}

function getMp3() {
  if (!mp3Worker) {
    mp3Worker = new Worker(new URL('./mp3-worker.js', import.meta.url));
    mp3Worker.onmessage = onMessage;
  }
  return mp3Worker;
}

function post(worker, type, payload, onProgress) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, type, payload });
  });
}

export const runJob = (type, payload, onProgress) => post(getDsp(), type, payload, onProgress);
export const encodeMp3 = (payload, onProgress) => post(getMp3(), 'mp3', payload, onProgress);
