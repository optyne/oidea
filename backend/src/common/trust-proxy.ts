/**
 * 解析 `TRUST_PROXY` 環境變數，回傳要交給 Express `app.set('trust proxy', ...)` 的值。
 *
 * - 未設定或空字串：回 `undefined`，呼叫端不要設定（維持 Express 預設：不信任代理）。
 * - 非負整數（例如 `1`、`2`）：信任的代理跳數。
 * - `true` / `false`：照字面（`true` 會信任所有代理，不建議用在正式環境）。
 * - 其他字串：原樣交給 Express（例如 `loopback`、`10.0.0.0/8,172.16.0.0/12`）。
 *
 * 正確的值要在 staging 實測：比對 `req.ip` 與實際的客戶端 IP（見 docs/DEPLOY_DOKPLOY.md）。
 */
export function parseTrustProxy(raw: string | undefined): number | boolean | string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value === '') return undefined;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  return value;
}
