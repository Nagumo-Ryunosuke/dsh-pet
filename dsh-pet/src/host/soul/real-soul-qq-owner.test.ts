import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { QqAccountObservation } from '@deepseek-pet/soul';
import type { HostContext } from '../plugin/context.ts';
import type { HostSetup } from '../plugin/setup.ts';
import { createRealSoul } from './real-soul.ts';

test('宿主只在显式注入测试观察器时接入同一个灵魂，按宠物和 A/B 隔离', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'soul-qq-owner-'));
  const userFile = join(dir, 'user.jsonc');
  writeFileSync(userFile, JSON.stringify({ pets: [{ id: 'main' }, { id: 'other' }] }));
  const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as HostSetup['log'];
  const options = {
    configPaths: {
      defaultFile: fileURLToPath(new URL('../../../assets/config.jsonc', import.meta.url)),
      userFile,
      petDir: join(dir, 'pets'),
    },
    ctx: {} as HostContext,
    state: { writePet() {} } as unknown as HostSetup['state'],
    log,
    userRoot: dir,
  };
  const previous = process.env['DSH_PET_SOUL_MODEL'];
  process.env['DSH_PET_SOUL_MODEL'] = 'echo';
  t.after(() => {
    if (previous === undefined) delete process.env['DSH_PET_SOUL_MODEL'];
    else process.env['DSH_PET_SOUL_MODEL'] = previous;
  });
  let observation: QqAccountObservation = { state: 'authenticated', accountId: '11' };
  const host = createRealSoul({ ...options, experimentalQqAccountObserver: () => observation });
  const owners = host.experimentalQqOwnerBinding;
  const soul = host.channelSoul;
  assert.ok(owners);
  assert.ok(soul);
  const input = (accountId: string, actorId: string, requestId: string) => ({
    channel: 'qq' as const,
    accountId,
    conversationType: 'private' as const,
    conversationId: actorId,
    actorId,
    messageId: requestId,
    requestId,
    text: '你好',
  });
  owners.configure('main', '22');
  assert.equal((await soul.respond('main', input('11', '22', '1'))).ok, true);
  assert.equal((await soul.respond('other', input('11', '22', '2'))).ok, false);
  assert.equal((await soul.respond('main', input('11', '23', '3'))).ok, false);
  observation = { state: 'authenticated', accountId: '33' };
  owners.configure('main', '44');
  assert.equal((await soul.respond('main', input('11', '22', '4'))).ok, false);
  assert.equal((await soul.respond('main', input('33', '44', '5'))).ok, true);
  owners.clear('main');
  assert.equal((await soul.respond('main', input('33', '44', '6'))).ok, false);
  observation = { state: 'offline' };
  assert.throws(() => owners.configure('main', '44'), /account-not-ready/);
  // Even with an existing persisted configuration, a fresh default host must not enable it.
  observation = { state: 'authenticated', accountId: '33' };
  owners.configure('main', '44');
  const disabled = createRealSoul(options);
  assert.equal(disabled.experimentalQqOwnerBinding, undefined);
  assert.equal((await disabled.channelSoul!.respond('main', input('33', '44', '7'))).ok, false);
  const reopened = createRealSoul({ ...options, experimentalQqAccountObserver: () => observation });
  assert.equal(reopened.experimentalQqOwnerBinding?.state('main').binding?.ownerId, '44');
  assert.equal((await reopened.channelSoul!.respond('main', input('33', '44', '8'))).ok, true);
  reopened.experimentalQqOwnerBinding!.clear('main');
  assert.equal((await soul.respond('main', input('33', '44', '9'))).ok, false);
});
