/**
 * CORS 來源設定，與 `main.ts` 的 `app.enableCors()` 同一套規則：
 * - `CORS_ORIGIN` 有設：逗號分隔的白名單；
 * - 沒設：允許任何來源（開發用，跟 HTTP API 一樣）。
 *
 * 給 socket.io gateway 用。gateway 的 decorator 在 import 時就求值，那時 ConfigModule 可能還沒把
 * `.env` 載進 process.env，所以這裡回傳函式，每次握手時才讀環境變數。
 */
export function parseCorsOrigin(raw: string | undefined): string[] | true {
  if (!raw) return true;
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : true;
}

type OriginCallback = (err: Error | null, origin?: string[] | boolean) => void;

export function corsOriginFromEnv(_requestOrigin: string | undefined, callback: OriginCallback): void {
  callback(null, parseCorsOrigin(process.env.CORS_ORIGIN));
}
