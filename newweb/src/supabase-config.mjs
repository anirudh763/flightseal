export function validateBrowserSupabaseKey(key) {
  const value = String(key || '');
  if (!value || value.length > 4096) throw new Error('Supabase browser configuration requires a bounded publishable or legacy anon key.');
  if (value.startsWith('sb_secret_')) throw new Error('A Supabase secret key cannot be compiled into browser code. Use a publishable or legacy anon key.');
  const parts = value.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (payload.role === 'service_role') throw new Error('A service_role JWT bypasses row-level security and cannot be compiled into browser code.');
    } catch (cause) {
      if (/service_role/.test(cause?.message || '')) throw cause;
      // Non-JWT publishable keys remain valid; opaque legacy values are checked by Supabase.
    }
  }
  return value;
}
