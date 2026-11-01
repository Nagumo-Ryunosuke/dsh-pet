/**
 * 桌面 Helper 的启动门槛：托盘开着就必须拉起，哪怕一只桌面宠物都没有。
 *
 * 背景：托盘是桌面侧**唯一**能把被藏起来（display 为 web/none）的宠物叫回来的入口——
 * 它列出配置里的全部宠物、勾一下就切回桌面。早先的判定是「没有桌面宠物就不启动 Helper」，
 * 于是「用户把宠物藏了 → 重启 DSH → 连托盘都没了」，只剩侧边栏聊天框，谁也叫不回它。
 * 这里钉的是那条门槛本身，不碰真正拉起 Electron 的部分（那需要图形环境）。
 *
 * 跑法：node --experimental-strip-types --test src/host/plugin/desktop/spawn.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createDesktopSpawn, type DesktopSpawnInput } from './spawn.ts';

/** 造一份只够过启动门槛的依赖：webServer 端口为 0，拉起会在端口检查处停住（不 spawn）。 */
function harness(over: { hasDesktopPet: boolean; trayOn: boolean }): {
  logs: string[];
  spawn: ReturnType<typeof createDesktopSpawn>;
} {
  const logs: string[] = [];
  const push = (message: string): void => {
    logs.push(message);
  };
  const deps = {
    // 只有 webServer 被 startHelper 读到；其余宿主能力用不到
    ctx: { webServer: { port: 0 } },
    getHandlePetRoute: () => async () => ({ status: 200, body: '{}' }),
    log: { info: push, warn: push, error: push, debug: push },
    reportDownload: () => undefined,
    thumbUserRoot: 'C:/tmp/dsh-pet-test',
    getHasDesktopPet: () => over.hasDesktopPet,
    desktopPetList: () => [],
    getTrayOn: () => over.trayOn,
  } as unknown as DesktopSpawnInput;
  return { logs, spawn: createDesktopSpawn(deps) };
}

/** 有没有打那条「已跳过桌面 Helper 启动」。 */
const skipped = (logs: readonly string[]): boolean => logs.some((line) => line.includes('已跳过桌面 Helper 启动'));

describe('startHelper —— 无桌面宠物时的启动门槛', () => {
  test('托盘开着：必须拉起（托盘是把藏起来的宠物叫回来的唯一入口）', () => {
    const { logs, spawn } = harness({ hasDesktopPet: false, trayOn: true });
    try {
      spawn.startHelper();
      assert.equal(skipped(logs), false, '托盘开着却跳过 Helper，等于把唤回入口一起关掉');
    } finally {
      spawn.markDisposed();
    }
  });

  test('托盘关掉：跳过并说清怎么唤回，不再只打一行无法行动的诊断', () => {
    const { logs, spawn } = harness({ hasDesktopPet: false, trayOn: false });
    try {
      spawn.startHelper();
      assert.equal(skipped(logs), true);
      const line = logs.find((one) => one.includes('已跳过桌面 Helper 启动')) ?? '';
      assert.match(line, /托盘/, '日志得点明是托盘关了才跳过');
      assert.match(line, /显示桌宠/, '日志得给出用户下一步能点的东西');
    } finally {
      spawn.markDisposed();
    }
  });

  test('有桌面宠物时不看托盘脸色：托盘关掉也照样拉起', () => {
    for (const trayOn of [true, false]) {
      const { logs, spawn } = harness({ hasDesktopPet: true, trayOn });
      try {
        spawn.startHelper();
        assert.equal(skipped(logs), false, `有桌面宠物就不该跳过（tray=${String(trayOn)}）`);
      } finally {
        spawn.markDisposed();
      }
    }
  });
});
