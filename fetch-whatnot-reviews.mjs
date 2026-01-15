import { chromium } from "playwright";
import fs from "fs/promises";

const TARGET_URL = "https://www.whatnot.com/user/collectingfever/reviews";
const OUTPUT_FILE = "whatnot-reviews.json";
const LIMIT = 6;

function clean(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

async function tryClickByText(page, textRegex) {
  try {
    const btn = page.getByRole("button", { name: textRegex });
    const n = await btn.count();
    if (n > 0) await btn.first().click({ timeout: 1500 });
  } catch {}
}

async function dismissPopups(page) {
  await tryClickByText(page, /not now/i);
  await tryClickByText(page, /no thanks/i);
  await tryClickByText(page, /close/i);
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
    viewport: { width: 1280, height: 900 }
  });

  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1500);
  await dismissPopups(page);

  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(900);
  }

  const reviews = await page.evaluate((limit) => {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

    const all = Array.from(document.querySelectorAll("section,div"));
    let root = document.body;

    for (const el of all) {
      const t = clean(el.textContent);
      if (/reviews\s*\(\d+\)/i.test(t)) {
        root = el;
        break;
      }
    }

    const blocks = Array.from(root.querySelectorAll("div"))
      .map((el) => ({ t: clean(el.textContent) }))
      .filter((x) => x.t.length > 20 && x.t.length < 900);

    const out = [];

    for (const b of blocks) {
      const t = b.t;

      const ratingMatch = t.match(/\b([0-5]\.\d)\b/);
      if (!ratingMatch) continue;

      const reviewerMatch = t.match(/\b[a-z0-9_]{3,20}\b/i);
      if (!reviewerMatch) continue;

      const idx = t.toLowerCase().indexOf("see more");
      const text = idx > 0 ? t.slice(0, idx) : t;

      if (text.split(" ").length < 5) continue;

      out.push({
        reviewer: reviewerMatch[0],
        rating: parseFloat(ratingMatch[1]),
        text
      });

      if (out.length >= limit * 3) break;
    }

    const seen = new Set();
    const uniq = [];
    for (const r of out) {
      const key = `${r.reviewer}|${r.rating}|${r.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(r);
      if (uniq.length >= limit) break;
    }

    return uniq.slice(0, limit);
  }, LIMIT);

  await browser.close();

  const payload = {
    source: "whatnot",
    profile_url: TARGET_URL,
    fetched_at: new Date().toISOString(),
    count: reviews.length,
    reviews: reviews.map((r) => ({
      reviewer: clean(r.reviewer),
      rating: r.rating ?? 5.0,
      text: clean(r.text)
    }))
  };

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Saved ${OUTPUT_FILE} with ${payload.count} reviews`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
