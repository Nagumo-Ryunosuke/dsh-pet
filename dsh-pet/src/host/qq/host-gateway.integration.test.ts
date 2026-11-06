import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createStandaloneContext } from '../../standalone/context.ts';
import type { QqOwnerControl } from '../../standalone/qq-owner-control.ts';

const packages = new URL('../../../../../deepseek-pet-qq-gateway/packages/', import.meta.url);
const pluginPath = fileURLToPath(new URL('dsh-plugin/dist/index.js', packages));
const bundlePath = fileURLToPath(new URL('../../../lib/index.js', import.meta.url));
const requiredArtifacts = [
  pluginPath,
  bundlePath,
  ...['gateway', 'mock-driver'].map((name) => fileURLToPath(new URL(`${name}/dist/index.js`, packages))),
];
const logger = { info() {}, warn() {}, error() {}, debug() {} };

function verifiedTemporaryDirectory(path: string): string {
  const samePath = (left: string, right: string) =>
    process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  if (
    !isAbsolute(path) ||
    !samePath(path, resolve(path)) ||
    !basename(path).startsWith('dsh-host-gateway-') ||
    !samePath(dirname(path), resolve(tmpdir()))
  )
    throw new Error('invalid test temporary directory');
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('test temporary directory must not be a link');
  const actual = realpathSync(path);
  if (!samePath(actual, join(realpathSync(tmpdir()), basename(path))))
    throw new Error('test temporary directory escaped');
  return path;
}

test(
  '宿主 apply 经模拟网关将绑定的 B 消息交给灵魂并回复',
  {
    skip: requiredArtifacts.some((path) => !existsSync(path)) && 'build host bundle and sibling QQ gateway first',
  },
  async () => {
    if (!process.env['DSH_QQ_TEST_CHILD']) {
      const dir = verifiedTemporaryDirectory(mkdtempSync(join(tmpdir(), 'dsh-host-gateway-')));
      try {
        const childEnv: NodeJS.ProcessEnv = { ...process.env, DSH_QQ_TEST_CHILD: dir };
        delete childEnv['NODE_TEST_CONTEXT'];
        const child = spawnSync(
          process.execPath,
          [
            '--experimental-strip-types',
            '--import',
            './scripts/test-register.mjs',
            '--test',
            fileURLToPath(import.meta.url),
          ],
          {
            cwd: fileURLToPath(new URL('../../../', import.meta.url)),
            env: childEnv,
            encoding: 'utf8',
            timeout: 30000,
          },
        );
        assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
        assert.match(child.stdout, /pass 1/, child.stdout);
      } finally {
        rmSync(verifiedTemporaryDirectory(dir), { recursive: true, force: true });
      }
      return;
    }
    const gatewayModule = await import(new URL('gateway/dist/index.js', packages).href);
    const mockModule = await import(new URL('mock-driver/dist/index.js', packages).href);
    const dir = verifiedTemporaryDirectory(process.env['DSH_QQ_TEST_CHILD']);
    const driver = new mockModule.MockQqDriver({ accountId: '11' });
    const gateway = new gatewayModule.OneBotGateway({
      driver,
      token: 'test-token',
      port: 0,
      dataDir: join(dir, 'gateway'),
      heartbeatIntervalMs: 0,
    });
    const { endpoint } = await gateway.start();
    const env = {
      DSH_HOME: join(dir, 'home'),
      DSH_PET_CHAT_BACKEND: 'soul',
      DSH_PET_SOUL_MODEL: 'echo',
      DSH_PET_IN_PROCESS: '1',
      DSH_PET_QQ_MODULE: pluginPath,
      DSH_PET_QQ_URL: endpoint,
      DSH_PET_QQ_PET: 'main',
      QGW_ONEBOT_TOKEN: 'test-token',
    };
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    const context = createStandaloneContext({ port: 0, logger });
    let control: QqOwnerControl | null = null;
    const waitFor = async (predicate: () => boolean) => {
      for (let i = 0; i < 300; i++) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail('timed out waiting for simulated host/gateway');
    };
    try {
      // The built entry resolves package assets exactly as the installed host does.
      const bundleUrl = new URL('../../../lib/index.js', import.meta.url).href;
      const { apply } = (await import(bundleUrl)) as typeof import('../index.ts');
      apply(context.ctx, {
        onQqOwnerControl: (value) => {
          control = value;
        },
      });
      await waitFor(() => control?.status('main').available === true);
      assert.equal(control!.status('main').accountId, '11');
      control!.configure('main', '22', '11');
      driver.injectPrivate({ from: '23', text: '非主人消息' });
      driver.injectPrivate({ from: '22', text: '模拟消息' });
      await waitFor(() => driver.sent.length > 0);
      assert.equal(driver.sent.length, 1);
      assert.equal(driver.sent[0].target, '22');
      assert.match(driver.sent[0].text, /回声/);
      assert.deepEqual(context.failures, []);
    } finally {
      await context.dispose();
      await gateway.stop();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);
