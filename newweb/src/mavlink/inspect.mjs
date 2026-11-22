import { analyze, frameAt, loadParser } from './core.js';

export const CAPTURE_LIMIT = 16 * 1024 * 1024;

export async function inspectCapture(file, wasm) {
  if (!file.size || file.size > CAPTURE_LIMIT) {
    throw new Error('Choose a nonempty MAVLink capture up to 16 MiB.');
  }
  const parser = await loadParser(wasm);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await analyze(bytes, { parser, name: file.name, maxFrames: 1000, maxIssues: 30 });
  const tracks = new Map();
  for (let i = 0; i < result.frameCount; i++) {
    const frame = frameAt(result, i);
    if (![24, 33].includes(frame.msgid)) continue;
    const gps = frame.msgid === 24;
    const coordinateOffset = gps ? 8 : 4;
    const version2 = bytes[frame.off] === 0xfd;
    const start = frame.off + (version2 ? 10 : 6);
    if (bytes[frame.off + 1] < (gps ? 29 : 16) || (gps && bytes[start + 28] < 2)) continue;
    const payload = new DataView(bytes.buffer, start, coordinateOffset + 12);
    const lat = payload.getInt32(coordinateOffset, true) / 1e7;
    const lon = payload.getInt32(coordinateOffset + 4, true) / 1e7;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const sender = frame.sysid + ':' + frame.compid + (gps ? ' · GPS' : ' · Position estimate');
    if (!tracks.has(sender)) tracks.set(sender, []);
    tracks.get(sender).push({ lat, lon, altitudeM: payload.getInt32(coordinateOffset + 8, true) / 1000, offset: frame.off });
  }
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  return {
    schema: 'hashwing.capture-inspection.v1',
    parserRevision: 'e31bca666ecda6b921ade84b4ef176220dca0887',
    sha256,
    bytes: bytes.length,
    unlistedFrames: result.unlistedFrames,
    tracks: Array.from(tracks, ([sender, points]) => ({ sender, points })),
    frames: result.validFrames,
    checksumFailures: result.crcErrors,
    unsupported: result.unsupported,
    sequenceGaps: result.gaps,
    omitted: result.unlistedIssues,
    findings: result.issues.map(({ kind, off }) => ({ kind, offset: off })),
  };
}
