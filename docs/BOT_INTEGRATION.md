# Bot 整合指南

把外部程式接進 Oidea，以 bot 身份在指定頻道收 / 發訊息。典型用法：

- **Claude Code Max / Claude Code CLI** — 本機跑 agent，頻道裡 `@bot-name` 問它做事
- **自訂 agent（例如龍蝦）** — 原本走 Telegram Bot API 的邏輯，改用 Oidea API
- **n8n / Zapier** — 把事件送進特定頻道
- **DevOps 腳本** — CI/CD 完成通知、監控告警

---

## 1. 建立 bot

只有 workspace `owner` / `admin` 可以建。

### A. 用 Swagger UI
打開 `https://api.oidea.oadpiz.com/api/docs` → 登入 → 找 `POST /workspaces/:id/bots`：

```json
{ "name": "龍蝦", "description": "財務 / 文件整理助手" }
```

### B. 用 curl
```bash
curl -X POST https://api.oidea.oadpiz.com/api/workspaces/<workspace_id>/bots \
  -H "Authorization: Bearer <你的 accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"name":"龍蝦","description":"財務 / 文件整理助手"}'
```

回傳長這樣：
```json
{
  "id": "...",
  "name": "龍蝦",
  "botUserId": "...",
  "token": "bot_AbCdEf1234.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

**`token` 只會出現這一次** —— 複製起來存到 bot 的環境變數。之後永遠查不回來。弄丟就撤銷重建。

Bot 自動加入 workspace 所有**公開頻道**（`type: public`）。私有頻道要另外手動加（Channel → 成員 → 邀請 bot 的 username，會是 `bot_xxxxxxxx`）。

---

## 2. Bot 可以呼叫的 API

Bot token 現在**跟使用者 JWT 一樣等級**：所有 `@UseGuards(JwtAuthGuard)` 的端點都接 `Authorization: Bearer bot_xxx.yyy`。權限受 workspace member / 頻道 / 頁面 ACL / 角色限制（預設 bot 是 `member`）。

### 常用便利 endpoint（專為 bot 設計，可略）

| 方法 | 路徑 | 用途 |
|---|---|---|
| `GET` | `/api/bot/me` | 驗證 token、取得 bot 資訊 + 可見頻道 + **能力清單 + OpenAPI 指標** |
| `GET` | `/api/bot/channels/:channelId/messages?after=ISO&limit=50` | 拉歷史訊息（polling） |
| `POST` | `/api/bot/messages` | 發訊息到某頻道 |

### 讓龍蝦自己知道能做什麼

`GET /bot/me` 現在回傳這樣：

```json
{
  "id": "...", "name": "龍蝦", "userId": "...", "workspaceId": "...",
  "user": { ... }, "workspace": { ... },
  "role": "member",
  "channels": [ { "id", "name", "type" } ],
  "capabilities": [
    { "op": "send_message", "method": "POST", "path": "/messages", "desc": "在頻道發訊息" },
    { "op": "create_task", "method": "POST", "path": "/tasks", "desc": "建任務（需要是 project 成員）" },
    { "op": "create_db_row", "method": "POST", "path": "/knowledge/databases/:id/rows", "desc": "新增一筆資料列（例如記帳）" },
    // ... 若 role=admin / finance / hr 還會多 approve_expense / attendance_report 等
  ],
  "apiSpec": {
    "openapiJson": "/api/docs-json",
    "swaggerUi": "/api/docs"
  }
}
```

**LLM-powered bot 的建議流程：** 啟動時打一次 `/bot/me`，把 `capabilities` 陣列餵給 Claude 當 system prompt / tools 清單。要更完整就再去抓 `apiSpec.openapiJson`。每次加新 role 或 bot 權限變動，重啟 bot 自動同步。

### 主站 API（全都能打）

Bot 能以 member 身份存取所有業務模組：

| 模組 | 能做什麼（範例） |
|---|---|
| **知識庫資料表** | `POST /api/knowledge/databases/:id/rows` 寫一筆財務 log、`PUT /api/knowledge/rows/:id` 改金額 / 備註、`GET /api/knowledge/databases/:id/finance-summary` 拉月結 |
| **知識庫頁面** | `PUT /api/knowledge/pages/:id/blocks` 整頁覆寫 block（寫文件、摘要、報告） |
| **專案任務** | `POST /api/tasks` 建任務卡、`PATCH /api/tasks/:id` 改狀態 / 指派、`POST /api/tasks/:id/comments` |
| **費用報銷** | `POST /api/expenses` 送單、`POST /api/expenses/:id/receipts` 附發票（需要 `expense.approve` 權限才能核准） |
| **考勤** | `POST /api/attendance/check-in` 打卡、`POST /api/attendance/leaves` 送假 |
| **會議** | `POST /api/meetings` 建會議、邀請成員 |
| **訊息** | `POST /api/messages`、`/api/messages/broadcast`（跨頻道廣播） |
| **通知** | `GET /api/notifications` bot 自己的通知 |
| **工作空間** | `GET /api/workspaces/:id` 讀資訊、`GET /api/users/search?q=` 找成員 |
| **審計日誌** | 僅 bot 為 admin 角色時可讀 |

完整 API 清單見 `https://api.oidea.oadpiz.com/api/docs`（Swagger UI）。想讓 bot 有更高權限（例如自動核准報銷），管理員可把 bot 的角色從 `member` 改成 `admin` / `finance` / `hr`（ERP → 成員與權限 → 點 bot user 改角色）。

### 實用組合：Bot 看到訊息 → 自動寫進財務表

```bash
# 1. 拉 #finance 頻道的新訊息
curl "https://api.oidea.oadpiz.com/api/bot/channels/<finance_channel>/messages?after=$LAST" \
  -H "Authorization: Bearer $TOKEN"

# 2. bot 用 Claude / regex 解析出「2026/04/21 午餐 $350 餐飲 現金」

# 3. 寫一筆 row 進記帳 database
curl -X POST https://api.oidea.oadpiz.com/api/knowledge/databases/<finance_db_id>/rows \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"values":{"date":"2026-04-21","category":"food","amount":350,"account":"cash","note":"午餐"}}'

# 4. 回覆原頻道告知使用者
curl -X POST https://api.oidea.oadpiz.com/api/bot/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channelId":"<finance_channel>","content":"✅ 已記入記帳表"}'
```

### 發訊息

```bash
curl -X POST https://api.oidea.oadpiz.com/api/bot/messages \
  -H "Authorization: Bearer bot_xxx.yyy" \
  -H "Content-Type: application/json" \
  -d '{"channelId":"<channel_id>","content":"你好，我是龍蝦"}'
```

支援 Markdown（一般訊息就是 plaintext）；想 code block 就包 ```` ``` ````。也可以 `parentId` 回覆某則訊息開討論串。

### Polling 拉訊息

```bash
curl "https://api.oidea.oadpiz.com/api/bot/channels/<channel_id>/messages?after=2026-04-21T10:00:00Z&limit=50" \
  -H "Authorization: Bearer bot_xxx.yyy"
```

回傳一批訊息（依時間升序），每則含 `senderId`、`content`、`createdAt`。記得把最後一筆的 `createdAt` 當下次 `after` 的輸入，避免重複處理。

---

## 3. 完整範例：Python 串 Claude Code

這支腳本把頻道訊息接到 `claude` CLI（Claude Code），輸出貼回頻道。你要裝 Claude Code Max 才能用 `claude -p` 子命令。

`claude_bridge.py`：

```python
#!/usr/bin/env python3
"""
聽 Oidea 頻道，把提到 "@claude" 的訊息丟給 Claude Code CLI，輸出貼回頻道。
設好環境變數後 `python3 claude_bridge.py` 就在背景跑。
"""
import os, time, subprocess, requests
from datetime import datetime, timezone

OIDEA_API    = os.environ.get("OIDEA_API", "https://api.oidea.oadpiz.com/api")
BOT_TOKEN    = os.environ["OIDEA_BOT_TOKEN"]
CHANNEL_ID   = os.environ["OIDEA_CHANNEL_ID"]
WORKING_DIR  = os.environ.get("CLAUDE_CODE_DIR", os.path.expanduser("~"))
POLL_SECS    = int(os.environ.get("POLL_SECS", "3"))
TRIGGER      = os.environ.get("TRIGGER", "@claude")

S = requests.Session()
S.headers["Authorization"] = f"Bearer {BOT_TOKEN}"

# 先抓自己 user id（避免回到自己的訊息觸發自己）
me = S.get(f"{OIDEA_API}/bot/me").json()
BOT_USER_ID = me["userId"]
print(f"[bridge] logged in as {me['user']['displayName']} (bot user={BOT_USER_ID})")

cursor = datetime.now(timezone.utc).isoformat()

while True:
    try:
        r = S.get(
            f"{OIDEA_API}/bot/channels/{CHANNEL_ID}/messages",
            params={"after": cursor, "limit": 50},
            timeout=15,
        )
        r.raise_for_status()
        for msg in r.json():
            cursor = msg["createdAt"]
            if msg["senderId"] == BOT_USER_ID:
                continue
            content = msg.get("content") or ""
            if TRIGGER not in content:
                continue
            prompt = content.replace(TRIGGER, "").strip()
            if not prompt:
                continue

            print(f"[bridge] running claude on: {prompt[:80]}")
            try:
                out = subprocess.run(
                    ["claude", "-p", prompt],
                    cwd=WORKING_DIR,
                    capture_output=True, text=True, timeout=600,
                )
                text = (out.stdout or out.stderr or "(no output)").strip()
            except subprocess.TimeoutExpired:
                text = "⚠️ Claude Code 10 分鐘沒完工,放棄。"
            except FileNotFoundError:
                text = "⚠️ 本機沒裝 `claude` CLI。"

            # Oidea 訊息上限沒硬擋但太長不好讀;超過 6000 切
            if len(text) > 6000:
                text = text[:6000] + "\n\n... (已截斷,剩 %d 字)" % (len(text) - 6000)

            S.post(
                f"{OIDEA_API}/bot/messages",
                json={"channelId": CHANNEL_ID, "content": f"```\n{text}\n```"},
                timeout=30,
            ).raise_for_status()

    except requests.HTTPError as e:
        print(f"[bridge] HTTP error: {e} {getattr(e.response, 'text', '')}")
    except Exception as e:
        print(f"[bridge] error: {e}")

    time.sleep(POLL_SECS)
```

執行：
```bash
export OIDEA_BOT_TOKEN='bot_xxx.yyy'
export OIDEA_CHANNEL_ID='<你要 bot 常駐的頻道 id>'
export CLAUDE_CODE_DIR="$HOME/my-project"    # Claude Code 在哪個目錄工作
python3 claude_bridge.py
```

現在在 Oidea 那個頻道打：
```
@claude 把 README 裡面的 TODO 整理成 checklist
```

Claude Code 會在 `CLAUDE_CODE_DIR` 讀 README、做事、把回覆貼到頻道。

---

## 4. 完整範例：Node.js（無 Claude Code，純自訂邏輯，替換 Telegram bot 用）

如果你現在龍蝦在 Telegram 上大概長這樣：

```js
// 舊的：Telegram
bot.on('message', async (msg) => {
  const reply = await doStuff(msg.text);
  await bot.sendMessage(msg.chat.id, reply);
});
```

換到 Oidea 是兩個 endpoint 的事：

```js
// 新的：Oidea
import axios from 'axios';

const API = process.env.OIDEA_API || 'https://api.oidea.oadpiz.com/api';
const TOKEN = process.env.OIDEA_BOT_TOKEN;
const CHANNEL_ID = process.env.OIDEA_CHANNEL_ID;
const H = { Authorization: `Bearer ${TOKEN}` };

const me = (await axios.get(`${API}/bot/me`, { headers: H })).data;
const BOT_USER_ID = me.userId;

let cursor = new Date().toISOString();

async function tick() {
  const { data: msgs } = await axios.get(
    `${API}/bot/channels/${CHANNEL_ID}/messages`,
    { headers: H, params: { after: cursor, limit: 50 } },
  );
  for (const m of msgs) {
    cursor = m.createdAt;
    if (m.senderId === BOT_USER_ID) continue;
    const reply = await doStuff(m.content);  // 你原本的邏輯
    await axios.post(
      `${API}/bot/messages`,
      { channelId: CHANNEL_ID, content: reply },
      { headers: H },
    );
  }
}

setInterval(() => tick().catch(e => console.error(e.response?.data ?? e)), 3000);
```

---

## 5. 跨頻道、多 bot、私有頻道

- **一個 bot 可聽多頻道**：腳本裡 for-loop 幾個 channelId 各做一次 polling 即可
- **一個 workspace 可以有多 bot**：每個 bot 各有自己的 token，用 `@name` 分流（你自己 regex 判斷）
- **私有頻道**：Bot 建立時只會自動加入**公開頻道**。私有頻道要另外手動邀 bot user（username 是 `bot_<hex>`，建立時的 response 的 `botUserId` 可以找到對應使用者）

---

## 6. 安全性 & 限制

- **Token 是明文 secret 級別** — 不要貼 GitHub / Discord / log
- **撤銷**：`DELETE /api/workspaces/:id/bots/:botId`，原本那條 token 馬上失效
- **沒 rate limit** — 因為 bot 會自行按需呼叫；別寫 while(true) 零 sleep
- **Bot 看得到同 workspace 所有公開頻道內容** — 資訊敏感的頻道請設私有
- **撤銷不會刪歷史訊息** — bot 之前發的訊息仍在頻道裡，只是 bot 再也不能認證

---

## 7. 常見問題

| 症狀 | 原因 / 解法 |
|---|---|
| 401 `無效或已撤銷的 bot token` | Token 被撤銷、或 workspace 被刪 |
| 403 `Bot 不是此頻道成員` | 私有頻道；去頻道邀請 bot user |
| 404 on `/bot/me` | Auth header 少了 `Bearer ` 前綴，或 token 格式不對（應為 `bot_xxx.yyy`） |
| polling 拉不到新訊息 | `after` 時間格式要 ISO 8601（含時區），例如 `2026-04-21T10:00:00Z` |
| 收到自己發的訊息一直 loop | 拉到後比對 `senderId === 自己的 botUserId`，是就 skip |
