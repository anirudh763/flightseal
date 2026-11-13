// Runs scanLog() off the page's main thread, so a large or hostile log never freezes the page and Cancel is
// immediate (the page terminates this worker).
import { scanLog, blobSource } from "./verifier.js";

self.onmessage = async (e) => {
  const { blob, linksAt, maxRows } = e.data;
  let last = 0;
  try {
    const r = await scanLog(blobSource(blob), {
      linksAt,
      maxRows,
      onProgress: (done, size) => {
        const now = Date.now();
        if (now - last > 100) {
          last = now;
          self.postMessage({ type: "progress", done, size });
        }
      },
    });
    const { offset, ts, len } = r.rows;
    self.postMessage({ type: "done", result: r }, [offset.buffer, ts.buffer, len.buffer]);
  } catch (err) {
    self.postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};
