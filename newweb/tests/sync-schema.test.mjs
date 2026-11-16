import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const sql = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../supabase/migrations/20261115_workspace_sync.sql'), 'utf8');

test('optional sync schema scopes reads, writes and tombstone deletion to JWT owner with expected revisions', () => {
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /auth\.uid\(\) = user_id/i);
  assert.match(sql, /security definer set search_path = ''/i);
  assert.match(sql, /values \(auth\.uid\(\), p_workspace_id, 1, p_payload\)/);
  assert.match(sql, /on conflict \(user_id, workspace_id\) do nothing/);
  assert.match(sql, /revision = p_expected_revision and deleted_at is null/);
  assert.match(sql, /payload = '\{\}'::jsonb, deleted_at = now\(\)/);
  assert.match(sql, /revoke all on public\.flightseal_workspaces from public, anon, authenticated/i);
  assert.doesNotMatch(sql, /grant\s+(?:insert|update|delete|all)\s+on\s+(?:table\s+)?public\.flightseal_workspaces\s+to\s+authenticated/i);
  assert.match(sql, /revoke all on function public\.flightseal_sync_workspace/);
  assert.match(sql, /grant execute on function public\.flightseal_sync_workspace.* to authenticated/);
  assert.match(sql, /grant execute on function public\.flightseal_delete_workspace.* to authenticated/);
});
