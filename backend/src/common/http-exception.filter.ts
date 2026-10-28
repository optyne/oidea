import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp ? (exception as HttpException).getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    let message: string | string[] = '伺服器內部錯誤';
    let errorCode: string | undefined;
    // 機器可讀的錯誤碼（例如 SSO exchange 的 `invalid_ticket`），有給才放進 body
    let code: string | undefined;
    // 附帶的明細（例如 owner_transfer_required 要移交的工作空間清單）；只放白名單內的欄位
    let workspaces: unknown[] | undefined;
    // H3 leave_insufficient_balance：目前期間還剩幾天
    let remaining: number | undefined;
    if (isHttp) {
      const res = (exception as HttpException).getResponse();
      if (typeof res === 'string') {
        message = res;
      } else if (res && typeof res === 'object') {
        const obj = res as Record<string, any>;
        message = obj.message ?? message;
        errorCode = obj.error;
        if (typeof obj.code === 'string') code = obj.code;
        if (Array.isArray(obj.workspaces)) workspaces = obj.workspaces;
        if (typeof obj.remaining === 'number') remaining = obj.remaining;
      }
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    if (status >= 500) {
      // log 不含 query string（例如 OIDC callback 的 code、state）
      const pathOnly = (request.originalUrl ?? request.url ?? '').split('?')[0];
      this.logger.error(
        `${request.method} ${pathOnly} - ${JSON.stringify(message)}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    response.status(status).json({
      statusCode: status,
      error: errorCode,
      ...(code ? { code } : {}),
      ...(workspaces ? { workspaces } : {}),
      ...(remaining !== undefined ? { remaining } : {}),
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
