import { BreakGlassPasswordError } from '../auth/break-glass-password.service';
import { SecretInputCancelled } from './read-secret';
import { CliIo } from './run-cli';

export interface SetBreakGlassPasswordDeps extends CliIo {
  setPassword: (email: string, password: string) => Promise<{ userId: string }>;
  /** 讀一次密碼（不回顯）。confirm=true 是第二次確認。 */
  readSecret: (prompt: string) => Promise<string>;
  /** stdin 是終端機時要求輸入兩次 */
  interactive: boolean;
  /** email 是否在 BREAK_GLASS_OWNER_EMAILS（只用來提醒） */
  isListed: (email: string) => boolean;
}

export const SET_BREAK_GLASS_USAGE =
  "用法：npm run auth:set-break-glass-password -- <email>（密碼從 stdin 讀；可用 printf '%s\\n' \"$PW\" | npm run ... 管線輸入）";

/**
 * `npm run auth:set-break-glass-password -- <email>`。成功 0，失敗 1。
 * 密碼只從 stdin 讀，絕不出現在輸出、錯誤訊息或參數裡。
 */
export async function runSetBreakGlassPassword(argv: string[], deps: SetBreakGlassPasswordDeps): Promise<number> {
  const positional = argv.filter((a) => !a.startsWith('-'));
  if (positional.length !== 1 || argv.length !== 1) {
    deps.err(SET_BREAK_GLASS_USAGE);
    return 1;
  }
  const email = positional[0];

  let password: string;
  try {
    password = await deps.readSecret('緊急登入密碼（不會顯示）：');
    if (deps.interactive) {
      const again = await deps.readSecret('再輸入一次：');
      if (again !== password) {
        deps.err('兩次輸入的密碼不同');
        return 1;
      }
    }
  } catch (err) {
    deps.err(err instanceof SecretInputCancelled ? '已取消' : '讀取密碼失敗');
    return 1;
  }

  try {
    const res = await deps.setPassword(email, password);
    deps.out(`已設定使用者 ${res.userId} 的緊急登入密碼（已寫入 audit auth.break_glass_password_set）`);
    if (!deps.isListed(email)) {
      deps.out('提醒：這個 email 不在 BREAK_GLASS_OWNER_EMAILS；帳密登入關閉時要先把它加進去並重新部署才能登入');
    }
    return 0;
  } catch (err) {
    if (err instanceof BreakGlassPasswordError) {
      deps.err(err.message);
      return 1;
    }
    // 未知錯誤（例如連不上 DB）：印訊息方便排查，但先把密碼字串遮掉（理論上不會出現，寧可保守）
    const raw = String((err as Error)?.message ?? err);
    const message = password ? raw.split(password).join('***') : raw;
    deps.err(`設定失敗：${message}`);
    return 1;
  }
}
