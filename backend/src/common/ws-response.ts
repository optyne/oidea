import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';

const logger = new Logger('WsResponse');

/** socket handler 的 ack 內容。成功 `{ ok: true, ... }`，失敗 `{ ok: false, error }`。 */
export type WsFail = { ok: false; error: { code: WsErrorCode; message: string } };
export type WsAck<T extends object = object> = ({ ok: true } & T) | WsFail;

export type WsErrorCode = 'forbidden' | 'not_found' | 'bad_request' | 'error';

/** 拒絕事件名稱：沒有用 ack 的客戶端從這個事件得知被拒。 */
export const WS_ERROR_EVENT = 'ws_error';

interface Emitter {
  emit(event: string, ...args: unknown[]): unknown;
}

/** 把例外轉成錯誤 ack，並對該 socket emit `ws_error`（帶原本的事件名稱）。 */
export function wsDeny(client: Emitter, event: string, err: unknown): WsFail {
  const code: WsErrorCode =
    err instanceof ForbiddenException
      ? 'forbidden'
      : err instanceof NotFoundException
        ? 'not_found'
        : err === 'bad_request'
          ? 'bad_request'
          : 'error';
  const message =
    code === 'bad_request'
      ? '參數錯誤'
      : code === 'error'
        ? '操作失敗'
        : (err as Error).message;
  if (code === 'error') {
    logger.warn(`ws handler "${event}" failed: ${(err as Error)?.message ?? String(err)}`);
  }
  const error = { code, message };
  client.emit(WS_ERROR_EVENT, { event, ...error });
  return { ok: false, error };
}

export const isNonEmptyId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 128;
