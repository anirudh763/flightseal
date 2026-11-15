// The native Writer uses this bounded file directly; generated logs never accumulate in MEMFS.
export function mountSyncOutput(module, handle, maxBytes = 1200 * 1024 * 1024) {
  const { FS } = module;
  let modified = new Date();
  const attributes = (node) => ({ dev: 1, ino: node.id, mode: node.mode, nlink: 1, uid: 0, gid: 0, rdev: 0,
    size: node.isFolder ? 4096 : handle.getSize(), atime: modified, mtime: modified, ctime: modified, blksize: 4096,
    blocks: node.isFolder ? 1 : Math.ceil(handle.getSize() / 4096) });
  const bounded = (position, length = 0) => {
    if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0 || position + length > maxBytes)
      throw new FS.ErrnoError(51);
  };
  let root;
  const fileOps = {
    getattr: attributes,
    setattr(node, value) {
      if (value.size !== undefined) { bounded(value.size); handle.truncate(value.size); }
      modified = new Date();
    },
  };
  const streams = {
    llseek(stream, offset, whence) {
      const position = offset + (whence === 1 ? stream.position : whence === 2 ? handle.getSize() : 0);
      bounded(position); return position;
    },
    read(stream, buffer, offset, length, position) {
      bounded(position, length); return handle.read(buffer.subarray(offset, offset + length), { at: position });
    },
    write(stream, buffer, offset, length, position) {
      bounded(position, length); modified = new Date();
      return handle.write(buffer.subarray(offset, offset + length), { at: position });
    },
    fsync() { handle.flush(); return 0; },
  };
  const directoryOps = {
    getattr: attributes,
    lookup(parent, name) { if (root.contents[name]) return root.contents[name]; throw new FS.ErrnoError(44); },
    mknod(parent, name, mode, dev) {
      if (name !== 'imported.fseal' || (mode & 0xf000) !== 0x8000) throw new FS.ErrnoError(63);
      const node = FS.createNode(parent, name, mode, dev);
      node.node_ops = fileOps; node.stream_ops = streams; root.contents[name] = node; return node;
    },
    unlink(parent, name) { if (!root.contents[name]) throw new FS.ErrnoError(44); handle.truncate(0); delete root.contents[name]; },
    readdir() { return ['.', '..', ...Object.keys(root.contents)]; },
  };
  FS.mkdir('/output');
  FS.mount({ mount() { root = FS.createNode(null, '/', 0x4000 | 0o700, 0);
    root.contents = Object.create(null); root.node_ops = directoryOps; return root; } }, {}, '/output');
  return () => FS.unmount('/output');
}

function validateName(name) {
  if (!/^flightseal-import-[0-9a-f-]{36}\.tmp$/.test(name)) throw new Error('Invalid temporary output identifier.');
}

export async function recoverTemporaryOutputs() {
  if (!globalThis.navigator?.storage?.getDirectory || !navigator.locks?.request) return 0;
  const root = await navigator.storage.getDirectory();
  let directory;
  try { directory = await root.getDirectoryHandle('flightseal-imports-v1'); }
  catch (error) { if (error.name === 'NotFoundError') return 0; throw error; }
  let removed = 0;
  for await (const entry of directory.values()) {
    if (entry.kind !== 'file' || !/^flightseal-import-[0-9a-f-]{36}\.tmp$/.test(entry.name)) continue;
    await navigator.locks.request(`flightseal-output:${entry.name}`, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      await removeTemporaryOutput(entry.name);
      removed++;
    });
  }
  return removed;
}

export async function ownTemporaryOutput(name) {
  validateName(name);
  if (!navigator.locks?.request) throw new Error('Large imports require browser Web Locks for safe temporary-file ownership.');
  let unlock, acquired;
  const lifetime = new Promise((resolve) => { unlock = resolve; });
  const ready = new Promise((resolve) => { acquired = resolve; });
  const held = navigator.locks.request(`flightseal-output:${name}`, async () => { acquired(); await lifetime; });
  await Promise.race([ready, held]);
  return async () => { unlock(); await held; };
}

export async function removeTemporaryOutput(name) {
  validateName(name);
  const root = await navigator.storage.getDirectory();
  let directory;
  try { directory = await root.getDirectoryHandle('flightseal-imports-v1'); }
  catch (error) { if (error.name === 'NotFoundError') return; throw error; }
  for (let attempt = 0; ; attempt++) {
    try { await directory.removeEntry(name); return; }
    catch (error) {
      if (error.name === 'NotFoundError') return;
      if (error.name !== 'NoModificationAllowedError' || attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export async function createTemporaryOutput(module, name, requiredBytes = 0) {
  validateName(name);
  if (!globalThis.navigator?.storage?.getDirectory) throw new Error('This browser has no private temporary storage. Use the CLI for large imports.');
  if (navigator.storage.estimate) {
    const estimate = await navigator.storage.estimate();
    const available = estimate.quota - estimate.usage;
    if (Number.isFinite(available) && available < requiredBytes + 8 * 1024 * 1024)
      throw new Error(`Estimated browser storage is too small for this import (${Math.ceil(requiredBytes / 1024 / 1024)} MiB needed). Clear old outputs, use a regular browser window, or use the CLI.`);
  }
  const rootDirectory = await navigator.storage.getDirectory();
  const directory = await rootDirectory.getDirectoryHandle('flightseal-imports-v1', { create: true });
  const file = await directory.getFileHandle(name, { create: true });
  let access, unmount;
  try {
    access = await file.createSyncAccessHandle();
    unmount = mountSyncOutput(module, access);
  } catch (error) { access?.close(); await directory.removeEntry(name).catch(() => {}); throw error; }
  let closed = false;
  return {
    path: '/output/imported.fseal', name,
    async snapshot() {
      access.flush(); unmount(); access.close(); closed = true;
      return file.getFile();
    },
    async discard() {
      if (!closed) { try { unmount(); } finally { access.close(); closed = true; } }
      await directory.removeEntry(name);
    },
  };
}
