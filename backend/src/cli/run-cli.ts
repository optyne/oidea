import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { CliModule } from './cli.module';

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const processIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

/**
 * 啟動 CliModule、執行 main、關閉連線並以 main 的回傳值當 exit code。
 * 只在 dist/cli/*.js 的入口呼叫；邏輯本身在 *.command.ts（有單元測試）。
 */
export async function runCli(main: (app: INestApplicationContext) => Promise<number>): Promise<void> {
  let app: INestApplicationContext | undefined;
  let code = 1;
  try {
    app = await NestFactory.createApplicationContext(CliModule, { logger: ['error', 'warn'] });
    code = await main(app);
  } catch (err) {
    processIo.err(`錯誤：${(err as Error).message}`);
    code = 1;
  } finally {
    await app?.close().catch(() => undefined);
  }
  process.exit(code);
}
