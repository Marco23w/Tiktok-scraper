// server.js
import express from "express";
import { chromium } from "playwright";

const app = express();

/* ──────────────────────────────────────────────────────────────
   (Opzionale) Protezione con API key:
   imposta env API_KEY su Render/hosting e invia header x-api-key
   ────────────────────────────────────────────────────────────── */
const API_KEY = process.env.API_KEY || "";
app.use((req, res, next) => {
  if (!API_KEY) return next();
  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

/* ──────────────────────────────────────────────────────────────
   Utils
   ────────────────────────────────────────────────────────────── */
app.get("/health", (_, res) => res.json({ ok: true }));

function pickHashTags(text = "") {
  const m = text.match(/#\w+/g) || [];
  return [...new Set(m)].slice(0, 8);
}

function mapFromSIGI(state) {
  const items = state?.ItemModule ? Object.values(state.ItemModule) : [];
  return items.map((v) => ({
    video_id: v.id,
    video_url: `https://www.tiktok.com/@${v.author}/video/${v.id}`,
    author_username: v.author,
    caption: v.desc || "",
    hashtags: pickHashTags(v.desc || ""),
    // Music info (preferisce ciò che c'è nel singolo item)
    sound_title:
      v.music?.title ||
      state?.MusicModule?.music?.title ||
      "",
    sound_artist:
      v.music?.authorName ||
      v.music?.author ||
      state?.MusicModule?.music?.authorName ||
      "",
    views: v.stats?.playCount ?? 0,
    likes: v.stats?.diggCount ?? 0,
    comments: v.stats?.commentCount ?? 0,
    shares: v.stats?.shareCount ?? 0,
    duration_sec: v.video?.duration ?? null,
    published_at: v.createTime
      ? new Date(v.createTime * 1000).toISOString()
      : null,
    thumbnail_url: v.video?.cover || null,
  }));
}

/* ──────────────────────────────────────────────────────────────
   Core: Top50 "oggi" dal feed Explore pubblico
   - scroll esteso per caricare abbastanza item
   - filtro 24h (fallback 48h)
   - ranking per velocità: (likes + 2*comments + 3*shares)/ora + ER leggero
   ────────────────────────────────────────────────────────────── */
async function getTrendingTop50() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    locale: "it-IT",
  });

  const page = await context.newPage();
  await page.goto("https://www.tiktok.com/explore", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  // scrolla di più per ampliare la copertura
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press("PageDown");
    await page.waitForTimeout(700 + Math.random() * 500);
  }

  const sigi = await page.evaluate(() => {
    const n = document.querySelector("#SIGI_STATE");
    if (!n) return null;
    try {
      return JSON.parse(n.textContent);
    } catch {
      return null;
    }
  });

  await browser.close();

  let rows = mapFromSIGI(sigi || {});

  // filtro 24h (fallback 48h)
  const now = Date.now();
  const withinHours = (iso, h) => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return now - t <= h * 3600 * 1000;
  };

  let recent = rows.filter((r) => withinHours(r.published_at, 24));
  if (recent.length < 50) {
    recent = rows.filter((r) => withinHours(r.published_at, 48));
  }

  // scoring per velocità
  const scored = recent.map((r) => {
    const hours =
      Math.max(1, (now - new Date(r.published_at).getTime()) / 3_600_000);
    const interactions =
      (r.likes || 0) + 2 * (r.comments || 0) + 3 * (r.shares || 0);
    const perHour = interactions / hours;
    const er = interactions / Math.max(1, r.views || 0);
    const score = perHour + er * 1000 * 0.25;
    return {
      ...r,
      score: Number(score.toFixed(3)),
      hours_since_post: Number(hours.toFixed(1)),
    };
  });

  scored.sort((a, b) => b.score - a.score);

  // riempi se <50
  let top = scored.slice(0, 50);
  if (top.length < 50) {
    const filler = rows
      .filter((r) => !top.find((t) => t.video_id === r.video_id))
      .sort(
        (a, b) =>
          b.likes + b.comments + b.shares - (a.likes + a.comments + a.shares)
      )
      .slice(0, 50 - top.length);
    top = top.concat(filler);
  }

  return top;
}

/* ──────────────────────────────────────────────────────────────
   API
   ────────────────────────────────────────────────────────────── */
app.get("/top50", async (_req, res) => {
  try {
    const data = await getTrendingTop50();
    res.json(data);
  } catch (e) {
    console.error("ERR /top50:", e);
    res.status(500).json({ error: "failed" });
  }
});

/* ────────────────────────────────────────────────────────────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("scraper on :" + PORT));
