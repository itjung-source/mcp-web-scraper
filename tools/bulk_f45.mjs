import { chromium } from "playwright";
import fs from "fs";

// ── CLI ────────────────────────────────────────────────────────────────────
//   node bulk_f45.mjs --date 13/08/2026 [--from 18:00] [--to 23:59]
//                     [--only syms.txt] [--out result.txt]
//
//   --only  ไฟล์รายชื่อหุ้น 1 ตัว/บรรทัด (คอลัมน์แรก คั่นด้วย tab ได้)
//           ใช้ตอนอยากข้ามตัวที่มีใน DB แล้ว — ถ้าไม่ใส่จะดึง F45 ทุกตัวในช่วงเวลา
//   output  SYMBOL|กำไรล้านบาท|เวลา|yoy|qoq|is_reit|ไตรมาส  (ป้อน save_f45.py ได้ตรง)
const BASE_URL = "https://www.set.or.th";
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

const DATE = arg("--date");
if (!DATE || !/^\d{2}\/\d{2}\/\d{4}$/.test(DATE)) {
  console.error("usage: node bulk_f45.mjs --date DD/MM/YYYY [--from HH:MM] [--to HH:MM] [--only syms.txt] [--out file]");
  process.exit(1);
}
const T_FROM = arg("--from", "00:00");
const T_TO = arg("--to", "23:59");
const OUT = arg("--out", "f45_out.txt");
const onlyFile = arg("--only");
const WANT = onlyFile
  ? new Set(fs.readFileSync(onlyFile, "utf8").split("\n").map(l => l.split("\t")[0].trim()).filter(Boolean))
  : null;

// SET API คืนข่าวตามช่วงวัน — ขอย้อนไป 1 วันเผื่อ timezone แล้วกรองวันเป๊ะ ๆ เอง
const [dd, mm, yyyy] = DATE.split("/").map(Number);
const prev = new Date(Date.UTC(yyyy, mm - 1, dd - 1));
const API_FROM = `${String(prev.getUTCDate()).padStart(2, "0")}/${String(prev.getUTCMonth() + 1).padStart(2, "0")}/${prev.getUTCFullYear()}`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  locale: "th-TH",
});
const seed = await context.newPage();
let apiHeaders = {};
seed.on("request", (req) => {
  if (req.url().includes("/api/cms/v1/news/set") && !apiHeaders["x-client-uuid"]) {
    const h = req.headers();
    apiHeaders = {
      "x-client-uuid": h["x-client-uuid"] ?? "", "x-channel": h["x-channel"] ?? "WEB_SET",
      "referer": `${BASE_URL}/th/market/news-and-alert/news`,
      "accept": "application/json, text/plain, */*",
      "accept-language": h["accept-language"] ?? "th-TH", "user-agent": h["user-agent"] ?? "",
    };
  }
});
await seed.goto(`${BASE_URL}/th/market/news-and-alert/news`, { waitUntil: "networkidle", timeout: 60000 });
await seed.waitForTimeout(3000);

const q = new URLSearchParams({
  fromDate: API_FROM, toDate: DATE, perPage: "2000",
  orderBy: "date", lang: "th", sourceId: "company", securityTypeIds: "S",
});
const res = await context.request.get(`${BASE_URL}/api/cms/v1/news/set?${q}`, { headers: apiHeaders });
const j = await res.json();
const all = (j?.paginateNews ?? j?.newsGroups?.[0])?.newsInfoList ?? [];
const bkkDate = (iso) => new Date(iso).toLocaleDateString("en-GB", { timeZone: "Asia/Bangkok" });
const bkkTime = (iso) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok" });

const targets = all.filter(n => {
  if (bkkDate(n.datetime) !== DATE) return false;
  const t = bkkTime(n.datetime).slice(0, 5);
  if (t < T_FROM || t > T_TO) return false;
  const h = n.headline ?? "";
  if (!h.includes("สรุปผลการดำเนินงาน") || !h.includes("(F45)")) return false;
  return WANT ? WANT.has(n.symbol) : true;
});
// keep latest filing per symbol
const bySym = new Map();
for (const n of targets) {
  const prev = bySym.get(n.symbol);
  if (!prev || new Date(n.datetime) > new Date(prev.datetime)) bySym.set(n.symbol, n);
}
const jobs = [...bySym.values()];
console.error(`JOBS ${jobs.length}  (${DATE} ${T_FROM}-${T_TO}${WANT ? `, ขอมา ${WANT.size} ตัว` : ""})`);
if (WANT) console.error(`MISSING_NEWS ${[...WANT].filter(s => !bySym.has(s)).join(",") || "-"}`);

const parseNum = (s) => {
  if (!s) return null;
  const t = s.trim();
  const neg = t.startsWith("(");
  const c = t.replace(/[(),\s]/g, "");
  if (!c) return null;
  const n = parseFloat(c);
  return isNaN(n) ? null : (neg ? -n : n);
};

function parseDoc(text, headline) {
  const lines = text.split("\n");
  let profit = null, prior = null, cum = null, cumPrior = null, ncol = 0;
  let isReit = 0, yearBE = null, qNum = null;

  for (const line of lines) {
    // กองทุน/REIT: วลี "ในสินทรัพย์สุทธิ จากการดำเนินงาน" ถูกตัดขึ้นบรรทัดใหม่ในบางฟอร์ม
    // จึงเช็คแค่ "สินทรัพย์สุทธิ" พอ
    if (/สินทรัพย์สุทธิ/.test(line)) isReit = 1;
    if (yearBE === null && /^\s*ปี\b/.test(line)) {
      const ys = line.match(/25\d{2}/g);
      if (ys) yearBE = parseInt(ys[0]);
    }
  }
  if (yearBE === null) {
    const ys = text.match(/25\d{2}\s+25\d{2}/);
    if (ys) yearBE = parseInt(ys[0].split(/\s+/)[0]);
  }
  const qm = headline.match(/ไตรมาสที่\s*(\d)/);
  if (qm) qNum = parseInt(qm[1]);
  else if (/งวดครึ่งปี|ครึ่งปี|หกเดือน|งวด\s*6\s*เดือน/.test(headline)) qNum = 2;
  else if (/เก้าเดือน|งวด\s*9\s*เดือน/.test(headline)) qNum = 3;

  let cnt = 0;
  for (const line of lines) {
    // บรรทัดตัวเลข: หุ้นทั่วไป = "กำไร (ขาดทุน)" / กองทุน-REIT = "การเพิ่มขึ้น (ลดลง)"
    const key = (line.includes("กำไร") && line.includes("ขาดทุน")) ||
      (isReit && /การเพิ่มขึ้น/.test(line) && /ลดลง/.test(line));
    if (!key) continue;
    const nums = line.match(/(\([\d,]+(?:\.\d+)?\)|[\d,]+(?:\.\d+)?)/g) ?? [];
    if (nums.length < 2) continue;
    cnt++;
    if (cnt > 1) break;
    ncol = nums.length;
    if (nums.length >= 4) {
      profit = parseNum(nums[0]); prior = parseNum(nums[1]);
      cum = parseNum(nums[2]); cumPrior = parseNum(nums[3]);
    } else {
      profit = parseNum(nums[nums.length - 2]); prior = parseNum(nums[nums.length - 1]);
    }
  }
  return { profit, prior, cum, cumPrior, ncol, isReit, yearBE, qNum };
}

async function grab(page, n) {
  const url = n.url && n.url.length > 5
    ? (n.url.startsWith("http") ? n.url : BASE_URL + n.url)
    : `${BASE_URL}/th/market/news-and-alert/news/detail/${n.id}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2500);
  const iframes = await page.evaluate(() =>
    Array.from(document.querySelectorAll("iframe")).map(f => f.src || f.getAttribute("data-src") || "").filter(Boolean));
  const src = iframes.find(s => /sec\.or\.th|iDisc|setlink|set\.or\.th/.test(s) && !s.toLowerCase().endsWith(".pdf"));
  let txt = "";
  if (src) {
    try {
      await page.goto(src, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(1500);
      txt = await page.evaluate(() => document.body.innerText);
    } catch { /* ignore */ }
  }
  if (!txt) txt = await page.evaluate(() => document.body.innerText).catch(() => "");
  return txt;
}

const CONC = 5;
const results = [];
const fails = [];
let done = 0;
const queue = jobs.slice();

async function worker(id) {
  const page = await context.newPage();
  while (queue.length) {
    const n = queue.shift();
    try {
      const txt = await grab(page, n);
      const d = parseDoc(txt, n.headline ?? "");
      if (d.profit === null) { fails.push(`${n.symbol}:noparse`); }
      else {
        const pM = d.profit / 1000;
        const yoy = (d.prior !== null && d.prior !== 0) ? ((d.profit - d.prior) / Math.abs(d.prior) * 100) : null;
        let qoq = null;
        if (d.qNum === 2 && d.cum !== null) {
          const q1 = d.cum - d.profit;
          if (q1 !== 0) qoq = (d.profit - q1) / Math.abs(q1) * 100;
        }
        results.push([
          n.symbol, pM.toFixed(3), bkkTime(n.datetime).slice(0, 5),
          yoy === null ? "NA" : yoy.toFixed(1),
          qoq === null ? "NA" : qoq.toFixed(1),
          d.isReit, `Q${d.qNum ?? "?"}/${d.yearBE ?? "?"}`,
        ].join("|"));
      }
    } catch (e) {
      fails.push(`${n.symbol}:${String(e.message ?? e).slice(0, 40)}`);
    }
    done++;
    if (done % 10 === 0) console.error(`PROGRESS ${done}/${jobs.length}`);
    fs.writeFileSync(OUT, results.join("\n") + "\n");
  }
  await page.close();
}

await Promise.all(Array.from({ length: CONC }, (_, i) => worker(i)));
fs.writeFileSync(OUT, results.join("\n") + "\n");
console.error(`DONE ok=${results.length} fail=${fails.length}`);
console.error(`FAILS ${fails.join(", ")}`);
await browser.close();
