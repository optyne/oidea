import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../decorators/public.decorator';
import { OidcFlowService } from './oidc-flow.service';

/**
 * 每個 IP 每分鐘 60 次（三個端點各自計）。沒設 TRUST_PROXY 時全公司共用反向代理的 IP，
 * 所以不能太緊：一次登入 start、callback、exchange 各一次。exchange 的 ticket 是 32 bytes
 * 隨機數、只能用一次，限流不是用來防猜測，而是防濫用（start 會在 Redis 留 10 分鐘的 state）。
 */
const SSO_THROTTLE = { default: { ttl: 60_000, limit: 60 } };

/** ticket 只在 fragment／自訂 scheme 裡；這兩個 header 讓它不進 Referer 與快取。 */
function noLeakHeaders(res: Response) {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

const auditCtx = (req: Request) => ({ ip: req.ip, headers: req.headers });

@ApiTags('認證')
@Controller('auth/oidc')
export class OidcController {
  constructor(private readonly flow: OidcFlowService) {}

  @Get('start')
  @Public()
  @Throttle(SSO_THROTTLE)
  @ApiOperation({
    summary: 'SSO 開始：302 到 IdP（client=web|mobile、app_challenge=S256）；SSO 沒開 404，參數錯誤 400',
  })
  async start(
    @Query('client') client: unknown,
    @Query('app_challenge') appChallenge: unknown,
    @Res() res: Response,
  ) {
    const location = await this.flow.start(client, appChallenge);
    noLeakHeaders(res);
    res.redirect(302, location);
  }

  @Get('callback')
  @Public()
  @Throttle(SSO_THROTTLE)
  @ApiOperation({ summary: 'IdP 轉回來的 callback：302 回 App（web 用 #ticket= / #error=，mobile 用 ?ticket= / ?error=）' })
  async callback(@Query() query: Record<string, unknown>, @Req() req: Request, @Res() res: Response) {
    const location = await this.flow.callback(query, auditCtx(req));
    noLeakHeaders(res);
    res.redirect(302, location);
  }

  @Post('exchange')
  @Public()
  @Throttle(SSO_THROTTLE)
  @ApiOperation({ summary: 'ticket + app_verifier 換 { accessToken, refreshToken, user }；失敗 400/401 帶 code' })
  async exchange(
    // 不用 DTO class：格式錯誤要回帶 `code` 的 400（由 service 驗），不是 ValidationPipe 的訊息陣列
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.flow.exchange(body?.ticket, body?.app_verifier, auditCtx(req));
  }
}
