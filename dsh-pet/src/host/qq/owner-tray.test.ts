import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createTray } = require('../../../runtime/electron-helper/main/tray.js');

test('QQ tray entry is present only with an address and opens it without logging it', async () => {
  for (const ownerUrl of ['', 'http://127.0.0.1:12345/standalone-ai/#token=secret-test-token']) {
    let items: Array<{ label?: string; click?: () => void }> = [];
    const opened: string[] = [];
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.join(' '));
    };
    try {
      class Tray {
        setToolTip() {}
        setContextMenu(value: typeof items) {
          items = value;
        }
        destroy() {}
      }
      const tray = createTray({
        app: { quit() {} },
        Tray,
        Menu: { buildFromTemplate: (value: typeof items) => value },
        nativeImage: {
          createFromPath: () => ({
            isEmpty: () => false,
            resize() {
              return this;
            },
          }),
        },
        hostRequest: async () => ({ body: JSON.stringify({ main: { pets: [{ id: 'main', display: 'desktop' }] } }) }),
        callbackUrl: () => '',
        isBridge: false,
        appMode: false,
        petRoute: '/pet',
        platform: { leftClickPopsMenu: false },
        helperDir: '.',
        qqOwnerUrl: ownerUrl,
        shell: {
          openExternal: async (url: string) => {
            opened.push(url);
            throw new Error(url);
          },
        },
      });
      await tray.start();
      const entry = items.find((item) => item.label === 'QQ 主人设置');
      assert.equal(Boolean(entry), Boolean(ownerUrl));
      if (entry) {
        entry.click!();
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.deepEqual(opened, ownerUrl ? [ownerUrl] : []);
      assert.equal(
        logs.some((line) => line.includes('secret-test-token')),
        false,
      );
    } finally {
      console.error = originalError;
    }
  }
});
