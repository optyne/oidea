/**
 * 從 stdin 讀一行秘密（密碼），不回顯、不寫 log。
 *
 * - 終端機（TTY）：切到 raw mode 一個字一個字讀，畫面上什麼都不顯示；Enter 結束、Backspace 刪字、
 *   Ctrl-C／Ctrl-D 取消。
 * - 管線（例如 `printf '%s\n' "$PW" | npm run ...`）：讀到 EOF，取第一行（去掉結尾的 \r\n）。
 */
export interface SecretInput extends NodeJS.EventEmitter {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  setEncoding?: (enc: BufferEncoding) => unknown;
  resume?: () => unknown;
  pause?: () => unknown;
}

export interface SecretOutput {
  write(chunk: string): unknown;
}

export class SecretInputCancelled extends Error {
  constructor() {
    super('已取消');
  }
}

export function readSecret(prompt: string, input: SecretInput, output: SecretOutput): Promise<string> {
  if (input.isTTY && typeof input.setRawMode === 'function') return readFromTty(prompt, input, output);
  return readFromPipe(input);
}

function readFromPipe(input: SecretInput): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const onData = (c: Buffer | string) => chunks.push(typeof c === 'string' ? Buffer.from(c, 'utf8') : c);
    const cleanup = () => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
    };
    const onEnd = () => {
      cleanup();
      const text = Buffer.concat(chunks).toString('utf8');
      const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
      resolve(firstLine);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onError);
    input.resume?.();
  });
}

function readFromTty(prompt: string, input: SecretInput, output: SecretOutput): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    output.write(prompt);
    input.setRawMode!(true);
    input.setEncoding?.('utf8');
    const finish = (err?: Error) => {
      input.setRawMode!(false);
      input.off('data', onData);
      input.pause?.();
      output.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string | Buffer) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003' || ch === '\u0004') return finish(new SecretInputCancelled());
        if (ch === '\u007f' || ch === '\b') {
          value = [...value].slice(0, -1).join('');
          continue;
        }
        value += ch;
      }
    };
    input.on('data', onData);
    input.resume?.();
  });
}
