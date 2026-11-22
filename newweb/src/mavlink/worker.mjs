import wasm from './mavframe.wasm?url';
import { inspectCapture } from './inspect.mjs';

self.onmessage = async ({ data: file }) => {
  try {
    self.postMessage({ result: await inspectCapture(file, wasm) });
  } catch (error) {
    self.postMessage({ error: error.message || 'The capture could not be inspected.' });
  }
};
