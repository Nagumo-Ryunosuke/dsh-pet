import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { startQqOwnerUi } from './owner-ui.ts';
import type { QqOwnerControl } from '../../standalone/qq-owner-control.ts';

test('QQ owner UI confines access to authenticated local requests and closes', async () => {
  let writes = 0;
  const control = {
    status: () => ({ available: true, configured: false, clearable: false, accountId: '11' }),
    configure: () => {
      writes += 1;
    },
    clear: () => {
      writes += 1;
    },
  } as unknown as QqOwnerControl;
  const ui = await startQqOwnerUi(control);
  const url = new URL(ui.url);
  const token = new URLSearchParams(url.hash.slice(1)).get('token')!;
  const base = url.origin;
  try {
    assert.equal((await fetch(base + '/standalone-ai/')).status, 200);
    assert.equal((await fetch(base + '/standalone-qq/owner?pet=main')).status, 403);
    assert.equal(
      (
        await fetch(base + '/standalone-qq/owner?pet=main', {
          headers: { 'X-DSH-Pet-Token': token, Origin: 'https://evil.example' },
        })
      ).status,
      403,
    );
    const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(
        base + '/standalone-qq/owner?pet=main',
        { headers: { 'X-DSH-Pet-Token': token, Host: 'evil.example' } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      ).on('error', reject);
    });
    assert.equal(hostStatus, 403);
    assert.equal(
      (await fetch(base + '/standalone-ai/settings', { headers: { 'X-DSH-Pet-Token': token } })).status,
      404,
    );
    assert.equal(
      (await fetch(base + '/shutdown', { method: 'POST', headers: { 'X-DSH-Pet-Token': token } })).status,
      404,
    );
    const headers = { 'X-DSH-Pet-Token': token, 'Content-Type': 'application/json', Origin: base };
    assert.equal(
      (await fetch(base + '/standalone-qq/owner?pet=main', { method: 'POST', headers, body: 'x'.repeat(17000) }))
        .status,
      413,
    );
    assert.equal(writes, 0);
    assert.equal(
      (
        await fetch(base + '/standalone-qq/owner?pet=main', {
          method: 'POST',
          headers,
          body: JSON.stringify({ ownerId: '22', expectedAccountId: '11' }),
        })
      ).status,
      200,
    );
    assert.equal(writes, 1);
  } finally {
    ui.close();
  }
  await assert.rejects(fetch(base + '/standalone-ai/'));
});
