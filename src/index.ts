import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { chromium, type Page } from "playwright";
const BASE_URL = "https://www.set.or.th";

const server = new Server(
  { name: "set-scraper", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ---- Tool definitions ----

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_market_overview",
      description:
        "ดึงภาพรวมตลาด SET: ดัชนี SET Index, mai, ปริมาณ/มูลค่าซื้อขาย, market cap, P/E, dividend yield",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "get_stock_quote",
      description:
        "ดึงราคาและข้อมูลหุ้นรายตัว เช่น ราคา, change, volume, high/low วันนี้",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "ชื่อหุ้น เช่น PTT, ADVANC, DELTA" },
        },
        required: ["symbol"],
      },
    },
    {
      name: "get_top_ranking",
      description:
        "ดึง top 10 หุ้นจาก SET แบ่งเป็น: มูลค่าสูงสุด, ปริมาณสูงสุด, ราคาขึ้นสูงสุด, ราคาลงสูงสุด",
      inputSchema: {
        type: "object",
        properties: {
          rankType: {
            type: "string",
            enum: ["most_active_value", "most_active_volume", "top_gainer", "top_loser"],
            description: "ประเภท ranking",
          },
        },
        required: ["rankType"],
      },
    },
    {
      name: "get_news",
      description:
        "ดึงข่าวตลาดหลักทรัพย์ SET ถ้าระบุ symbol จะกรองเฉพาะข่าวของหุ้นนั้น ถ้าไม่ระบุจะดึงข่าวตลาดทั่วไป สามารถกำหนดช่วงเวลา วันที่ระบุ ประเภทหลักทรัพย์ และจำนวนข่าวได้",
      inputSchema: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "ชื่อหุ้น (optional) เช่น PTT, ADVANC — ถ้าไม่ระบุจะดึงข่าวตลาดรวม",
          },
          period: {
            type: "string",
            enum: ["today", "5D", "1M", "3M"],
            description: "ช่วงเวลา: today=วันนี้ (default), 5D=5วัน, 1M=1เดือน, 3M=3เดือน (ใช้เมื่อไม่ระบุ symbol และไม่ระบุ fromDate/toDate)",
          },
          fromDate: {
            type: "string",
            description: "วันที่เริ่มต้น รับทั้ง DD/MM/YYYY (16/05/2026) และ YYYY-MM-DD (2026-05-16) — ถ้าระบุจะใช้แทน period",
          },
          toDate: {
            type: "string",
            description: "วันที่สิ้นสุด รับทั้ง DD/MM/YYYY และ YYYY-MM-DD — ถ้าไม่ระบุจะใช้ค่าเดียวกับ fromDate",
          },
          securityType: {
            type: "string",
            enum: ["S", "ETF", "DR", "DW", "all"],
            description: "ประเภทหลักทรัพย์: S=หุ้น (default), ETF, DR, DW, all=ทุกประเภท (ใช้เมื่อไม่ระบุ symbol)",
          },
          limit: {
            type: "number",
            description: "จำนวนข่าวสูงสุดที่ต้องการ (default: 20, max: 300)",
          },
        },
        required: [],
      },
    },
    {
      name: "get_index_details",
      description:
        "ดึงข้อมูลดัชนี: SET, SET50, SET100, mai, sSET, SETWB พร้อม OHLC และ YTD",
      inputSchema: {
        type: "object",
        properties: {
          index: {
            type: "string",
            enum: ["SET", "SET50", "SET100", "mai", "sSET", "SETWB"],
            description: "ชื่อดัชนี (default: SET)",
          },
        },
        required: [],
      },
    },
    {
      name: "get_stock_financial",
      description:
        "ดึงข้อมูลการเงินหุ้นรายตัว: งบการเงิน, ปันผล, P/E, P/BV, market cap",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "ชื่อหุ้น เช่น PTT" },
        },
        required: ["symbol"],
      },
    },
    {
      name: "get_shareholders",
      description:
        "ดึงข้อมูลผู้ถือหุ้นรายใหญ่ทั้งหมดที่ SET เปิดเผย (top 10 + ผู้ถือ ≥0.5%) พร้อมผู้ถือ NVDR, ภาพรวม Free Float และจำนวนผู้ถือหุ้นทั้งหมด",
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "ชื่อหุ้น เช่น CHASE, PTT, ADVANC" },
        },
        required: ["symbol"],
      },
    },
    {
      name: "get_f45_content",
      description:
        "ดึงเนื้อหาประกาศงบไตรมาส F45 (สรุปผลการดำเนินงานของ บจ.) ของหุ้นใน SET " +
        "แสดงกำไรสุทธิ รายได้รวม EPS และเปรียบเทียบกับงวดเดียวกันปีก่อน " +
        "ชื่อข่าวที่ต้องการคือ 'สรุปผลการดำเนินงานของ บจ. ไตรมาสที่ X (F45)'",
      inputSchema: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "ชื่อหุ้น เช่น PTT, ADVANC, AJ, CHASE",
          },
          quarter: {
            type: "number",
            description: "ไตรมาสที่ต้องการ (1, 2, 3 หรือ 4) ถ้าไม่ระบุจะดึงล่าสุด",
          },
          year: {
            type: "number",
            description: "ปี พ.ศ. เช่น 2567, 2568 ถ้าไม่ระบุจะดึงล่าสุด",
          },
        },
        required: ["symbol"],
      },
    },
  ],
}));

// ---- Helper ----

async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
    locale: "th-TH",
  });
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await browser.close();
  }
}

function parseLines(text: string, start = 0, end = 80): string {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(start, end)
    .join("\n");
}

// Parse กำไรสุทธิ และ EPS จากเนื้อหา F45
// รูปแบบ: "กำไร (ขาดทุน) \t\t 167,840  60,698" (สองคอลัมน์: ปัจจุบัน vs ปีก่อน)
function parseF45Data(text: string): {
  profit: number | null;
  priorProfit: number | null;
  eps: number | null;
  priorEps: number | null;
} {
  const parseNum = (s: string): number | null => {
    if (!s || !s.trim()) return null;
    const trimmed = s.trim();
    const isNeg = trimmed.startsWith("(");
    const cleaned = trimmed.replace(/[(),\s]/g, "").replace(/,/g, "");
    if (!cleaned) return null;
    const n = parseFloat(cleaned);
    return isNaN(n) ? null : (isNeg ? -n : n);
  };

  let profit: number | null = null;
  let priorProfit: number | null = null;
  let eps: number | null = null;
  let priorEps: number | null = null;
  let profitLineCount = 0;

  for (const line of text.split("\n")) {
    if (line.includes("กำไร") && line.includes("ขาดทุน")) {
      const allNums = line.match(/(\([\d,]+(?:\.\d+)?\)|[\d,]+(?:\.\d+)?)/g) ?? [];

      // ฟอร์ม Q2/Q3 มี 4 คอลัมน์: [ไตรมาส ปีนี้, ไตรมาส ปีก่อน, สะสม ปีนี้, สะสม ปีก่อน]
      // ต้องใช้ "สองค่าแรก" = ตัวเลขรายไตรมาส (ไม่ใช่สองค่าท้ายซึ่งเป็นยอดสะสม)
      // ฟอร์ม Q1/Q4 มี 2 คอลัมน์: [ปีนี้, ปีก่อน] — ใช้ได้ตรงๆ
      let cur: string | undefined;
      let prev: string | undefined;
      if (allNums.length >= 4) {
        cur = allNums[0];
        prev = allNums[1];
      } else if (allNums.length >= 2) {
        cur = allNums[allNums.length - 2];
        prev = allNums[allNums.length - 1];
      }

      if (cur && prev) {
        profitLineCount++;
        if (profitLineCount === 1) {
          profit = parseNum(cur);
          priorProfit = parseNum(prev);
        } else if (profitLineCount === 2) {
          eps = parseNum(cur);
          priorEps = parseNum(prev);
          break;
        }
      }
    }
  }
  return { profit, priorProfit, eps, priorEps };
}

// Parse กำไรสะสม N เดือน จากฟอร์ม Q2/Q3 ที่มีหลาย period
// ค้นหา section "X เดือน" แล้วดึง profit line แรกหลัง section นั้น
function parseF45CumulativeNM(text: string, months: number): {
  profit: number | null;
  priorProfit: number | null;
  eps: number | null;
  priorEps: number | null;
} {
  const parseNum = (s: string): number | null => {
    if (!s || !s.trim()) return null;
    const trimmed = s.trim();
    const isNeg = trimmed.startsWith("(");
    const cleaned = trimmed.replace(/[(),\s]/g, "").replace(/,/g, "");
    if (!cleaned) return null;
    const n = parseFloat(cleaned);
    return isNaN(n) ? null : (isNeg ? -n : n);
  };

  const MONTH_WORDS: Record<number, string> = {
    3: "สาม|three", 6: "หก|six", 9: "เก้า|nine", 12: "สิบสอง|twelve|สิบ.สอง"
  };

  const monthPattern = new RegExp(
    `(?:${months}|${MONTH_WORDS[months] ?? months})\\s*เดือน`,
    "i"
  );

  const lines = text.split("\n");
  let inSection = false;
  let profitCount = 0;
  let profit: number | null = null;
  let priorProfit: number | null = null;
  let eps: number | null = null;
  let priorEps: number | null = null;

  for (const line of lines) {
    if (monthPattern.test(line)) {
      inSection = true;
      profitCount = 0;   // reset เมื่อเจอ section header ใหม่
    }
    if (inSection && line.includes("กำไร") && line.includes("ขาดทุน")) {
      // ถ้ามี 4 ตัวเลขในบรรทัด (3mo+9mo อยู่บรรทัดเดียว) → ดึงสองค่าท้าย
      const allNums = line.match(/(\([\d,]+(?:\.\d+)?\)|[\d,]+(?:\.\d+)?)/g) ?? [];
      if (allNums.length >= 4) {
        profitCount++;
        if (profitCount === 1) {
          profit      = parseNum(allNums[allNums.length - 2]);
          priorProfit = parseNum(allNums[allNums.length - 1]);
        } else if (profitCount === 2) {
          eps      = parseNum(allNums[allNums.length - 2]);
          priorEps = parseNum(allNums[allNums.length - 1]);
          break;
        }
      } else {
        // 2 ตัวเลข — อ่านค่าปกติ
        const m = line.match(
          /\s+(\([\d,]+(?:\.\d+)?\)|[\d,]+(?:\.\d+)?)\s+(\([\d,]+(?:\.\d+)?\)|[\d,]+(?:\.\d+)?)\s*$/
        );
        if (m) {
          profitCount++;
          if (profitCount === 1) {
            profit      = parseNum(m[1]);
            priorProfit = parseNum(m[2]);
          } else if (profitCount === 2) {
            eps      = parseNum(m[1]);
            priorEps = parseNum(m[2]);
            break;
          }
        }
      }
    }
  }

  // Fallback: ถ้าหา section ไม่เจอ ใช้ parseF45Data แทน
  if (profit === null) {
    return parseF45Data(text);
  }
  return { profit, priorProfit, eps, priorEps };
}

// ---- Tool handlers ----

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // 1. Market Overview
  if (name === "get_market_overview") {
    const data = await withPage(async (page) => {
      await page.goto(`${BASE_URL}/th/market/product/stock/overview`, {
        waitUntil: "networkidle",
        timeout: 30000,
      });

      // รอดัชนีโหลด
      await page.waitForFunction(
        () => document.body.innerText.includes("มูลค่า"),
        { timeout: 15000 }
      );

      // ดึงส่วน top10 (มีข้อมูลหุ้น) + header
      const top10 = await page.$eval(
        ".stock-quote-overview-top10",
        (el) => (el as HTMLElement).innerText
      ).catch(() => "");

      const headerText = await page.evaluate(() => {
        const header = document.querySelector(".market-summary, .index-summary, [class*='index']");
        return header ? (header as HTMLElement).innerText : "";
      });

      const bodyText = await page.evaluate(() => document.body.innerText);
      return { top10, headerText, bodyText };
    });

    const lines = parseLines(data.bodyText);
    const top10Block = data.top10 ? `\n\n--- มูลค่าซื้อขาย 10 อันดับ ---\n${data.top10}` : "";

    return {
      content: [{ type: "text", text: `=== ภาพรวมตลาด SET ===\n\n${lines}${top10Block}` }],
    };
  }

  // 2. Stock Quote
  if (name === "get_stock_quote") {
    const { symbol } = args as { symbol: string };
    const sym = symbol.toUpperCase().trim();

    const data = await withPage(async (page) => {
      await page.goto(`${BASE_URL}/th/market/product/stock/quote/${sym}/price`, {
        waitUntil: "networkidle",
        timeout: 30000,
      });

      // รอราคาโหลด
      await page.waitForFunction(
        () => {
          const text = document.body.innerText;
          return text.includes("ล่าสุด") || text.includes("สถานะ") || text.includes("Open");
        },
        { timeout: 15000 }
      );

      return page.evaluate(() => {
        const quoteSection =
          document.querySelector(".stock-quote-price, [class*='quote'], main") ||
          document.body;
        return (quoteSection as HTMLElement).innerText;
      });
    });

    const lines = parseLines(data, 0, 60);
    return {
      content: [{ type: "text", text: `=== ราคาหุ้น ${sym} ===\n\n${lines}` }],
    };
  }

  // 3. Top Ranking
  if (name === "get_top_ranking") {
    const { rankType } = args as {
      rankType: "most_active_value" | "most_active_volume" | "top_gainer" | "top_loser";
    };

    const tabLabel: Record<string, string> = {
      most_active_value: "มูลค่าซื้อขาย 10 อันดับ",
      most_active_volume: "ปริมาณซื้อขาย 10 อันดับ",
      top_gainer: "ราคาเพิ่มขึ้น 10 อันดับ",
      top_loser: "ราคาลดลง 10 อันดับ",
    };

    // tab button text patterns บน SET
    const tabText: Record<string, string> = {
      most_active_value: "มูลค่าซื้อขาย",
      most_active_volume: "ปริมาณซื้อขาย",
      top_gainer: "ราคาเพิ่มขึ้น",
      top_loser: "ราคาลดลง",
    };

    const data = await withPage(async (page) => {
      await page.goto(`${BASE_URL}/th/market/product/stock/top-ranking`, {
        waitUntil: "networkidle",
        timeout: 30000,
      });

      await page.waitForTimeout(3000);

      // คลิก tab ที่ตรงกับ rankType
      const targetTab = tabText[rankType];
      const clicked = await page.evaluate((target) => {
        const buttons = Array.from(
          document.querySelectorAll("button, a, [class*='tab'], [class*='nav-link']")
        );
        const btn = buttons.find(
          (b) => b.textContent?.includes(target)
        ) as HTMLElement | undefined;
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      }, targetTab);

      if (clicked) await page.waitForTimeout(2000);

      // ดึงส่วน top10
      const top10 = await page.$eval(
        ".stock-quote-overview-top10",
        (el) => (el as HTMLElement).innerText
      ).catch(() => "");

      if (top10) return top10;

      // fallback: ดึง body text
      return page.evaluate(() => document.body.innerText);
    });

    const lines = typeof data === "string" ? parseLines(data, 0, 60) : data;
    return {
      content: [{ type: "text", text: `=== ${tabLabel[rankType]} ===\n\n${lines}` }],
    };
  }

  // 4. News
  if (name === "get_news") {
    const {
      symbol,
      period = "today",
      fromDate: fromDateInput,
      toDate: toDateInput,
      securityType = "S",
      limit = 20,
    } = args as {
      symbol?: string;
      period?: "today" | "5D" | "1M" | "3M";
      fromDate?: string;
      toDate?: string;
      securityType?: "S" | "ETF" | "DR" | "DW" | "all";
      limit?: number;
    };
    const sym = symbol?.toUpperCase().trim();

    interface NewsItem {
      id: string;
      datetime: string;
      symbol: string;
      source: string;
      headline: string;
      url?: string;
      percentPriceChange?: number | null;
      isTodayNews?: boolean;
      product?: string;
    }

    // ---- helper: format date DD/MM/YYYY ----
    const fmtDate = (d: Date): string =>
      `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;

    const getRange = (p: string): { from: string; to: string } => {
      const today = new Date();
      const to = fmtDate(today);
      switch (p) {
        case "5D": { const d = new Date(today); d.setDate(d.getDate() - 5); return { from: fmtDate(d), to }; }
        case "1M": { const d = new Date(today); d.setMonth(d.getMonth() - 1); return { from: fmtDate(d), to }; }
        case "3M": { const d = new Date(today); d.setMonth(d.getMonth() - 3); return { from: fmtDate(d), to }; }
        default:   return { from: to, to };
      }
    };

    // ---- ถ้าระบุ symbol → ดึงจากหน้า quote ของหุ้น ----
    if (sym) {
      const result = await withPage(async (page) => {
        let newsList: NewsItem[] = [];
        page.on("response", async (res) => {
          if (res.url().includes("/api/set/news/search")) {
            try {
              const json = await res.json() as { totalCount?: number; newsInfoList?: NewsItem[] };
              if (json?.newsInfoList?.length) newsList = json.newsInfoList;
            } catch { /* ignore */ }
          }
        });
        await page.goto(`${BASE_URL}/th/market/product/stock/quote/${sym}/news`, {
          waitUntil: "networkidle", timeout: 30000,
        });
        await page.waitForTimeout(4000);
        return newsList;
      });

      const items = result.slice(0, limit);
      const lines = items.map((n, i) => {
        const dt = new Date(n.datetime).toLocaleString("th-TH", {
          timeZone: "Asia/Bangkok", year: "numeric", month: "short",
          day: "numeric", hour: "2-digit", minute: "2-digit",
        });
        return `[${i + 1}] ${dt}\n     ${n.headline}`;
      }).join("\n\n");

      return {
        content: [{
          type: "text",
          text: `=== ข่าวล่าสุด ${sym} (${items.length} รายการ) ===\n\n${lines || "ไม่พบข่าว"}`,
        }],
      };
    }

    // ---- ไม่ระบุ symbol → ดึงข่าวตลาดทั่วไปผ่าน api/cms/v1/news/set ----
    // API ต้องการ DD/MM/YYYY เท่านั้น ถ้าส่ง ISO (YYYY-MM-DD) จะได้ 0 รายการเงียบๆ
    // จึงรับทั้งสองรูปแบบแล้วแปลงให้ + โยน error ถ้าแปลงไม่ได้ (ดีกว่าคืนลิสต์ว่าง)
    const normalizeDate = (input: string, field: string): string => {
      const s = input.trim();
      const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
      const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (dmy) {
        const [, d, m, y] = dmy;
        return `${d.padStart(2, "0")}/${m.padStart(2, "0")}/${y}`;
      }
      throw new Error(
        `${field} รูปแบบไม่ถูกต้อง: "${input}" — ต้องเป็น DD/MM/YYYY หรือ YYYY-MM-DD`
      );
    };

    // ถ้าระบุ fromDate ให้ใช้แทน period
    let from: string, to: string;
    if (fromDateInput) {
      from = normalizeDate(fromDateInput, "fromDate");
      to = toDateInput ? normalizeDate(toDateInput, "toDate") : from;   // ถ้าไม่ระบุ toDate ใช้วันเดียวกัน
    } else {
      ({ from, to } = getRange(period));
    }
    const perPage = Math.min(limit, 300);

    // params สำหรับ API
    const params = new URLSearchParams({
      fromDate: from,
      toDate: to,
      perPage: String(perPage),
      orderBy: "date",
      lang: "th",
      sourceId: "company",
      ...(securityType !== "all" && { securityTypeIds: securityType }),
    });
    const apiUrl = `${BASE_URL}/api/cms/v1/news/set?${params}`;

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
      locale: "th-TH",
    });
    const page = await context.newPage();

    let clientUuid = "";
    let apiHeaders: Record<string, string> = {};

    // ดัก x-client-uuid จาก request แรกที่ browser ส่ง
    page.on("request", (req) => {
      if (req.url().includes("/api/cms/v1/news/set") && !clientUuid) {
        const h = req.headers();
        clientUuid = h["x-client-uuid"] ?? "";
        apiHeaders = {
          "x-client-uuid":    h["x-client-uuid"] ?? "",
          "x-channel":        h["x-channel"] ?? "WEB_SET",
          "referer":          `${BASE_URL}/th/market/news-and-alert/news`,
          "accept":           "application/json, text/plain, */*",
          "accept-language":  h["accept-language"] ?? "th-TH",
          "user-agent":       h["user-agent"] ?? "",
        };
      }
    });

    let items: NewsItem[] = [];
    let totalCount = 0;

    try {
      // โหลดหน้าก่อนเพื่อรับ session + uuid
      await page.goto(`${BASE_URL}/th/market/news-and-alert/news`, {
        waitUntil: "networkidle", timeout: 30000,
      });
      await page.waitForTimeout(3000);

      // เรียก API โดยตรงด้วย headers ที่ capture ได้
      const res = await context.request.get(apiUrl, { headers: apiHeaders });

      if (res.status() === 200) {
        const json = await res.json() as {
          paginateNews?: { totalCount: number; newsInfoList: NewsItem[] };
          newsGroups?: Array<{ totalCount: number; newsInfoList: NewsItem[] }>;
        };
        const pg = json?.paginateNews ?? json?.newsGroups?.[0];
        totalCount = pg?.totalCount ?? 0;
        items = pg?.newsInfoList ?? [];
      }
    } finally {
      await browser.close();
    }

    // format output
    const periodLabel: Record<string, string> = {
      today: "วันนี้", "5D": "5 วัน", "1M": "1 เดือน", "3M": "3 เดือน",
    };
    const secLabel: Record<string, string> = {
      S: "หุ้น", ETF: "ETF", DR: "DR", DW: "DW", all: "ทุกประเภท",
    };

    const header = `=== ข่าวตลาดหลักทรัพย์ SET [${periodLabel[period] ?? period}] [${secLabel[securityType] ?? securityType}] ===`;
    const subHeader = `พบ ${totalCount.toLocaleString()} รายการ  |  แสดง ${items.length} รายการ  (${from} – ${to})\n`;

    const newsLines = items.map((n, i) => {
      const dt = new Date(n.datetime).toLocaleString("th-TH", {
        timeZone: "Asia/Bangkok", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit",
      });
      const sym2 = (n.symbol ?? "").padEnd(8);
      const pct = n.percentPriceChange != null
        ? ` (${n.percentPriceChange >= 0 ? "+" : ""}${n.percentPriceChange.toFixed(2)}%)`
        : "";
      return `[${String(i + 1).padStart(2)}] ${dt}  ${sym2}${pct}\n      ${n.headline}`;
    }).join("\n\n");

    return {
      content: [{
        type: "text",
        text: `${header}\n${subHeader}\n${newsLines || "ไม่พบข้อมูลข่าว"}`,
      }],
    };
  }

  // 5. Index Details
  if (name === "get_index_details") {
    const { index = "SET" } = args as { index?: string };

    const indexUrlMap: Record<string, string> = {
      SET: "set",
      SET50: "set50",
      SET100: "set100",
      mai: "mai",
      sSET: "sset",
      SETWB: "setwb",
    };

    const data = await withPage(async (page) => {
      await page.goto(
        `${BASE_URL}/th/market/index/${indexUrlMap[index] ?? "set"}/overview`,
        { waitUntil: "networkidle", timeout: 30000 }
      );

      await page.waitForFunction(
        () => document.body.innerText.includes("เปิด"),
        { timeout: 15000 }
      );

      return page.evaluate(() => document.body.innerText);
    });

    return {
      content: [{ type: "text", text: `=== ดัชนี ${index} ===\n\n${parseLines(data, 0, 80)}` }],
    };
  }

  // 6. Stock Financial Info (ดึงจาก SET internal API + fallback table scraping)
  if (name === "get_stock_financial") {
    const { symbol } = args as { symbol: string };
    const sym = symbol.toUpperCase().trim();

    interface FinancialDataItem {
      year: number;
      quarter: string;
      beginDate: string;
      endDate: string;
      totalAsset: number | null;
      totalLiability: number | null;
      equity: number | null;
      paidupCapital: number | null;
      totalRevenue: number | null;
      netProfit: number | null;
      eps: number | null;
      ebit: number | null;
      netOperating: number | null;
      roa: number | null;
      roe: number | null;
      netProfitMargin: number | null;
      grossProfitMargin: number | null;
      deRatio: number | null;
    }

    interface TradingStatItem {
      period: string;
      date: string;
      close: number | null;
      pe: number | null;
      pbv: number | null;
      bookValuePerShare: number | null;
      dividendYield: number | null;
      dividendPayoutRatio: number | null;
      marketCap: number | null;
      beta: number | null;
      turnoverRatio: number | null;
    }

    const fmt = (v: number | null | undefined, digits = 2): string => {
      if (v === null || v === undefined) return "-";
      return v.toLocaleString("th-TH", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    };

    const periodLabel = (item: FinancialDataItem): string => {
      if (item.quarter === "Q9") return `ปี ${item.year + 543}`;
      return `Q${item.quarter.replace("Q", "")}/${item.year + 543}`;
    };

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
      locale: "th-TH",
    });
    const page = await context.newPage();

    let financialData: FinancialDataItem[] = [];
    let tradingData: TradingStatItem[] = [];

    // ดัก API responses
    page.on("response", async (res) => {
      const url = res.url();
      try {
        if (url.includes("/company-highlight/financial-data")) {
          financialData = await res.json() as FinancialDataItem[];
        }
        if (url.includes("/company-highlight/trading-stat")) {
          tradingData = await res.json() as TradingStatItem[];
        }
      } catch { /* ignore parse errors */ }
    });

    try {
      await page.goto(
        `${BASE_URL}/th/market/product/stock/quote/${sym}/financial-statement/company-highlights`,
        { waitUntil: "networkidle", timeout: 30000 }
      );
      await page.waitForTimeout(4000);
    } finally {
      await browser.close();
    }

    // ---- ถ้าได้ข้อมูลจาก API ----
    if (financialData.length > 0) {
      const lines: string[] = [];
      lines.push(`=== งบการเงิน ${sym} (หน่วย: พันบาท → แสดงเป็นล้านบาท) ===\n`);

      // Headers
      const headers = financialData.map(periodLabel);
      lines.push(`${"รายการ".padEnd(36)}${headers.join("    ")}`);
      lines.push("─".repeat(36 + headers.length * 14));

      // งบฐานะการเงิน
      lines.push("\n[งบฐานะการเงิน] (ล้านบาท)");
      const toM = (v: number | null) => v !== null ? v / 1000 : null;
      const rows: Array<[string, (d: FinancialDataItem) => number | null]> = [
        ["สินทรัพย์รวม",        d => toM(d.totalAsset)],
        ["หนี้สินรวม",           d => toM(d.totalLiability)],
        ["ส่วนของผู้ถือหุ้น",    d => toM(d.equity)],
        ["ทุนชำระแล้ว",          d => toM(d.paidupCapital)],
      ];
      for (const [label, fn] of rows) {
        const vals = financialData.map(d => fmt(fn(d))).join("    ");
        lines.push(`  ${label.padEnd(34)}${vals}`);
      }

      // งบกำไรขาดทุน
      lines.push("\n[งบกำไรขาดทุน] (ล้านบาท)");
      const incomeRows: Array<[string, (d: FinancialDataItem) => number | null]> = [
        ["รายได้รวม",                   d => toM(d.totalRevenue)],
        ["EBIT",                        d => toM(d.ebit)],
        ["กำไรสุทธิ",                   d => toM(d.netProfit)],
        ["กำไรต่อหุ้น (EPS) (บาท)",     d => d.eps],
      ];
      for (const [label, fn] of incomeRows) {
        const vals = financialData.map(d => {
          const v = fn(d);
          return label.includes("EPS") ? fmt(v, 2) : fmt(v);
        }).join("    ");
        lines.push(`  ${label.padEnd(34)}${vals}`);
      }

      // กระแสเงินสด
      lines.push("\n[กระแสเงินสด] (ล้านบาท)");
      const cfRows: Array<[string, (d: FinancialDataItem) => number | null]> = [
        ["กระแสเงินสดจากดำเนินงาน", d => toM(d.netOperating)],
      ];
      for (const [label, fn] of cfRows) {
        const vals = financialData.map(d => fmt(fn(d))).join("    ");
        lines.push(`  ${label.padEnd(34)}${vals}`);
      }

      // อัตราส่วนทางการเงิน
      lines.push("\n[อัตราส่วนทางการเงิน] (%)");
      const ratioRows: Array<[string, (d: FinancialDataItem) => number | null]> = [
        ["ROA (%)",             d => d.roa],
        ["ROE (%)",             d => d.roe],
        ["Net Profit Margin (%)", d => d.netProfitMargin],
        ["Gross Profit Margin (%)", d => d.grossProfitMargin],
        ["D/E Ratio",           d => d.deRatio],
      ];
      for (const [label, fn] of ratioRows) {
        const vals = financialData.map(d => fmt(fn(d))).join("    ");
        lines.push(`  ${label.padEnd(34)}${vals}`);
      }

      // ค่าสถิติสำคัญจาก trading-stat
      if (tradingData.length > 0) {
        lines.push("\n[ค่าสถิติสำคัญ ณ สิ้นปี]");
        const trHeaders = tradingData.map(d => d.period);
        lines.push(`${"รายการ".padEnd(36)}${trHeaders.join("    ")}`);
        lines.push("─".repeat(36 + trHeaders.length * 14));

        const statRows: Array<[string, (d: TradingStatItem) => number | null]> = [
          ["ราคาปิด (บาท)",              d => d.close],
          ["P/E (เท่า)",                 d => d.pe],
          ["P/BV (เท่า)",                d => d.pbv],
          ["Book Value/Share (บาท)",     d => d.bookValuePerShare],
          ["Market Cap (ล้านบาท)",       d => d.marketCap !== null ? d.marketCap / 1_000_000 : null],
          ["Dividend Yield (%)",         d => d.dividendYield],
          ["Beta",                       d => d.beta],
        ];
        for (const [label, fn] of statRows) {
          const vals = tradingData.map(d => fmt(fn(d))).join("    ");
          lines.push(`  ${label.padEnd(34)}${vals}`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    // ---- Fallback: table scraping ----
    const fallbackBrowser = await chromium.launch({ headless: true });
    const fallbackCtx = await fallbackBrowser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
      locale: "th-TH",
    });
    const fallbackPage = await fallbackCtx.newPage();
    try {
      await fallbackPage.goto(
        `${BASE_URL}/th/market/product/stock/quote/${sym}/financial-statement/company-highlights`,
        { waitUntil: "networkidle", timeout: 30000 }
      );
      await fallbackPage.waitForTimeout(5000);

      const tableText = await fallbackPage.evaluate(() => {
        const out: string[] = [];
        document.querySelectorAll("table").forEach((table) => {
          const rows: string[] = [];
          table.querySelectorAll("tr").forEach(tr => {
            const cells: string[] = [];
            tr.querySelectorAll("th, td").forEach(cell => {
              cells.push((cell as HTMLElement).innerText.trim().replace(/\s+/g, " "));
            });
            if (cells.some(c => c.length > 0)) rows.push(cells.join(" | "));
          });
          if (rows.length > 1) out.push(rows.join("\n"));
        });
        return out.join("\n\n");
      });

      return {
        content: [{ type: "text", text: `=== งบการเงิน ${sym} ===\n\n${tableText}` }],
      };
    } finally {
      await fallbackBrowser.close();
    }
  }

  // 7. Major Shareholders
  if (name === "get_shareholders") {
    const { symbol } = args as { symbol: string };
    const sym = symbol.toUpperCase().trim();

    interface Shareholder {
      sequence: number;
      name: string;
      nationality: string | null;
      numberOfShare: number;
      percentOfShare: number;
      isThaiNVDR: boolean;
    }

    interface ShareholderApiResponse {
      symbol: string;
      bookCloseDate: string;
      caType: string;
      totalShareholder: number;
      percentScriptless: number;
      majorShareholders: Shareholder[];
      freeFloat: {
        numberOfFreeFloat?: number;
        percentFreeFloat?: number;
        [key: string]: unknown;
      } | null;
    }

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
      locale: "th-TH",
    });
    const page = await context.newPage();

    let shareholderData: ShareholderApiResponse | null = null;
    let nvdrData: ShareholderApiResponse | null = null;

    page.on("response", async (res) => {
      const u = res.url();
      try {
        if (u.includes(`/stock/${sym}/shareholder`)) {
          shareholderData = await res.json() as ShareholderApiResponse;
        }
        if (u.includes(`/stock/${sym}/nvdr-holder`)) {
          nvdrData = await res.json() as ShareholderApiResponse;
        }
      } catch { /* ignore */ }
    });

    try {
      await page.goto(
        `${BASE_URL}/th/market/product/stock/quote/${sym}/major-shareholders`,
        { waitUntil: "networkidle", timeout: 30000 }
      );
      await page.waitForTimeout(4000);
    } finally {
      await browser.close();
    }

    // fallback: ถ้า API ไม่ได้รับข้อมูล
    if (!shareholderData) {
      return {
        content: [{ type: "text", text: `=== ผู้ถือหุ้น ${sym} ===\n\nไม่สามารถดึงข้อมูลได้` }],
        isError: true,
      };
    }

    const d = shareholderData as ShareholderApiResponse;
    const fmtNum = (n: number) => n.toLocaleString("th-TH");
    const fmtPct = (n: number) => n.toFixed(2);

    // แปลงวันที่ bookCloseDate
    const bookDate = d.bookCloseDate
      ? new Date(d.bookCloseDate).toLocaleDateString("th-TH", {
          timeZone: "Asia/Bangkok",
          year: "numeric", month: "long", day: "numeric",
        })
      : "-";

    const lines: string[] = [];
    lines.push(`=== ข้อมูลผู้ถือหุ้น ${sym} ===`);
    lines.push(`ณ วันปิดสมุดทะเบียน: ${bookDate}  (ประเภท: ${d.caType ?? "-"})\n`);

    // ภาพรวม
    lines.push("── ภาพรวม ──────────────────────────────");
    lines.push(`  จำนวนผู้ถือหุ้นทั้งหมด       ${fmtNum(d.totalShareholder)} ราย`);

    const ff = d.freeFloat as Record<string, unknown> | null;
    if (ff) {
      const ffCount = typeof ff.numberOfFreeFloat === "number" ? fmtNum(ff.numberOfFreeFloat) : "-";
      const ffPct   = typeof ff.percentFreeFloat  === "number" ? fmtPct(ff.percentFreeFloat)  : "-";
      lines.push(`  ผู้ถือหุ้นรายย่อย (Free Float)  ${ffCount} ราย`);
      lines.push(`  %Free Float                    ${ffPct}%`);
    }
    lines.push(`  %การถือหุ้นแบบไร้ใบหุ้น       ${fmtPct(d.percentScriptless)}%`);

    // รายชื่อผู้ถือหุ้นรายใหญ่
    lines.push("\n── ผู้ถือหุ้นรายใหญ่ ──────────────────────────────────────────────────────");
    lines.push(`  ${"ลำดับ".padEnd(6)}${"ชื่อผู้ถือหุ้น".padEnd(52)}${"จำนวนหุ้น".padStart(16)}  ${"% หุ้น".padStart(8)}`);
    lines.push("  " + "─".repeat(86));

    for (const sh of d.majorShareholders) {
      const name = sh.name.length > 50 ? sh.name.substring(0, 48) + "…" : sh.name;
      lines.push(
        `  ${String(sh.sequence).padEnd(6)}${name.padEnd(52)}${fmtNum(sh.numberOfShare).padStart(16)}  ${fmtPct(sh.percentOfShare).padStart(7)}%`
      );
    }

    // NVDR holders (แสดงเสมอถ้ามีข้อมูล)
    const nvdr = nvdrData as ShareholderApiResponse | null;
    if (nvdr && nvdr.majorShareholders?.length > 0) {
      const nvdrBookDate = nvdr.bookCloseDate
        ? new Date(nvdr.bookCloseDate).toLocaleDateString("th-TH", {
            timeZone: "Asia/Bangkok", year: "numeric", month: "long", day: "numeric",
          })
        : "-";
      lines.push(`\n── ผู้ถือ NVDR รายใหญ่  (ณ ${nvdrBookDate}) ──────────────────────────────────`);
      lines.push(`  จำนวนผู้ถือ NVDR ทั้งหมด       ${fmtNum(nvdr.totalShareholder)} ราย`);
      lines.push("");
      lines.push(`  ${"ลำดับ".padEnd(6)}${"ชื่อผู้ถือ NVDR".padEnd(52)}${"จำนวน NVDR".padStart(16)}  ${"% หุ้น".padStart(8)}`);
      lines.push("  " + "─".repeat(86));
      for (const sh of nvdr.majorShareholders) {
        const name = sh.name.length > 50 ? sh.name.substring(0, 48) + "…" : sh.name;
        lines.push(
          `  ${String(sh.sequence).padEnd(6)}${name.padEnd(52)}${fmtNum(sh.numberOfShare).padStart(16)}  ${fmtPct(sh.percentOfShare).padStart(7)}%`
        );
      }
    }

    lines.push("\n─────────────────────────────────────────────────────────────────────────────");
    lines.push("หมายเหตุ: SET เปิดเผยเฉพาะผู้ถือหุ้น 10 รายแรก + ผู้ถือ ≥ 0.5% ของทุนชำระแล้ว");
    lines.push("          ไม่สามารถดูรายชื่อผู้ถือหุ้นรายย่อยทั้งหมดได้จากช่องทางนี้");

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // 8. F45 Quarterly Announcement Content
  if (name === "get_f45_content") {
    const { symbol, quarter, year: yearBE } = args as {
      symbol: string;
      quarter?: number;
      year?: number;
    };
    const sym = symbol.toUpperCase().trim();

    interface F45NewsItem {
      id: string;
      datetime: string;
      symbol: string;
      source: string;
      headline: string;
      url?: string;
      percentPriceChange?: number | null;
    }

    // ── Phase 1: ดึงรายการข่าวผ่าน Playwright + intercept /api/cms/v1/news/set ──
    // ใช้ URL กรองตาม symbol + date range → ได้ข่าวของหุ้นนั้นโดยตรง ไม่ต้อง scroll เยอะ
    const fmtSetDate = (d: Date): string => {
      const dd = String(d.getDate()).padStart(2, "0");
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      return `${dd}/${mm}/${d.getFullYear()}`;
    };
    const dateTo   = new Date();
    const dateFrom = new Date();
    dateFrom.setFullYear(dateFrom.getFullYear() - 2); // 2 ปีย้อนหลัง

    const newsList = await withPage(async (page) => {
      const items: F45NewsItem[] = [];
      const seenIds = new Set<string>();

      page.on("response", async (res) => {
        const url = res.url();
        // intercept ทั้ง 2 endpoint (เผื่อหน้า fallback)
        if (url.includes("/api/cms/v1/news/set") || url.includes("/api/set/news/search")) {
          try {
            const json = await res.json() as {
              paginateNews?: { newsInfoList?: F45NewsItem[] };
              newsInfoList?: F45NewsItem[];
            };
            const list =
              json.paginateNews?.newsInfoList ??
              json.newsInfoList ?? [];
            list.forEach(n => {
              // กรองเฉพาะข่าวของ symbol ที่ต้องการ
              if (!seenIds.has(n.id) && n.symbol === sym) {
                seenIds.add(n.id);
                items.push(n);
              }
            });
          } catch { /* ignore */ }
        }
      });

      const newsPageUrl =
        `${BASE_URL}/th/market/news-and-alert/news` +
        `?source=company&symbol=${sym.toLowerCase()}&securityType=S` +
        `&fromDate=${dateFrom.toISOString().split("T")[0]}&toDate=${dateTo.toISOString().split("T")[0]}`;

      await page.goto(newsPageUrl, { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(3000);

      // scroll 2 รอบ เผื่อมีหลายหน้า (ข่าวกรองแล้ว ไม่ต้อง scroll เยอะ)
      for (let i = 0; i < 2; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1200);
      }
      await page.waitForTimeout(500);
      return items;
    });

    // ── กรอง F45 ─────────────────────────────────────────────────────────────
    const isF45 = (n: F45NewsItem) =>
      n.headline?.includes("F45") || n.headline?.includes("สรุปผลการดำเนินงาน");

    // งบประจำปี — บริษัทไม่มีรายงาน Q4 แยก ใช้งบทั้งปีแทน
    const isAnnual = (n: F45NewsItem) =>
      isF45(n) && (n.headline?.includes("ประจำปี") || n.headline?.includes("ประจำงวด"));

    let f45List: F45NewsItem[];
    if (quarter === 4) {
      // Q4: ค้นหางบประจำปี ไม่ใช่ "ไตรมาสที่ 4"
      f45List = newsList.filter(isAnnual);
    } else {
      f45List = newsList.filter(isF45);
      if (quarter) {
        f45List = f45List.filter(n => n.headline?.includes(`ไตรมาสที่ ${quarter}`));
      }
    }
    if (yearBE) {
      const yearCE = yearBE > 2500 ? yearBE - 543 : yearBE;
      f45List = f45List.filter(n => new Date(n.datetime).getFullYear() === yearCE);
    }

    if (f45List.length === 0) {
      return {
        content: [{
          type: "text",
          text: [
            `❌ ไม่พบข่าว F45 ของ ${sym}` +
              (quarter ? ` ไตรมาสที่ ${quarter}` : "") +
              (yearBE ? ` ปี ${yearBE}` : ""),
            `พบข่าวทั้งหมด ${newsList.length} รายการ ตัวอย่าง:`,
            ...newsList.slice(0, 8).map(n => `  • ${n.headline}`),
          ].join("\n"),
        }],
        isError: true,
      };
    }

    const news = f45List[0];

    // ── หาไตรมาสปัจจุบันจาก headline ─────────────────────────────────────────
    const qMatch = news.headline.match(/ไตรมาสที่\s*(\d)/);
    // Q4 = annual report (ไม่มี "ไตรมาสที่ 4" ใน headline) → กำหนด curQ=4 เอง
    const isAnnualReport = quarter === 4 || news.headline.includes("ประจำปี");
    const curQ = isAnnualReport ? 4 : (qMatch ? parseInt(qMatch[1]) : 0);
    const newsYearCE = new Date(news.datetime).getFullYear();
    const newsYearBE = newsYearCE + 543;

    // ไตรมาสก่อนหน้า (QoQ)
    const prevQ = curQ === 1 ? 4 : curQ - 1;
    const prevYearCE = curQ === 1 ? newsYearCE - 1 : newsYearCE;
    const prevYearBE = prevYearCE + 543;

    // หา prevNews ใน newsList ที่โหลดไว้
    let prevNews: F45NewsItem | undefined;
    if (curQ === 4) {
      // QoQ ของ Q4: หา Q3 (9 เดือนสะสม) ที่ยื่น "ก่อน" วันงบประจำปี
      // ไม่ match ด้วยปี เพราะงบประจำปีของ FY2568 ยื่นต้นปี 2569 แต่ Q3/FY2568 ยื่นปลายปี 2568
      const annualDate = new Date(news.datetime);
      prevNews = newsList
        .filter(n =>
          isF45(n) &&
          n.headline?.includes("ไตรมาสที่ 3") &&
          new Date(n.datetime) < annualDate
        )
        .sort((a, b) => new Date(b.datetime).getTime() - new Date(a.datetime).getTime())[0];
    } else if (curQ === 1) {
      // QoQ ของ Q1: เทียบกับงบประจำปีของปีก่อน
      prevNews = newsList.find(n =>
        isAnnual(n) &&
        new Date(n.datetime).getFullYear() === prevYearCE
      );
    } else if (curQ > 1) {
      prevNews = newsList.find(n =>
        isF45(n) &&
        n.headline?.includes(`ไตรมาสที่ ${prevQ}`) &&
        new Date(n.datetime).getFullYear() === prevYearCE
      );
    }

    // ── ฟังก์ชันดึงเนื้อหา news detail ──────────────────────────────────────
    const fetchContent = async (newsItem: F45NewsItem): Promise<{
      bodyText: string;
      pdfLinks: Array<{ href: string; text: string }>;
      iframeSrcs: string[];
      detailUrl: string;
    }> => withPage(async (page) => {
      let iframeContent = "";
      let detailUrl: string;
      if (newsItem.url && newsItem.url.length > 5) {
        detailUrl = newsItem.url.startsWith("http") ? newsItem.url : `${BASE_URL}${newsItem.url}`;
      } else {
        detailUrl = `${BASE_URL}/th/market/news-and-alert/news/detail/${newsItem.id}`;
      }

      await page.goto(detailUrl, { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(4000);

      const extracted = await page.evaluate(() => {
        const pdfs = Array.from(document.querySelectorAll("a"))
          .filter(a => a.href && (a.href.includes(".pdf") || a.href.includes("/dat/")))
          .map(a => ({ href: a.href, text: (a.textContent ?? "").trim() }));
        const iframes = Array.from(document.querySelectorAll("iframe"))
          .map(f => f.src || f.getAttribute("data-src") || "")
          .filter(Boolean) as string[];
        return { pdfs, iframes };
      });

      const contentIframe = extracted.iframes.find(s =>
        s.includes("sec.or.th") || s.includes("iDisc") || s.includes("setlink") ||
        s.includes("set.or.th")
      );
      if (contentIframe && !contentIframe.toLowerCase().endsWith(".pdf")) {
        try {
          await page.goto(contentIframe, { waitUntil: "networkidle", timeout: 25000 });
          await page.waitForTimeout(3000);
          iframeContent = await page.evaluate(() => document.body.innerText);
        } catch { /* ignore */ }
      }

      const pageText = await page.evaluate(() => document.body.innerText);
      return {
        bodyText: iframeContent || pageText,
        pdfLinks: extracted.pdfs,
        iframeSrcs: extracted.iframes,
        detailUrl,
      };
    });

    // ── Phase 2: ดึงเนื้อหา F45 ปัจจุบัน ─────────────────────────────────────
    const detail = await fetchContent(news);

    // ── Phase 3: ดึงเนื้อหา F45 ไตรมาสก่อน (QoQ) ────────────────────────────
    let prevDetail: { bodyText: string } | null = null;
    if (prevNews) {
      prevDetail = await fetchContent(prevNews);
    }

    // ── Parse ตัวเลข ──────────────────────────────────────────────────────────
    const curData = parseF45Data(detail.bodyText);

    // สำหรับ Q4: prevData = Q3 (9 เดือนสะสม) — ใช้ parseF45CumulativeNM(9)
    // สำหรับ Q1: prevData = annual ปีก่อน (12 เดือน)
    // สำหรับ Q2/Q3: prevData = ไตรมาสก่อน (3 เดือน standalone)
    const prevData = prevDetail
      ? (curQ === 4
          ? parseF45CumulativeNM(prevDetail.bodyText, 9)   // Q3 9-month cumulative
          : parseF45Data(prevDetail.bodyText))
      : null;

    // กำไร Q4 standalone = annual(12mo) − Q3(9mo)
    const q4Profit      = (isAnnualReport && prevData?.profit      != null && curData.profit      != null)
      ? curData.profit      - prevData.profit      : null;
    const q4PriorProfit = (isAnnualReport && prevData?.priorProfit != null && curData.priorProfit != null)
      ? curData.priorProfit - prevData.priorProfit : null;
    const q4Eps         = (isAnnualReport && prevData?.eps         != null && curData.eps         != null)
      ? curData.eps         - prevData.eps         : null;
    const q4PriorEps    = (isAnnualReport && prevData?.priorEps    != null && curData.priorEps    != null)
      ? curData.priorEps    - prevData.priorEps    : null;

    // ── helper format ─────────────────────────────────────────────────────────
    const dt = new Date(news.datetime).toLocaleString("th-TH", {
      timeZone: "Asia/Bangkok", year: "numeric", month: "long",
      day: "numeric", hour: "2-digit", minute: "2-digit",
    });
    const fmtN = (v: number | null, dec = 0): string => {
      if (v === null) return "N/A";
      return v.toLocaleString("th-TH", { minimumFractionDigits: dec, maximumFractionDigits: dec });
    };
    const fmtChg = (cur: number | null, base: number | null): string => {
      if (cur === null || base === null || base === 0) return "N/A";
      const pct = ((cur - base) / Math.abs(base)) * 100;
      return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
    };

    // ── สร้าง output ──────────────────────────────────────────────────────────
    const out: string[] = [];
    out.push(`=== F45: ${news.headline} ===`);
    out.push(`หุ้น: ${sym}   วันที่ประกาศ: ${dt}`);
    out.push(`URL: ${detail.detailUrl}`);
    out.push("─".repeat(70));

    // ตารางเปรียบเทียบ
    if (curQ > 0 && (curData.profit !== null || curData.eps !== null)) {
      out.push("\n[เปรียบเทียบผลประกอบการ]");

      if (isAnnualReport) {
        // ── Q4 standalone = Annual − Q3(9เดือน) ──────────────────────────────
        out.push("\n  กำไรสุทธิ (พันบาท)");
        out.push(`    งบทั้งปี ${newsYearBE}  (12 เดือน) : ${fmtN(curData.profit)}`);
        if (prevData !== null) {
          out.push(`    Q3/${newsYearBE}       (9 เดือนสะสม) : ${fmtN(prevData.profit)}`);
          out.push(`    Q4/${newsYearBE}       (คำนวณ)    : ${fmtN(q4Profit)}` +
            (q4Profit !== null && prevData.profit !== null
              ? `   QoQ vs Q3: ${fmtChg(q4Profit, prevData.profit)}`
              : ""));
        } else {
          out.push(`    Q3/${newsYearBE}       (9 เดือนสะสม) : N/A  (ไม่พบข่าว Q3/${newsYearBE} ใน ${newsList.length} รายการที่โหลด)`);
          out.push(`    Q4/${newsYearBE}       (คำนวณ)    : N/A`);
        }
        if (curData.priorProfit !== null) {
          out.push(`    งบทั้งปี ${newsYearBE - 1}  (YoY ทั้งปี) : ${fmtN(curData.priorProfit)}   YoY: ${fmtChg(curData.profit, curData.priorProfit)}`);
        }
        if (q4PriorProfit !== null) {
          out.push(`    Q4/${newsYearBE - 1}       (YoY Q4)   : ${fmtN(q4PriorProfit)}   YoY: ${fmtChg(q4Profit, q4PriorProfit)}`);
        }

        out.push("\n  EPS (บาทต่อหุ้น)");
        out.push(`    งบทั้งปี ${newsYearBE}  (12 เดือน) : ${fmtN(curData.eps, 4)}`);
        if (prevData !== null) {
          out.push(`    Q3/${newsYearBE}       (9 เดือนสะสม) : ${fmtN(prevData.eps, 4)}`);
          out.push(`    Q4/${newsYearBE}       (คำนวณ)    : ${fmtN(q4Eps, 4)}`);
        }
        if (curData.priorEps !== null) {
          out.push(`    งบทั้งปี ${newsYearBE - 1}  (YoY ทั้งปี) : ${fmtN(curData.priorEps, 4)}   YoY: ${fmtChg(curData.eps, curData.priorEps)}`);
        }
        if (q4PriorEps !== null) {
          out.push(`    Q4/${newsYearBE - 1}       (YoY Q4)   : ${fmtN(q4PriorEps, 4)}   YoY: ${fmtChg(q4Eps, q4PriorEps)}`);
        }
      } else {
        // ── Q1/Q2/Q3 ────────────────────────────────────────────────────────
        out.push("\n  กำไรสุทธิ (พันบาท)");
        out.push(`    Q${curQ}/${newsYearBE}  (ปัจจุบัน) : ${fmtN(curData.profit)}`);
        if (prevData !== null) {
          const prevLabel = curQ === 1 ? `งบทั้งปี ${prevYearBE}` : `Q${prevQ}/${prevYearBE}`;
          out.push(`    ${prevLabel}  (QoQ)      : ${fmtN(prevData.profit)}   QoQ: ${fmtChg(curData.profit, prevData.profit)}`);
        } else {
          const prevLabel = curQ === 1 ? `งบทั้งปี ${prevYearBE}` : `Q${prevQ}/${prevYearBE}`;
          out.push(`    ${prevLabel}  (QoQ)      : N/A  (ไม่พบใน ${newsList.length} รายการที่โหลด)`);
        }
        if (curData.priorProfit !== null) {
          out.push(`    Q${curQ}/${newsYearBE - 1}  (YoY)      : ${fmtN(curData.priorProfit)}   YoY: ${fmtChg(curData.profit, curData.priorProfit)}`);
        }

        out.push("\n  EPS (บาทต่อหุ้น)");
        out.push(`    Q${curQ}/${newsYearBE}  (ปัจจุบัน) : ${fmtN(curData.eps, 4)}`);
        if (prevData !== null) {
          const prevLabel = curQ === 1 ? `งบทั้งปี ${prevYearBE}` : `Q${prevQ}/${prevYearBE}`;
          out.push(`    ${prevLabel}  (QoQ)      : ${fmtN(prevData.eps, 4)}   QoQ: ${fmtChg(curData.eps, prevData.eps)}`);
        } else {
          out.push(`    Q${prevQ}/${prevYearBE}  (QoQ)      : N/A`);
        }
        if (curData.priorEps !== null) {
          out.push(`    Q${curQ}/${newsYearBE - 1}  (YoY)      : ${fmtN(curData.priorEps, 4)}   YoY: ${fmtChg(curData.eps, curData.priorEps)}`);
        }
      }
      out.push("");
    }

    // เนื้อหา F45
    const contentLines = detail.bodyText
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .slice(0, 300)
      .join("\n");

    if (contentLines.length > 50) {
      out.push("\n[เนื้อหาเอกสาร F45]");
      out.push(contentLines);
    }

    if (detail.pdfLinks.length > 0) {
      out.push("\n[ลิงก์เอกสาร PDF]");
      detail.pdfLinks.forEach(l => out.push(`  📄 ${l.text || "PDF"}: ${l.href}`));
    }

    if (detail.iframeSrcs.length > 0) {
      out.push("\n[แหล่งเอกสาร (iframe src)]");
      detail.iframeSrcs.forEach(s => out.push(`  🔗 ${s}`));
    }

    return {
      content: [{ type: "text", text: out.join("\n") }],
    };
  }

  return {
    content: [{ type: "text", text: `ไม่รู้จัก tool: ${name}` }],
    isError: true,
  };
});

// ---- Start ----

const transport = new StdioServerTransport();
await server.connect(transport);
