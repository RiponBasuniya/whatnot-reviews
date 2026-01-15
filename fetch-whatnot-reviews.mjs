import { chromium } from "playwright";
import fs from "fs/promises";

const TARGET_URL = "https://www.whatnot.com/user/collectingfever/reviews";
const OUTPUT_FILE = "whatnot-reviews.json";

// তোমার requirement
const LIMIT = 6;

// helper
const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

async function clickIfExists(page, role, nameRegex) {
  try {
    const el = page.getByRole(role, { name: nameRegex });
    if ((await el.count()) > 0) {
      await el.first().click({ timeout: 1500 });
      return true;
    }
  } catch {}
  return false;
}

async function dismissPopups(page) {
  // Whatnot মাঝে মাঝে app banner / overlay দেখায়
  await clickIfExists(page, "button", /not now/i);
  await clickIfExists(page, "button", /no thanks/i);
  await clickIfExists(page, "button", /close/i);

  // “Continue in app” / “Open App” থাকলে ignore (সবসময় close থাকে না)
  // তাই এখানে শুধু best-effort
}

async function scrollToLoad(page) {
  // reviews lazy-load হতে পারে, তাই কয়েকবার scroll
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(900);
  }
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
    viewport: { width: 1280, height: 900 },
  });

  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1500);
  await dismissPopups(page);

  // reviews page হলেও safe
  await scrollToLoad(page);

  // --- Extract rendered reviews from DOM (best-effort) ---
  const reviews = await page.evaluate((limit) => {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

    // Helper: is header/summary noise?
    const isNoise = (t) =>
      /following|followers|sold|whatnot|become a seller|log in|sign up/i.test(t);

    // Helper: contains rating like 5.0 / 4.9
    const getRating = (t) => {
      const m = t.match(/\b([0-5]\.\d)\b/);
      return m ? parseFloat(m[1]) : null;
    };

    // Helper: contains date like 11/11/2025
    const hasDate = (t) => /\b\d{1,2}\/\d{1,2}\/\d{4}\b/.test(t);

    // Helper: probable username at start
    const getReviewer = (t) => {
      const m = t.match(/^\s*([a-z0-9_]{3,25})\b/i);
      return m ? m[1] : null;
    };

    // 1) Try to locate review cards via “See more” anchors/buttons
    const seeMoreEls = Array.from(document.querySelectorAll("a,button")).filter((el) =>
      /see more/i.test(clean(el.textContent))
    );

    const candidateCards = [];

    for (const el of seeMoreEls) {
      let p = el.parentElement;
      for (let i = 0; i < 10 && p; i++) {
        const t = clean(p.textContent);
        const rating = getRating(t);
        if (rating !== null && !isNoise(t) && t.length > 40 && t.length < 900) {
          candidateCards.push(p);
          break;
        }
        p = p.parentElement;
      }
    }

    // 2) Fallback: find compact blocks containing (rating + date) OR (rating + see more)
    if (candidateCards.length === 0) {
      const blocks = Array.from(document.querySelectorAll("div"))
        .map((el) => ({ el, t: clean(el.textContent) }))
        .filter((x) => x.t.length > 40 && x.t.length < 650);

      for (const b of blocks) {
        const t = b.t;
        const rating = getRating(t);
        if (rating === null) continue;
        if (isNoise(t)) continue;

        // likely review if contains date or "see more"
        if (hasDate(t) || /see more/i.test(t)) {
          candidateCards.push(b.el);
        }

        if (candidateCards.length > 60) break;
      }
    }

    // 3) Parse candidateCards -> {reviewer, rating, text}
    const out = [];

    for (const card of candidateCards) {
      const raw = clean(card.textContent);

      if (isNoise(raw)) continue;

      const rating = getRating(raw);
      if (rating === null) continue;

      const reviewer = getReviewer(raw);
      if (!reviewer) continue;

      // Remove "See more"
      let body = raw.replace(/see more/gi, "").trim();

      // Remove reviewer from start
      body = body.replace(new RegExp("^" + reviewer + "\\s*", "i"), "").trim();

      // Remove date (if present) from start
      body = body.replace(/^\b\d{1,2}\/\d{1,2}\/\d{4}\b\s*/i, "").trim();

      // Remove rating token if it appears near start
      body = body.replace(/^\b[0-5]\.\d\b\s*/i, "").trim();

      // If body is still mostly meta, skip
      if (body.length < 10) continue;

      // Avoid capturing summary line like: "4.9 (28 Reviews) • 251 Sold ..."
      if (/reviews\)\s*•\s*\d+\s*sold/i.test(body)) continue;

      out.push({
        reviewer,
        rating,
        text: body,
      });

      if (out.length >= limit * 3) break; // collect extra for dedupe
    }

    // 4) Dedupe by reviewer+text
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
      rating: typeof r.rating === "number" ? r.rating : 5.0,
      text: clean(r.text),
    })),
  };

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Saved ${OUTPUT_FILE} with ${payload.count} reviews`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
