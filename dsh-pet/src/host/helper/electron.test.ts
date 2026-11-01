/**
 * Helper 启动参数（src/host/helper/electron.ts 的 helperLaunchArgs）的契约测试：
 * 端口为 0 时不挂调试开关；给定端口时 Chromium 的调试开关排在脚本路径之前。
 * 不断言 DESKTOP_DEBUG_PORT 的具体取值：它是可以手动切换的排障开关，断言取值会让本地调试与测试互相打架。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DESKTOP_DEBUG_PORT, desktopCorePath, desktopCoreReady, helperLaunchArgs } from './electron.ts';

describe('helperLaunchArgs —— 桌面 Helper 启动参数', () => {
  test('端口 0：只有脚本路径，不挂调试开关', () => {
    assert.deepEqual(helperLaunchArgs('/x/main.js', 0), ['/x/main.js']);
  });

  test('给定端口：调试开关排在脚本路径之前', () => {
    assert.deepEqual(helperLaunchArgs('/x/main.js', 9222), ['--remote-debugging-port=9222', '/x/main.js']);
  });

  test('默认参数跟随 DESKTOP_DEBUG_PORT：0 关、非 0 开', () => {
    const expected =
      DESKTOP_DEBUG_PORT > 0 ? ['--remote-debugging-port=' + DESKTOP_DEBUG_PORT, '/x/main.js'] : ['/x/main.js'];
    assert.deepEqual(helperLaunchArgs('/x/main.js'), expected);
  });
});

describe('桌面渲染核心就位检查', () => {
  test('路径固定落在 helper 目录下的 shared-core.js', () => {
    assert.equal(desktopCorePath('/x/y'), join('/x/y', 'shared-core.js'));
  });

  test('文件在就是就位，不在就不是（缺文件时调用方不建窗）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'core-check-'));
    try {
      assert.equal(desktopCoreReady(dir), false, '空目录 = 没构建过');
      writeFileSync(join(dir, 'shared-core.js'), 'var PetShared = {};', 'utf8');
      assert.equal(desktopCoreReady(dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
