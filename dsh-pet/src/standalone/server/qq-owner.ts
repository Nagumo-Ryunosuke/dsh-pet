import type { IncomingMessage, ServerResponse } from 'node:http';
import type { QqOwnerControl } from '../qq-owner-control.ts';
import { rejectRequest } from '../request-security.ts';
import { sendJson } from './respond.ts';

/** 仅由独立服务的令牌校验之后调用。 */
export async function handleQqOwner(
  req: IncomingMessage,
  res: ServerResponse,
  control?: QqOwnerControl,
): Promise<void> {
  const pet = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('pet') ?? '';
  if (
    !pet ||
    pet.length > 128 ||
    Array.from(pet).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    rejectRequest(res, 400, '请选择有效的宠物');
    return;
  }
  if (!control) {
    if (req.method === 'GET') sendJson(res, 200, { available: false, configured: false, clearable: false });
    else rejectRequest(res, 503, 'QQ 登录身份尚不可验证，无法保存');
    return;
  }
  try {
    if (req.method === 'GET') {
      sendJson(res, 200, control.status(pet));
      return;
    }
    if (req.method === 'DELETE') {
      control.clear(pet);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method !== 'POST') {
      rejectRequest(res, 405, '仅支持 GET、POST 或 DELETE');
      return;
    }
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      rejectRequest(res, 415, '请使用 JSON');
      return;
    }
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      req.once('end', resolve);
      req.once('error', reject);
    });
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 2 ||
      !('ownerId' in body) ||
      !('expectedAccountId' in body) ||
      typeof body.ownerId !== 'string' ||
      !/^[1-9][0-9]{0,19}$/.test(body.ownerId) ||
      typeof body.expectedAccountId !== 'string' ||
      !/^[1-9][0-9]{0,19}$/.test(body.expectedAccountId)
    ) {
      rejectRequest(res, 400, '主人 QQ 格式不正确');
      return;
    }
    control.configure(pet, body.ownerId, body.expectedAccountId);
    sendJson(res, 200, { ok: true, verification: 'local-configured' });
  } catch {
    rejectRequest(res, 400, '未保存：请确认宠物、登录状态和主人 QQ');
  }
}
