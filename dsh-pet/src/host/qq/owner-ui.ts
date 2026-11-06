import { createServer } from 'node:http';
import { createRequestSecurity, rejectRequest, secureResponse } from '../../standalone/request-security.ts';
import { boundedRequest, MAX_SETTINGS_BYTES } from '../../standalone/request-body.ts';
import { handleQqOwner } from '../../standalone/server/qq-owner.ts';
import { sendAsset } from '../../standalone/server/respond.ts';
import type { QqOwnerControl } from '../../standalone/qq-owner-control.ts';

const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>QQ 主人设置</title><link rel="stylesheet" href="/standalone-ai/settings.css"><script defer src="/standalone-ai/settings.js"></script><main><h1>QQ 主人设置</h1><p>宠物账号由已配置网关报告。请确认网关连接的是真实 QQ；指定主人不代表已验证好友关系或收发。</p><label>宠物 ID <input id="pet" value="main" maxlength="128"></label><label>主人 QQ <input id="owner" inputmode="numeric" maxlength="20" disabled></label><p><button id="check">检查网关状态</button> <button id="save" disabled>保存主人</button> <button id="clear" disabled>撤销主人</button></p><p id="status" role="status"></p></main></html>`;
const css = `body{font:16px/1.7 sans-serif;background:#edf5fa;color:#203b4b}main{max-width:620px;margin:4em auto;padding:2em;background:white}label{display:block;margin:1em 0}input{display:block;padding:.6em;width:90%}button{padding:.6em;margin:.2em}`;
const script = `'use strict';(()=>{const token=new URLSearchParams(location.hash.slice(1)).get('token')||'';history.replaceState(null,'',location.pathname);const e=id=>document.getElementById(id),pet=e('pet'),owner=e('owner'),status=e('status'),save=e('save'),clear=e('clear');let account='';function reset(){account='';owner.disabled=save.disabled=clear.disabled=true}async function request(method,body){const r=await fetch('/standalone-qq/owner?pet='+encodeURIComponent(pet.value.trim()),{method,credentials:'omit',cache:'no-store',redirect:'error',headers:{'X-DSH-Pet-Token':token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok)throw Error(d.error||'操作失败');return d}async function check(){reset();const p=pet.value.trim();try{const s=await request('GET');if(p!==pet.value.trim())return;account=s.accountId||'';owner.disabled=save.disabled=!s.available;clear.disabled=!s.clearable;status.textContent=s.available?'网关报告的宠物账号：'+s.accountId:'网关账号尚不可用，暂不可保存。'}catch(e){status.textContent=e.message}}pet.addEventListener('input',reset);e('check').onclick=check;save.onclick=async()=>{try{await request('POST',{ownerId:owner.value.trim(),expectedAccountId:account});owner.value='';await check();status.textContent+=' 已在本机指定主人。'}catch(e){status.textContent=e.message}};clear.onclick=async()=>{try{await request('DELETE');await check();status.textContent+=' 主人配置已撤销。'}catch(e){status.textContent=e.message}};if(!token)status.textContent='请从桌面托盘重新打开设置。'})();`;

/** 专用回环服务，不注册到宿主 webServer，也不提供其他独立模式接口。 */
export async function startQqOwnerUi(control: QqOwnerControl): Promise<{ url: string; close(): void }> {
  const security = createRequestSecurity();
  const server = createServer((req, res) => {
    secureResponse(res);
    if (!security.authorize(req, res)) return;
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const assets: Record<string, [string, string]> = {
      '/standalone-ai/': [page, 'text/html'],
      '/standalone-ai/settings.js': [script, 'text/javascript'],
      '/standalone-ai/settings.css': [css, 'text/css'],
    };
    const asset = assets[path];
    if (asset && req.method === 'GET') {
      sendAsset(res, ...asset);
      return;
    }
    if (path !== '/standalone-qq/owner') {
      rejectRequest(res, 404, '没有此页面');
      return;
    }
    if (req.method === 'GET') {
      void handleQqOwner(req, res, control);
      return;
    }
    void boundedRequest(req, res, MAX_SETTINGS_BYTES)
      .then((bounded) => {
        if (bounded) return handleQqOwner(bounded, res, control);
      })
      .catch(() => {
        if (!res.headersSent) rejectRequest(res, 500, '操作失败');
        else res.destroy();
      });
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('监听失败');
  }
  return {
    url: security.authenticatedUrl(`http://127.0.0.1:${address.port}`),
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}
