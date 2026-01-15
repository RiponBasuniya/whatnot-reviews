import { chromium } from "playwright";
import fs from "fs/promises";

const TARGET_URL = "https://www.whatnot.com/user/collectingfever/reviews";
const OUTPUT_FILE = "whatnot-reviews.json";
const LIMIT = 6;

const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

function isObject(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

// Recursively search JSON for arrays of "review-like" objects
function findReviewItemsDeep(node, found = []) {
  if (!node) return found;

  if (Array.isArray(node)) {
    // If this array looks like reviews, collect
    // Heuristics: objects with rating + text/message/comment + username/buyer
    const maybe = [];
    for (const item of node) {
      if (!isObject(item)) continue;

      const keys = Object.keys(item).map((k) => k.toLowerCase());

      const hasRating =
        keys.includes("rating") ||
        keys.includes("stars") ||
        keys.includes("score") ||
        keys.some((k) => k.includes("rating"));

      const hasText =
        keys.includes("text") ||
        keys.includes("message") ||
        keys.includes("comment") ||
        keys.includes("review") ||
        keys.some((k) => k.includes("comment") || k.includes("message") || k.includes("text"));

      const hasUser =
        keys.includes("username") ||
        keys.includes("reviewer") ||
        keys.includes("buyer") ||
        keys.includes("user") ||
        keys.some((k) => k.includes("user") || k.includes("buyer"));

      if (hasRating && hasText && hasUser) {
        maybe.push(item);
      }
    }

    if (maybe.length >= 1) {
      found.push(...maybe);
    }

    // Continue traversal
    for (const item of node) findReviewItemsDeep(item, found);
    return found;
  }

  if (isObject(node)) {
    for (const v of Object.values(node)) findReviewItemsDeep(v, found);
  }

  return found;
}

function normalizeReview(item) {
  // Try to map unknown shapes to {reviewer, rating, text}
  const get = (obj, keys) => {
    for (const k of keys) {
      if (obj && obj[k] != null) return obj[k];
    }
    return null;
  };

  // rating
  let rating =
    get(item, ["rating", "stars", "score"]) ??
    get(item, ["starRating", "star_rating", "reviewRating"]);
  if (typeof rating === "string") rating = parseFloat(rating);
  if (typeof rating !== "number" || Number.isNaN(rating)) rating = null;

  // reviewer/username
  let reviewer =
    get(item, ["reviewer", "username"]) ??
    (isObject(item.user) ? get(item.user, ["username", "name", "handle"]) : null) ??
    (isObject(item.buyer) ? get(item.buyer, ["username", "name", "handle"]) : null) ??
    (isObject(item.reviewer) ? get(item.reviewer, ["username", "name", "handle"]) : null);

  // text/message
  let text =
    get(item, ["text", "message", "comment", "review"]) ??
    get(item, ["body", "content"]) ??
    (isObject(item.feedback) ? get(item.feedback, ["text", "message", "comment"]) : null);

  reviewer = clean(typeof reviewer === "string" ? reviewer : "");
  text = clean(typeof text === "string" ? text : "");

  return { reviewer, rating, text };
}

async function dismissPopups(page) {
  // best-effort close common overlays
  const tries = [/not now/i, /no thanks/i, /close/i];
  for (const r of tries) {
    try {
      const btn = page.getByRole("button", { name: r });
      if ((await btn.count()) > 0) await btn.first().click({ timeout: 1200 });
    } catch {}
  }
}

async function scrollToLoad(page) {
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

  // --- Capture network JSON (GraphQL) responses ---
  const networkCandidates = [];
  page.on("response", async (res) => {
    try {
      const url = res.url();
      const ct = (res.headers()["content-type"] || "").toLowerCase();

      // We only try JSON-ish responses (graphql or json)
      if (!ct.includes("application/json") && !url.includes("graphql")) return;

      const status = res.status();
      if (status < 200 || status >= 300) return;

      const data = await res.json().catch(() => null);
      if (!data) return;

      // store some candidates for later parsing
      networkCandidates.push({ url, data });
    } catch {}
  });

  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1500);
  await dismissPopups(page);
  await scrollToLoad(page);
  await page.waitForTimeout(1500);

  // 1) Try extract reviews from captured network JSON
  let extracted = [];
  for (const c of networkCandidates) {
    const items = findReviewItemsDeep(c.data, []);
    for (const it of items) {
      const r = normalizeReview(it);
      if (!r.reviewer || !r.text || r.rating == null) continue;

      // Filter obvious noise
      if (/followers|following|sold|reviews\s*\(/i.test(r.text)) continue;

      extracted.push(r);
      if (extracted.length > 50) break;
    }
    if (extracted.length > 50) break;
  }

  // Deduplicate
  const seen = new Set();
  extracted = extracted.filter((r) => {
    const key = `${r.reviewer}|${r.rating}|${r.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 2) Fallback: if network method returns nothing, do a basic DOM attempt
  if (extracted.length === 0) {
    extracted = await page.evaluate((limit) => {
      const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
      const blocks = Array.from(document.querySelectorAll("div"))
        .map((el) => clean(el.textContent))
        .filter((t) => t.length > 40 && t.length < 500);

      const out = [];
      for (const t of blocks) {
        if (/followers|following|sold/i.test(t)) continue;
        const ratingMatch = t.match(/\b([0-5]\.\d)\b/);
        const userMatch = t.match(/^\s*([a-z0-9_]{3,25})\b/i);
        if (!ratingMatch || !userMatch) continue;

        let body = t.replace(/see more/ig, "").trim();
        body = body.replace(new RegExp("^" + userMatch[1] + "\\s*", "i"), "").trim();
        if (body.length < 10) continue;

        out.push({
          reviewer: userMatch[1],
          rating: parseFloat(ratingMatch[1]),
          text: body,
        });

        if (out.length >= limit) break;
      }
      return out.slice(0, limit);
    }, LIMIT);
  }

  await browser.close();

  // Take top LIMIT
  const reviews = extracted.slice(0, LIMIT);

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
