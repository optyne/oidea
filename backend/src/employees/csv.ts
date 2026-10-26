/**
 * 小型 RFC 4180 CSV 解析器（不引入第三方套件，spec §6 第 6 點）。
 *
 * - 欄位以逗號分隔；記錄以 CRLF、LF 或單獨的 CR 分隔。
 * - 用雙引號包住的欄位可以含逗號、換行；欄位內的 `""` 代表一個 `"`。
 * - 檔頭的 UTF-8 BOM 會被移除。
 * - 完全空白的行（沒有任何字元）略過；結尾的換行不會多出一筆空記錄。
 * - 沒有引號的欄位中間出現 `"` 照字面保留（寬鬆）；但引號欄位結束後若接著逗號／換行以外的字元，
 *   或引號沒有關閉，就丟 CsvParseError（這通常代表檔案壞了，不要默默匯入錯的資料）。
 */
export class CsvParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`CSV 第 ${line} 行：${message}`);
    this.name = 'CsvParseError';
  }
}

export interface CsvRecord {
  /** 這筆記錄開始的行號（從 1 起算；引號欄位內的換行也會算進行號）。 */
  line: number;
  fields: string[];
}

export function parseCsv(input: string): CsvRecord[] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let line = 1;
  let recordLine = 1;
  let i = 0;
  // 這筆記錄是否已經讀到任何字元（用來略過完全空白的行）
  let recordHasContent = false;

  const endField = () => {
    fields.push(field);
    field = '';
  };
  const endRecord = () => {
    endField();
    if (recordHasContent) records.push({ line: recordLine, fields });
    fields = [];
    recordHasContent = false;
  };
  /** 吃掉一個換行（CRLF／LF／CR），回傳是否吃到。 */
  const consumeNewline = (): boolean => {
    const c = text[i];
    if (c === '\r') {
      i += text[i + 1] === '\n' ? 2 : 1;
      line++;
      return true;
    }
    if (c === '\n') {
      i++;
      line++;
      return true;
    }
    return false;
  };

  while (i < text.length) {
    const c = text[i];
    if (field === '' && c === '"') {
      // 引號欄位
      recordHasContent = true;
      const startLine = line;
      i++;
      let closed = false;
      while (i < text.length) {
        const q = text[i];
        if (q === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        if (q === '\r' || q === '\n') {
          // 引號內的換行一律正規化成 \n
          consumeNewline();
          field += '\n';
          continue;
        }
        field += q;
        i++;
      }
      if (!closed) throw new CsvParseError('引號沒有關閉', startLine);
      // 引號欄位之後只能接逗號、換行或檔尾
      const next = text[i];
      if (next === ',') {
        endField();
        i++;
      } else if (next === '\r' || next === '\n') {
        endRecord();
        consumeNewline();
        recordLine = line;
      } else if (next !== undefined) {
        throw new CsvParseError('引號欄位結束後出現多餘的字元', line);
      } else {
        // 檔尾：迴圈結束後收尾
        fields.push(field);
        field = '';
        records.push({ line: recordLine, fields });
        fields = [];
        recordHasContent = false;
        return records;
      }
      continue;
    }
    if (c === ',') {
      recordHasContent = true;
      endField();
      i++;
      continue;
    }
    if (c === '\r' || c === '\n') {
      endRecord();
      consumeNewline();
      recordLine = line;
      continue;
    }
    recordHasContent = true;
    field += c;
    i++;
  }
  // 檔尾沒有換行的最後一筆
  if (recordHasContent || field !== '' || fields.length > 0) endRecord();
  return records;
}
