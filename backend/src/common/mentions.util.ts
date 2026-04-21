/**
 * 共用 @mention 解析：處理兩種格式
 *   - 結構化 `@[Name](userId)` —— autocomplete 產生，userId 精確
 *   - 舊式 `@username` —— 純文字
 *
 * 純邏輯，無 DB 呼叫；DB 反查與成員驗證由 caller 處理。
 */
export function extractMentionTokens(content: string): {
  structuredIds: string[];
  usernames: string[];
} {
  if (!content) return { structuredIds: [], usernames: [] };

  const structuredIds = Array.from(
    new Set(
      Array.from(content.matchAll(/@\[[^\]]+\]\(([^)]+)\)/g), (m) => m[1]),
    ),
  );

  // 把結構化段從文字挖掉，避免 `@[John](uid)` 裡的 `John` 被當作 username 比對
  const withoutStructured = content.replace(/@\[[^\]]+\]\([^)]+\)/g, ' ');
  const usernames = Array.from(
    new Set(
      Array.from(withoutStructured.matchAll(/@([A-Za-z0-9_]{2,32})/g), (m) => m[1]),
    ),
  );

  return { structuredIds, usernames };
}

/** 通知預覽用：把 `@[Name](uid)` 原始 token 換回 `@Name`，使用者看不到 uid。 */
export function stripMentionTokensForPreview(content: string): string {
  return content.replace(/@\[([^\]]+)\]\([^)]+\)/g, '@$1');
}
