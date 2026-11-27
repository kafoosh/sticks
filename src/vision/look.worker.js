// The slow looking, off the page's main thread — done there, the camera picture would stop
// for a tenth of a second or more each time. The page posts a frame's pixels:
//   { id, kind: 'look', rgba: ArrayBuffer, W, H, near }   find a figure        (frame.js lookAt)
//   { id, kind: 'read', rgba: ArrayBuffer, W, H, crop }   read it, to wake it  (frame.js readAt)
//   { id, kind: 'card', rgba: ArrayBuffer, W, H }         read a playing card   (frame.js cardAt)
// and is answered { id, result, error, ms }.

import { lookAt, readAt, cardAt } from './frame.js';

self.onmessage = (e) => {
  const { id, kind, rgba, W, H, near, crop } = e.data, t0 = performance.now();
  let result = null, error = null;
  try {
    const px = new Uint8ClampedArray(rgba);
    result = kind === 'read' ? readAt(px, W, H, crop) : kind === 'card' ? cardAt(px, W, H) : lookAt(px, W, H, near);
  } catch (err) { error = String((err && err.stack) || err); }
  self.postMessage({ id, result, error, ms: performance.now() - t0 });
};
