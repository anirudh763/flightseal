export function createSyncProvider(config = {}) {
  const url = String(config.supabaseUrl || '').replace(/\/$/, '');
  const anonKey = String(config.supabaseAnonKey || '');
  const configured = /^https:\/\/[a-z0-9.-]+$/i.test(url) && anonKey.length > 0 && anonKey.length <= 4096;
  return Object.freeze({
    kind: 'supabase-rest',
    configured,
    status: configured ? 'configured' : 'unconfigured',
    async request(path, { accessToken, method = 'GET', body, signal, isCurrent = () => true } = {}) {
      if (!configured) throw new Error('Cloud sync is not configured. Encrypted local backup remains available.');
      if (!accessToken || typeof accessToken !== 'string' || accessToken.length > 8192) throw new Error('Cloud sync requires an authenticated user access token.');
      if (!/^\/rest\/v1\/(?:[a-z][a-z0-9_]{0,62}|rpc\/flightseal_(?:sync|delete)_workspace)$/.test(path)) throw new Error('Cloud sync path is not an allowed table or workspace procedure route.');
      if (!isCurrent()) throw new Error('Cloud operation was canceled because the session changed.');
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const stalePoll = setInterval(() => { if (!isCurrent()) controller.abort(); }, 100);
      const deadline = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch(`${url}${path}`, {
          method, signal: controller.signal,
          headers: {
            apikey: anonKey,
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!isCurrent()) throw new Error('Cloud operation was canceled because the session changed.');
        if (!response.ok) throw new Error(`Cloud provider returned HTTP ${response.status}. No synced status was recorded.`);
        if (response.status === 204) return null;
        if (!response.body?.getReader) throw new Error('Cloud response streaming is unavailable; no synced status was recorded.');
        const reader = response.body.getReader();
        const chunks = []; let size = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1024 * 1024) { await reader.cancel(); throw new Error('Cloud response exceeds the one MiB safe limit.'); }
          chunks.push(value);
        }
        if (!isCurrent()) throw new Error('Cloud operation was canceled because the session changed.');
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new Error('Cloud provider response was not valid JSON.'); }
      } catch (cause) {
        if (controller.signal.aborted) throw new Error(isCurrent() ? 'Cloud request timed out or was canceled.' : 'Cloud operation was canceled because the session changed.');
        throw cause;
      } finally {
        clearInterval(stalePoll); clearTimeout(deadline); signal?.removeEventListener('abort', onAbort);
      }
    },
    async syncWorkspace({ workspaceId, expectedRevision = null, payload, accessToken, explicitConsent = false, signal, isCurrent } = {}) {
      if (!explicitConsent) throw new Error('Explicit cloud-sync consent is required before sending workspace context.');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId || '') || (expectedRevision != null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1))) throw new Error('Cloud workspace ID or revision is invalid.');
      if (!payload || Object.keys(payload).sort().join(',') !== 'record,sample,screen' || !['sandbox', 'verify', 'records', 'receipts', 'video', 'help'].includes(payload.screen) || !['intact', 'tampered', 'rewritten', 'truncated', 'px4', 'px4-tampered', 'px4-full'].includes(payload.sample) || !Number.isSafeInteger(payload.record) || payload.record < 0 || new TextEncoder().encode(JSON.stringify(payload)).length > 2048) throw new Error('Only a bounded included-sample workspace view can be synced.');
      return this.request('/rest/v1/rpc/flightseal_sync_workspace', { accessToken, method: 'POST', body: { p_workspace_id: workspaceId, p_expected_revision: expectedRevision, p_payload: payload }, signal, isCurrent });
    },
    async deleteWorkspace({ workspaceId, expectedRevision, accessToken, explicitConsent = false, signal, isCurrent } = {}) {
      if (!explicitConsent) throw new Error('Explicit consent is required before deleting synced workspace data.');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId || '') || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('Cloud workspace ID or revision is invalid.');
      return this.request('/rest/v1/rpc/flightseal_delete_workspace', { accessToken, method: 'POST', body: { p_workspace_id: workspaceId, p_expected_revision: expectedRevision }, signal, isCurrent });
    },
  });
}
