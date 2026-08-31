import { buildModel } from './build.js';

let currentJob = 0;

self.onmessage = (event) => {
  const { type, jobId, payload } = event.data || {};

  if (type === 'cancel') {
    currentJob++;
    return;
  }
  if (type !== 'build') return;

  currentJob = jobId;

  const post = (message) => {
    if (jobId !== currentJob) return false;
    self.postMessage(message);
    return true;
  };

  try {
    const result = buildModel(payload.features, payload.settings, {
      heightGrid: payload.heightGrid
        ? { ...payload.heightGrid, values: new Float32Array(payload.heightGrid.values) }
        : null,
      routePoints: payload.routePoints,
      font: payload.font,
      onProgress: (fraction, message) =>
        post({ type: 'progress', jobId, fraction, message }),
    });

    if (jobId !== currentJob) return;

    const transfers = [];
    for (const part of result.parts) {
      transfers.push(part.positions.buffer, part.indices.buffer);
    }
    self.postMessage({ type: 'done', jobId, result }, transfers);
  } catch (error) {
    post({
      type: 'error',
      jobId,
      message: error?.message || String(error),
      stack: error?.stack || '',
    });
  }
};
