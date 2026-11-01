/**
 * 「忘掉一条记忆」的删除语义：整轮对齐 + 失败整体回滚。
 *
 * 两条都不能破：同轮的另一条事件（比如复述了用户想忘掉内容的回复）也必须一起消失，
 * 否则她照样会提起；删除中途任何一步失败都必须整体回滚——半途失败会把条目从面板
 * 抹掉，用户再也选不中它去重试。
 *
 * 跑法：node --experimental-strip-types --import ./scripts/test-register.mjs --test src/host/soul/real-soul-delete.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createEventRecorder,
  openSoulDatabase,
  SqliteEventStore,
  SqliteTurnStore,
  type SqliteDatabase,
} from '@deepseek-pet/soul';

import type { HostContext } from '../plugin/context.ts';
import type { HostSetup } from '../plugin/setup.ts';
import { createRealSoul } from './real-soul.ts';

/** 造日志、状态与模型上下文桩（删除路径用不到生成，桩给足形状即可）。 */
function stubs(): { log: HostSetup['log']; state: HostSetup['state']; ctx: HostContext } {
  return {
    log: {
      file: '',
      isFileLogger: false,
      flush: () => {},
      dispose: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as unknown as HostSetup['log'],
    state: { writePet: () => {} } as unknown as HostSetup['state'],
    ctx: {} as HostContext,
  };
}

/** 给删除路径用的配置桩：默认文件指向仓库里真实的 assets/config.jsonc，用户层放一只 main 宠物。 */
function configPaths(baseDir: string): { defaultFile: string; userFile: string; petDir: string } {
  const userFile = join(baseDir, 'user.jsonc');
  writeFileSync(userFile, JSON.stringify({ pets: [{ id: 'main' }] }), 'utf8');
  return {
    defaultFile: fileURLToPath(new URL('../../../assets/config.jsonc', import.meta.url)),
    userFile,
    petDir: join(baseDir, 'pets'),
  };
}

describe('忘掉一条记忆（real-soul）', () => {
  test('按轮对齐：只点一条，同轮另一条事件和聊天原文一起消失', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'soul-del-'));
    t.after(() => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // real-soul 的 SQLite 连接要进程退出才释放，临时目录交给系统清理
      }
    });
    const { log, state, ctx } = stubs();
    const soul = createRealSoul({ configPaths: configPaths(dir), ctx, log, state, userRoot: dir });

    // 落一轮：turns 与 events 共用同一轮 ts（与真实聊天同一约定）
    const turns = new SqliteTurnStore({ file: join(dir, 'soul.db') });
    const events = new SqliteEventStore({ file: join(dir, 'soul.db') });
    t.after(() => turns.close());
    t.after(() => events.close());
    const ts = turns.append('main', '想忘掉的原话', '好的，我不提了');
    createEventRecorder(events).recordTurn('main', ts, '想忘掉的原话', '好的，我不提了');

    // 只点用户那一条「忘掉」
    const result = await soul.deleteMemories?.('main', [`turn:main:${ts}:user`]);
    assert.equal(result?.removed, 2, '同轮两条都要算进来');

    assert.deepEqual(events.list('main'), [], '同轮另一条（复述过原话的回复）也必须消失');
    assert.equal(turns.list('main').length, 0, '聊天原文退出上下文');
  });

  test('删除中途失败：整体回滚，条目还在、可重试', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'soul-del-'));
    t.after(() => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // real-soul 的 SQLite 连接要进程退出才释放，临时目录交给系统清理
      }
    });
    const { log, state, ctx } = stubs();
    const soul = createRealSoul({ configPaths: configPaths(dir), ctx, log, state, userRoot: dir });

    const turns = new SqliteTurnStore({ file: join(dir, 'soul.db') });
    const events = new SqliteEventStore({ file: join(dir, 'soul.db') });
    const db: SqliteDatabase = openSoulDatabase({ file: join(dir, 'soul.db') });
    t.after(() => db.close());
    t.after(() => turns.close());
    t.after(() => events.close());
    const ts = turns.append('main', '想忘掉的原话', '好的');
    createEventRecorder(events).recordTurn('main', ts, '想忘掉的原话', '好的');

    // 弄坏「删聊天原文」那一步：turns 表改名，删它必然抛错
    db.exec('ALTER TABLE turns RENAME TO turns_broken');

    await assert.rejects(() => soul.deleteMemories!('main', [`turn:main:${ts}:user`]), Error, '失败不能装成功');

    // 回滚后条目一条都不能少：用户还要能从面板选中它再试一次
    assert.equal(events.list('main').length, 2, '回滚后事件完整保留');
    // 修复故障后重试即可成功（幂等补齐）
    db.exec('ALTER TABLE turns_broken RENAME TO turns');
    const retried = await soul.deleteMemories!('main', [`turn:main:${ts}:user`]);
    assert.equal(retried.removed, 2);
    assert.deepEqual(events.list('main'), []);
  });

  test('不认编造 / 他人宠物的事件 id：不得误删同时间戳的整轮', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'soul-del-'));
    t.after(() => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // real-soul 的 SQLite 连接要进程退出才释放，临时目录交给系统清理
      }
    });
    const { log, state, ctx } = stubs();
    const soul = createRealSoul({ configPaths: configPaths(dir), ctx, log, state, userRoot: dir });

    const turns = new SqliteTurnStore({ file: join(dir, 'soul.db') });
    const events = new SqliteEventStore({ file: join(dir, 'soul.db') });
    t.after(() => turns.close());
    t.after(() => events.close());
    const ts = turns.append('main', '原话', '回复');
    createEventRecorder(events).recordTurn('main', ts, '原话', '回复');

    // 伪造 id：宠物是别人的、时间戳撞上 main 的轮次；另一条时间戳不存在
    const result = await soul.deleteMemories!('main', [`turn:evilpet:${ts}:user`, 'turn:main:999999999:user']);
    assert.equal(result?.removed, 0, '编造的 id 一条都不该删到');
    assert.equal(events.list('main').length, 2, '同时间戳的整轮必须完好');
    assert.equal(turns.list('main').length, 2);
  });

  test('删除聊天中途失败：历史整体回滚，用户还能从聊天里再删一次', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'soul-del-'));
    t.after(() => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // real-soul 的 SQLite 连接要进程退出才释放，临时目录交给系统清理
      }
    });
    const { log, state, ctx } = stubs();
    const soul = createRealSoul({ configPaths: configPaths(dir), ctx, log, state, userRoot: dir });

    const turns = new SqliteTurnStore({ file: join(dir, 'soul.db') });
    const events = new SqliteEventStore({ file: join(dir, 'soul.db') });
    const db: SqliteDatabase = openSoulDatabase({ file: join(dir, 'soul.db') });
    t.after(() => db.close());
    t.after(() => turns.close());
    t.after(() => events.close());
    const ts = turns.append('main', '问', '答');
    createEventRecorder(events).recordTurn('main', ts, '问', '答');

    // 弄坏「忘记忆」那一步：事件表改名，清理必然抛错
    db.exec('ALTER TABLE events RENAME TO events_broken');

    const failed = await soul.deleteHistory('main', [ts]);
    assert.equal(failed.ok, false, '失败不能装成功');
    // 回滚后历史完整：轮次还留在聊天视图里，用户还能再选中它重试
    assert.equal(turns.list('main').length, 2, '历史整体回滚');
    // 事件表虽然改了名（模拟故障），但删除是整体回滚的——修好故障后重试即可补齐
    db.exec('ALTER TABLE events_broken RENAME TO events');
    assert.equal(events.list('main').length, 2, '事件也完整回滚，没有半套状态');

    const retried = await soul.deleteHistory('main', [ts]);
    assert.equal(retried.ok, true);
    assert.equal(turns.list('main').length, 0, '重试删掉历史');
    assert.equal(events.list('main').length, 0, '重试把记忆清理补齐');
  });
});
