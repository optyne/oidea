"""Render each worksheet as a PNG preview image."""
from pathlib import Path
import matplotlib.pyplot as plt
import matplotlib.patches as patches
from matplotlib import rcParams
import matplotlib.font_manager as fm

BASE = Path(__file__).parent
OUT_DIR = BASE / "預覽圖"
OUT_DIR.mkdir(exist_ok=True)

# Find a CJK-capable font
cjk_candidates = [
    "Noto Sans CJK TC", "Noto Sans CJK JP", "Noto Sans CJK SC",
    "WenQuanYi Micro Hei", "WenQuanYi Zen Hei",
    "Microsoft JhengHei", "PingFang TC", "Heiti TC",
]
available = {f.name for f in fm.fontManager.ttflist}
chosen = next((c for c in cjk_candidates if c in available), None)
if chosen is None:
    for f in fm.fontManager.ttflist:
        if any(k in f.name.lower() for k in ["cjk", "han", "hei", "ming", "song", "noto"]):
            chosen = f.name
            break
if chosen:
    rcParams["font.family"] = chosen
    print(f"Using font: {chosen}")
else:
    print("WARNING: no CJK font found; characters may render as tofu")
rcParams["axes.unicode_minus"] = False

HEADER_BG = "#4472C4"
HEADER_FG = "#FFFFFF"
TITLE_COLOR = "#1F3864"
HILITE_BG = "#FFF2CC"
TOTAL_BG = "#FCE4D6"
TOTAL_FG = "#C00000"
ALT_BG = "#F2F2F2"
BORDER = "#BFBFBF"

def render_table(title, headers, rows, filename, col_widths=None,
                 hilite_rows=None, total_row=None, highlight_col=None,
                 subtitle=None, extra_below=None):
    """Render a single-table worksheet."""
    n_rows = len(rows) + 1  # +header
    n_cols = len(headers)
    if col_widths is None:
        col_widths = [1.0] * n_cols
    total_width = sum(col_widths)
    fig_w = max(10, total_width * 0.95)
    fig_h = 1.8 + n_rows * 0.42 + (0.6 if subtitle else 0) + (1.2 if extra_below else 0)
    fig, ax = plt.subplots(figsize=(fig_w, fig_h))
    ax.set_xlim(0, total_width)
    ax.set_ylim(0, fig_h)
    ax.axis("off")

    # Title
    ax.text(0.1, fig_h - 0.45, title, fontsize=20, fontweight="bold", color=TITLE_COLOR)
    if subtitle:
        ax.text(0.1, fig_h - 0.9, subtitle, fontsize=10, color="#555")

    # Table positioning
    top = fig_h - 1.2
    row_h = 0.42

    # Header row
    x = 0
    for i, (h, w) in enumerate(zip(headers, col_widths)):
        ax.add_patch(patches.Rectangle((x, top - row_h), w, row_h,
                                       facecolor=HEADER_BG, edgecolor=BORDER, linewidth=0.5))
        ax.text(x + w / 2, top - row_h / 2, str(h),
                ha="center", va="center", fontsize=9, fontweight="bold", color=HEADER_FG)
        x += w

    # Body rows
    for ri, row in enumerate(rows):
        y = top - row_h * (ri + 2)
        x = 0
        is_hilite = hilite_rows and ri in hilite_rows
        is_total = total_row is not None and ri == total_row
        row_bg = TOTAL_BG if is_total else (HILITE_BG if is_hilite else (ALT_BG if ri % 2 == 1 else "white"))
        for ci, (val, w) in enumerate(zip(row, col_widths)):
            bg = row_bg
            ax.add_patch(patches.Rectangle((x, y), w, row_h,
                                           facecolor=bg, edgecolor=BORDER, linewidth=0.5))
            color = TOTAL_FG if is_total else "black"
            weight = "bold" if is_total else "normal"
            ax.text(x + 0.08, y + row_h / 2, str(val),
                    ha="left", va="center", fontsize=8.5, color=color, fontweight=weight)
            x += w

    if extra_below:
        y = top - row_h * (n_rows + 1) - 0.2
        for line in extra_below:
            ax.text(0.15, y, line, fontsize=9, color="#333")
            y -= 0.32

    plt.tight_layout()
    path = OUT_DIR / filename
    plt.savefig(path, dpi=150, bbox_inches="tight", facecolor="white")
    plt.close()
    print(f"✅ {path}")

# ---------- 1. 使用說明 ----------
render_table(
    "📘 使用說明",
    ["順序", "工作表", "何時使用"],
    [
        ("1", "📘 使用說明", "首次使用時閱讀（本頁）"),
        ("2", "💎 產品價目表", "新客戶報價前查方案與單價"),
        ("3", "📋 客戶主檔", "成交後登錄客戶基本資料"),
        ("4", "📦 服務項目", "記錄客戶已購買的服務明細"),
        ("5", "💵 收款紀錄 2026", "每次收到款項即登錄"),
        ("6", "🧮 報價單範例", "新客戶報價時複製本表改名使用"),
    ],
    "01-使用說明.png",
    col_widths=[1.0, 3.0, 6.0],
    extra_below=[
        "📋 典型流程：",
        "  ① 客戶詢問 → 打開「💎 產品價目表」確認方案",
        "  ② 複製「🧮 報價單範例」→ 改為客戶名稱",
        "  ③ 成交 → 「📋 客戶主檔」加一列",
        "  ④ 每方案 → 「📦 服務項目」加一列",
        "  ⑤ 收款 → 「💵 收款紀錄」加一列",
    ],
)

# ---------- 2. 產品價目表 ----------
products = [
    ("網站", "官網維護", "WEB-01", "月度維護、內容更新、備份", "月", "[待填]", "", "不含大改版"),
    ("Email", "輕量版", "MAIL-LITE", "5GB × 3 組", "月", "[待填]", "", "個人工作室"),
    ("Email", "標準版", "MAIL-STD", "20GB × 10 組、垃圾過濾", "月", "[待填]", "⭐", "最常成交"),
    ("Email", "專業版", "MAIL-PRO", "50GB × 30 組、獨立 SMTP", "月", "[待填]", "", "中型公司"),
    ("容量加購", "小量", "CAP-S", "額外 10GB", "月", "[待填]", "", ""),
    ("容量加購", "中量", "CAP-M", "額外 50GB", "月", "[待填]", "", ""),
    ("容量加購", "海量", "CAP-L", "額外 200GB", "月", "[待填]", "", ""),
    ("別名", "單個別名", "ALIAS-01", "一個永久別名", "月", "[待填]", "", ""),
    ("別名", "組合包", "ALIAS-03", "三個永久別名", "月", "[待填]", "", "比單買省"),
    ("別名", "時效性", "ALIAS-T", "指定期間、到期停用", "次", "[待填]", "", "活動短期用"),
]
render_table(
    "💎 產品價目表",
    ["類別", "方案名稱", "產品代碼", "規格說明", "單位", "單價(NTD)", "主打", "備註"],
    products,
    "02-產品價目表.png",
    col_widths=[1.2, 1.5, 1.5, 3.8, 0.6, 1.2, 0.6, 1.6],
    hilite_rows={2},
    subtitle="所有服務的統一價目；新增客戶方案時引用「產品代碼」",
)

# ---------- 3. 客戶主檔 ----------
customers = [
    ("C26001", "範例科技有限公司", "12345678", "王大明", "資訊主管", "02-1234-5678",
     "contact@example-tech.com.tw", "台北市中山區範例路1號", "2026-01-15", "朋友介紹", "活躍"),
    ("C26002", "範例設計工作室", "—", "李小美", "負責人", "0933-987-654",
     "hello@example-design.tw", "—", "2026-03-01", "Google 搜尋", "活躍"),
]
render_table(
    "📋 客戶主檔",
    ["客戶編號", "客戶名稱", "統編", "聯絡人", "職稱", "電話", "Email", "地址", "開始合作", "來源", "狀態"],
    customers,
    "03-客戶主檔.png",
    col_widths=[1.0, 2.2, 1.0, 1.0, 1.0, 1.3, 2.5, 2.2, 1.2, 1.1, 0.7],
    subtitle="客戶基本資料；客戶編號規則：C + 年份後 2 碼 + 流水號",
)

# ---------- 4. 服務項目 ----------
services = [
    ("S26001", "C26001", "範例科技", "WEB-01", "官網維護", "1", "8,000", "0", "8,000", "月", "2026-01-15", "2027-01-14", "是", "生效中"),
    ("S26002", "C26001", "範例科技", "MAIL-STD", "Email 標準版", "1", "3,500", "0", "3,500", "月", "2026-01-15", "2027-01-14", "是", "生效中"),
    ("S26003", "C26001", "範例科技", "CAP-M", "容量加購中量", "1", "1,200", "10", "1,080", "月", "2026-02-01", "2027-01-31", "是", "生效中"),
    ("S26004", "C26002", "範例設計", "MAIL-LITE", "Email 輕量版", "1", "1,500", "0", "1,500", "月", "2026-03-01", "2027-02-28", "是", "生效中"),
    ("S26005", "C26002", "範例設計", "ALIAS-03", "別名組合包", "1", "500", "0", "500", "月", "2026-03-01", "2027-02-28", "是", "生效中"),
]
render_table(
    "📦 服務項目",
    ["項目編號", "客戶編號", "客戶名稱", "產品代碼", "方案", "數量", "單價", "折扣%", "小計", "週期", "起始日", "到期日", "續約", "狀態"],
    services,
    "04-服務項目.png",
    col_widths=[0.9, 0.9, 1.3, 1.1, 1.5, 0.5, 0.8, 0.7, 0.8, 0.5, 1.2, 1.2, 0.5, 0.7],
    hilite_rows={2},
    subtitle="客戶已購買服務；小計公式 = 數量 × 單價 × (1 − 折扣%/100)",
)

# ---------- 5. 收款紀錄 2026 ----------
payments = [
    ("2026-01-20", "C26001", "範例科技", "S26001", "2026 Q1 官網維護", "24,000", "銀行轉帳", "AB-12345678", "已對帳"),
    ("2026-01-20", "C26001", "範例科技", "S26002", "2026 Q1 Email 標準版", "10,500", "銀行轉帳", "AB-12345679", "已對帳"),
    ("2026-03-05", "C26002", "範例設計", "S26004", "2026 Q1 Email 輕量版", "4,500", "LINE Pay", "AB-12345680", "已對帳"),
    ("2026-03-05", "C26002", "範例設計", "S26005", "2026 Q1 別名組合包", "1,500", "LINE Pay", "AB-12345681", "已對帳"),
    ("", "", "", "", "年度合計", "40,500", "", "", ""),
]
render_table(
    "💵 收款紀錄 2026",
    ["收款日期", "客戶編號", "客戶名稱", "項目編號", "內容摘要", "金額(NTD)", "付款方式", "發票號碼", "對帳"],
    payments,
    "05-收款紀錄_2026.png",
    col_widths=[1.1, 1.0, 1.3, 1.0, 2.2, 1.1, 1.1, 1.4, 0.8],
    total_row=4,
    subtitle="年度收款流水帳；年度合計使用 SUM 公式自動計算",
)

# ---------- 6. 報價單範例 ----------
fig, ax = plt.subplots(figsize=(10, 12))
ax.set_xlim(0, 10)
ax.set_ylim(0, 14)
ax.axis("off")

ax.text(0.2, 13.3, "🧮 報 價 單", fontsize=22, fontweight="bold", color=TITLE_COLOR)
ax.text(6.5, 13.4, "報價編號", fontsize=10, fontweight="bold")
ax.text(7.8, 13.4, "Q26-0001", fontsize=10)
ax.text(6.5, 13.0, "日期", fontsize=10, fontweight="bold")
ax.text(7.8, 13.0, "2026-04-20", fontsize=10)
ax.text(6.5, 12.6, "有效期", fontsize=10, fontweight="bold")
ax.text(7.8, 12.6, "30 天", fontsize=10)

ax.add_patch(patches.Rectangle((0.2, 10.4), 9.6, 1.8, facecolor="#F8F9FC", edgecolor=BORDER))
ax.text(0.4, 12.0, "客戶資訊", fontsize=12, fontweight="bold", color=TITLE_COLOR)
fields = [("客戶名稱", "[填入]"), ("聯絡人", "[填入]"), ("電話", "[填入]"), ("Email", "[填入]")]
for i, (k, v) in enumerate(fields):
    ax.text(0.6, 11.6 - i * 0.3, k, fontsize=10, fontweight="bold")
    ax.text(2.0, 11.6 - i * 0.3, v, fontsize=10, color="#888")

ax.text(0.2, 9.9, "報價明細", fontsize=12, fontweight="bold", color=TITLE_COLOR)
q_headers = ["產品代碼", "方案名稱", "數量", "單價(NTD)", "小計(NTD)"]
q_widths = [1.5, 3.5, 1.0, 2.0, 2.0]
q_rows = [
    ("MAIL-STD", "Email 標準版 × 3 個月", "3", "3,500", "10,500"),
    ("WEB-01", "官網維護 × 3 個月", "3", "8,000", "24,000"),
    ("ALIAS-03", "別名組合包 × 3 個月", "3", "500", "1,500"),
    ("", "", "", "", ""),
]
top = 9.3
row_h = 0.5
x = 0.2
for h, w in zip(q_headers, q_widths):
    ax.add_patch(patches.Rectangle((x, top - row_h), w, row_h,
                                   facecolor=HEADER_BG, edgecolor=BORDER))
    ax.text(x + w / 2, top - row_h / 2, h, ha="center", va="center",
            fontsize=10, fontweight="bold", color="white")
    x += w

for ri, r in enumerate(q_rows):
    y = top - row_h * (ri + 2)
    x = 0.2
    bg = ALT_BG if ri % 2 == 1 else "white"
    for val, w in zip(r, q_widths):
        ax.add_patch(patches.Rectangle((x, y), w, row_h, facecolor=bg, edgecolor=BORDER))
        ax.text(x + 0.1, y + row_h / 2, val, ha="left", va="center", fontsize=9.5)
        x += w

total_top = top - row_h * 6
labels_values = [("未稅小計", "36,000"), ("營業稅 5%", "1,800")]
for i, (lbl, val) in enumerate(labels_values):
    y = total_top - i * row_h
    ax.add_patch(patches.Rectangle((0.2 + 1.5 + 3.5 + 1.0, y), 2.0, row_h, facecolor="#F2F2F2", edgecolor=BORDER))
    ax.text(0.2 + 1.5 + 3.5 + 1.0 + 1.0, y + row_h / 2, lbl, ha="center", va="center", fontsize=10, fontweight="bold")
    ax.add_patch(patches.Rectangle((0.2 + 1.5 + 3.5 + 1.0 + 2.0, y), 2.0, row_h, facecolor="white", edgecolor=BORDER))
    ax.text(0.2 + 1.5 + 3.5 + 1.0 + 2.0 + 1.9, y + row_h / 2, val, ha="right", va="center", fontsize=10)

y = total_top - 2 * row_h
ax.add_patch(patches.Rectangle((0.2 + 1.5 + 3.5 + 1.0, y), 2.0, row_h, facecolor=TOTAL_BG, edgecolor=BORDER))
ax.text(0.2 + 1.5 + 3.5 + 1.0 + 1.0, y + row_h / 2, "合計（含稅）",
        ha="center", va="center", fontsize=11, fontweight="bold", color=TOTAL_FG)
ax.add_patch(patches.Rectangle((0.2 + 1.5 + 3.5 + 1.0 + 2.0, y), 2.0, row_h, facecolor=TOTAL_BG, edgecolor=BORDER))
ax.text(0.2 + 1.5 + 3.5 + 1.0 + 2.0 + 1.9, y + row_h / 2, "37,800",
        ha="right", va="center", fontsize=11, fontweight="bold", color=TOTAL_FG)

ax.text(0.2, 4.0, "備註", fontsize=12, fontweight="bold", color=TITLE_COLOR)
notes = [
    "1. 本報價含稅",
    "2. 付款方式：銀行轉帳／LINE Pay／現金",
    "3. 報價有效期內有效，逾期請重新確認",
    "4. 服務正式啟用日以收到款項後起算",
    "5. 續約請於到期前 30 日告知",
]
for i, n in enumerate(notes):
    ax.text(0.4, 3.6 - i * 0.35, n, fontsize=10, color="#333")

plt.tight_layout()
path = OUT_DIR / "06-報價單範例.png"
plt.savefig(path, dpi=150, bbox_inches="tight", facecolor="white")
plt.close()
print(f"✅ {path}")

print("\n🎉 全部預覽圖已生成於", OUT_DIR)
