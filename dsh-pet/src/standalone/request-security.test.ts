import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequestSecurity } from './request-security.ts';

function request(headers: Record<string, string> = {}, url = '/private', method = 'GET'): IncomingMessage {
  return {
    headers: { host: '127.0.0.1:3080', ...headers },
    socket: { localPort: 3080 },
    method,
    url,
  } as IncomingMessage;
}
function response() {
  return {
    status: 0,
    headers: {} as Record<string, string>,
    writeHead(status: number, headers: Record<string, string>) {
      this.status = status;
      this.headers = headers;
    },
    end() {},
  };
}
test('capabilities are random, fragment-only, and process-bound', () => {
  const a = createRequestSecurity();
  const b = createRequestSecurity();
  assert.notEqual(a.token, b.token);
  const url = new URL(a.authenticatedUrl('http://127.0.0.1:3080/dsh-pet'));
  assert.equal(url.pathname, '/standalone-ai/');
  assert.equal(url.search, '');
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('token'), a.token);
  assert.throws(() => a.authenticatedUrl('https://evil.test/'));
});

test('encoded private routes still require a capability; invalid encodings fail explicitly', () => {
  const security = createRequestSecurity();
  for (const path of [
    '/dsh-pet-7340/%63hat?pet=main',
    '/dsh-pet-7340/ch%61t',
    '/dsh-pet-7340/chat%2Fhistory',
    '/dsh-pet-7340/%77hisper',
  ]) {
    for (const method of ['GET', 'HEAD']) {
      const res = response();
      assert.equal(security.authorize(request({}, path, method), res as unknown as ServerResponse), false);
      assert.equal(res.status, 403);
      assert.equal(
        security.authorize(
          request({ 'x-dsh-pet-token': security.token }, path, method),
          response() as unknown as ServerResponse,
        ),
        true,
      );
    }
  }
  for (const method of ['GET', 'POST']) {
    const res = response();
    assert.equal(
      security.authorize(
        request({ 'x-dsh-pet-token': security.token }, '/dsh-pet-7340/%ZZ', method),
        res as unknown as ServerResponse,
      ),
      false,
    );
    assert.equal(res.status, 400);
  }
  assert.equal(
    security.authorize(request({}, '/dsh-pet-7340/thumb/main/%E7%9C%8B.webm'), response() as unknown as ServerResponse),
    true,
  );
});

test('plugin reads are public only for bundled static assets; everything else needs the capability', () => {
  const security = createRequestSecurity();
  // 静态素材（无用户数据）继续公开：<video>/<img> 等媒体元素不走 fetch 拦截的边角情况也不会坏
  for (const path of [
    '/dsh-pet-7340/thumb/main/%E7%9C%8B.webm',
    '/dsh-pet-7340/pic/memes/main/%E8%A1%A8%E6%83%85.png',
    '/dsh-pet-7340/sound/main/click.mp3',
    '/dsh-pet-7340/font/main/%E5%AD%97%E4%BD%93.ttf',
    '/dsh-pet-7340/logo',
  ]) {
    assert.equal(security.authorize(request({}, path), response() as unknown as ServerResponse), true, path);
  }
  // 其余一律要令牌：聊天原文 / 记忆 / 事实 / 摘要 / 用量 / state / 附件——
  // 本机其它进程构造请求不应能匿名读走任何用户生成内容（state 的 say.text 就是模型回复原文）。
  // （config 与 pose 仍公开：渲染端引导依赖 / 第三方集成契约，且不含聊天内容）
  for (const path of [
    '/dsh-pet-7340/memory?pet=main',
    '/dsh-pet-7340/facts?pet=main',
    '/dsh-pet-7340/summaries?pet=main',
    '/dsh-pet-7340/usage',
    '/dsh-pet-7340/state?pet=main',
    '/dsh-pet-7340/chat?pet=main',
    '/dsh-pet-7340/config/meta',
    '/dsh-pet-7340/attachment?id=a1',
    '/dsh-pet-7340/todos',
  ]) {
    const res = response();
    assert.equal(security.authorize(request({}, path), res as unknown as ServerResponse), false, path);
    assert.equal(res.status, 403, path);
    assert.equal(
      security.authorize(request({ 'x-dsh-pet-token': security.token }, path), response() as unknown as ServerResponse),
      true,
      path,
    );
  }
});

test('desktop file-origin exception always needs a capability and never relaxes Host checks', () => {
  const security = createRequestSecurity();
  const fileHeaders = { origin: 'null', 'sec-fetch-site': 'cross-site' };
  for (const path of ['/dsh-pet-7340/config', '/dsh-pet-7340/chat']) {
    assert.equal(security.authorize(request(fileHeaders, path), response() as unknown as ServerResponse, true), false);
    const headers = { ...fileHeaders, 'x-dsh-pet-token': security.token };
    assert.equal(security.authorize(request(headers, path), response() as unknown as ServerResponse, true), true);
    assert.equal(security.authorize(request(headers, path), response() as unknown as ServerResponse), false);
    assert.equal(
      security.authorize(
        request({ ...headers, host: 'evil.test:3080' }, path),
        response() as unknown as ServerResponse,
        true,
      ),
      false,
    );
    assert.equal(
      security.authorize(
        request({ ...headers, origin: 'https://evil.test' }, path),
        response() as unknown as ServerResponse,
        true,
      ),
      false,
    );
  }
});
test('all private reads and mutations need the header, never a query capability', () => {
  const security = createRequestSecurity();
  for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
    for (const token of ['', 'wrong']) {
      const res = response();
      assert.equal(
        security.authorize(
          request({ 'x-dsh-pet-token': token }, '/private?token=' + security.token, method),
          res as unknown as ServerResponse,
        ),
        false,
      );
      assert.equal(res.status, 403);
    }
    assert.equal(
      security.authorize(
        request({ 'x-dsh-pet-token': security.token }, '/private', method),
        response() as unknown as ServerResponse,
      ),
      true,
    );
  }
});
test('DNS rebinding, null/foreign origins, wrong ports and cross-site fetches fail before auth', () => {
  const security = createRequestSecurity();
  const headersList: Array<Record<string, string>> = [
    { host: 'evil.test:3080' },
    { host: '127.0.0.1:9999' },
    { host: '' },
    { host: '127.0.0.1:3080.evil.test' },
    { origin: 'null' },
    { origin: 'http://evil.test' },
    { origin: 'http://localhost:3080' },
    { 'sec-fetch-site': 'cross-site' },
  ];
  for (const headers of headersList) {
    const res = response();
    assert.equal(
      security.authorize(request({ ...headers, 'x-dsh-pet-token': security.token }), res as unknown as ServerResponse),
      false,
      JSON.stringify(headers),
    );
  }
  assert.equal(
    security.authorize(
      request({ origin: 'http://127.0.0.1:3080', 'x-dsh-pet-token': security.token }),
      response() as unknown as ServerResponse,
    ),
    true,
  );
});
test('only minimal health, settings shell and known media GET are public; public routes still check origin/host', () => {
  const security = createRequestSecurity();
  for (const path of [
    '/',
    '/health',
    '/standalone-ai/',
    '/standalone-ai/settings.js',
    '/dsh-pet-7340/thumb/main/idle.webm',
    '/dsh-pet-7340/pic/memes/main/a.png',
  ]) {
    assert.equal(security.authorize(request({}, path), response() as unknown as ServerResponse), true, path);
    assert.equal(
      security.authorize(request({ origin: 'null' }, path), response() as unknown as ServerResponse),
      false,
      path,
    );
    assert.equal(security.authorize(request({}, path, 'POST'), response() as unknown as ServerResponse), false, path);
  }
  for (const path of ['/standalone-ai/settings', '/dsh-pet-7340/whisper', '/dsh-pet-7340/chat', '/shutdown']) {
    assert.equal(security.authorize(request({}, path), response() as unknown as ServerResponse), false, path);
  }
  for (const path of ['/dsh-pet-7340/config', '/dsh-pet-7340/pose']) {
    assert.equal(security.authorize(request({}, path), response() as unknown as ServerResponse), true, path);
    assert.equal(
      security.authorize(request({ origin: 'http://evil.test' }, path), response() as unknown as ServerResponse),
      false,
      path,
    );
  }
  // state 含模型回复原文（say.text），必须随 chat/whisper 一样要求令牌
  assert.equal(
    security.authorize(request({}, '/dsh-pet-7340/state'), response() as unknown as ServerResponse),
    false,
    'state 不能匿名读',
  );
});
