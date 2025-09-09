// server.js (V2)
import express from "express";
import { chromium as pwChromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
pwChromium.use(stealth());

const app = express();
const API_KEY = process.env.API_KEY || "";
const PROXY_URL = process.env.PROXY_URL || ""; // es: http://user:pass@host:port
const COOKIES_JSON = process.env.TIKTOK_COOKIES || ""; // JSON string array di cookie Playwright

app.use((req, res, next) => {
  if (!API_KEY) return next();
  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

app.get("/", (_, res) => res.json({ ok: true, routes: ["/health","/ip","/debug","/top50"] }));
app.get("/health", (_, res) => res.json({ ok: true }));

function pickHashTags(text=""){ const m = text.match(/#\w+/g) || []; return [...new Set(m)].slice(0,8); }
function mapFromSIGI(state){
  const items = state?.ItemModule ? Object.values(state.ItemModule) : [];
  return items.map(v => ({
    video_id: v.id,
    video_url: `https://www.tiktok.com/@${v.author}/video/${v.id}`,
    author_username: v.author,
    caption: v.desc || "",
    hashtags: pickHashTags(v.desc || ""),
    sound_title: v.music?.title || state?.MusicModule?.music?.title || "",
    sound_artist: v.music?.authorName || v.music?.author || state?.MusicModule?.music?.authorName || "",
    views: v.stats?.playCount ?? 0,
    likes: v.stats?.diggCount ?? 0,
    comments: v.stats?.commentCount ?? 0,
    shares: v.stats?.shareCount ?? 0,
    duration_sec: v.video?.duration ?? null,
    published_at: v.createTime ? new Date(v.createTime * 1000).toISOString() : null,
    thumbnail_url: v.video?.cover || null
  }));
}

async function makeContext() {
  const browser = await pwChromium.launch({
    headless: true,
    args: ["--no-sandbox","--disable-dev-shm-usage","--disable-blink-features=AutomationControlled"],
    proxy: PROXY_URL ? { server: PROXY_URL } : undefined
  });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    locale: "it-IT",
    timezoneId: "Europe/Rome",
    extraHTTPHeaders: { "Accept-Language": "it-IT,it;q=0.9" }
  });
  // stealth extra
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, "languages", { get: () => ["it-IT","it"] });
    Object.defineProperty(navigator, "platform", { get: () => "Win32" });
  });
  // opzionale: cookie
  if (COOKIES_JSON) {
    try { await context.addCookies(JSON.parse(COOKIES_JSON)); } catch {}
  }
  // riduci carico (blocca media pesanti)
  await context.route("**/*", route => {
    const req = route.request();
    const type = req.resourceType();
    if (["image","media","font"].includes(type)) return route.abort();
    route.continue();
  });
  return { browser, context };
}

async function extractFromVideoPage(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1200);
    const sigi = await page.evaluate(() => {
      const n = document.querySelector("#SIGI_STATE");
      if (!n) return null;
      try { return JSON.parse(n.textContent); } catch { return null; }
    });
    const rows = mapFromSIGI(sigi || {});
    const id = (url.match(/\/video\/(\d+)/) || [])[1];
    const pick = id ? rows.find(r => r.video_id === id) : rows[0];
    return pick || null;
  } catch { return null; } finally { await page.close().catch(() => {}); }
}

async function harvestLinks(page, url, scrolls=15) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  // cookie banner
  try { const btn = page.locator('button:has-text("Accetta"), button:has-text("Accept")').first();
        if (await btn.isVisible()) await btn.click({timeout:1500}).catch(()=>{}); } catch {}
  await page.waitForTimeout(1200);
  for (let i=0;i<scrolls;i++){ await page.keyboard.press("PageDown"); await page.waitForTimeout(400+Math.random()*400); }
  const sigi = await page.evaluate(() => {
    const n = document.querySelector("#SIGI_STATE"); if(!n) return null;
    try { return JSON.parse(n.textContent); } catch { return null; }
  });
  const rows = mapFromSIGI(sigi || {});
  const links = await page.evaluate(() => {
    const as = Array.from(document.querySelectorAll('a[href*="/video/"]'));
    const urls = as.map(a => a.href.split("?")[0]).filter(Boolean);
    return Array.from(new Set(urls));
  });
  return { rows, links };
}

async function getTrendingTop50() {
  const { browser, context } = await makeContext();
  const page = await context.newPage();

  const entryPoints = [
    "https://www.tiktok.com/explore",
    "https://www.tiktok.com/discover",
    // alcune ricerche generiche per ampliare il bacino
    "https://www.tiktok.com/search?q=trend&lang=it-IT",
    "https://www.tiktok.com/search?q=meme&lang=it-IT",
    "https://www.tiktok.com/search?q=viral&lang=it-IT"
  ];

  let rows = [];
  let links = [];
  for (const u of entryPoints) {
    try {
      const ret = await harvestLinks(page, u, 18);
      rows = rows.concat(ret.rows || []);
      links = links.concat(ret.links || []);
    } catch {}
  }
  // dedup
  const byId = new Map(rows.filter(r=>r?.video_id).map(r => [r.video_id, r]));
  links = [...new Set(links)];

  // se pochi, apri le pagine video e arricchisci
  const need = 100;
  const toVisit = links.filter(h => !byId.has((h.match(/\/video\/(\d+)/)||[])[1])).slice(0, need);
  const collected = [];
  // piccola concorrenza per evitare ban
  const pool = 4;
  for (let i = 0; i < toVisit.length; i += pool) {
    const chunk = toVisit.slice(i, i + pool);
    const got = await Promise.all(chunk.map(h => extractFromVideoPage(context, h)));
    collected.push(...got.filter(Boolean));
    if (byId.size + collected.length >= need) break;
  }

  for (const r of collected) if (r?.video_id && !byId.has(r.video_id)) byId.set(r.video_id, r);

  await browser.close();

  let items = Array.from(byId.values());

  // filtro freschezza + scoring
  const now = Date.now();
  const withinHours = (iso, h) => iso && now - new Date(iso).getTime() <= h * 3600 * 1000;

  let recent = items.filter(r => withinHours(r.published_at, 24));
  if (recent.length < 50) recent = items.filter(r => withinHours(r.published_at, 48));

  const scored = recent.map(r => {
    const hours = Math.max(1, (now - new Date(r.published_at).getTime()) / 3_600_000);
    const interactions = (r.likes||0) + 2*(r.comments||0) + 3*(r.shares||0);
    const perHour = interactions / hours;
    const er = interactions / Math.max(1, r.views || 0);
    const score = perHour + er * 1000 * 0.25;
    return { ...r, score: Number(score.toFixed(3)), hours_since_post: Number(hours.toFixed(1)) };
  });
  scored.sort((a,b)=> b.score - a.score);

  let top = scored.slice(0,50);
  if (top.length < 50) {
    const filler = items
      .filter(r => !top.find(t => t.video_id === r.video_id))
      .sort((a,b)=> (b.likes+b.comments+b.shares) - (a.likes+a.comments+a.shares))
      .slice(0, 50 - top.length);
    top = top.concat(filler);
  }

  return top;
}

// --- Endpoint diagnostici ---
app.get("/ip", async (_req, res) => {
  try {
    const { browser, context } = await makeContext();
    const page = await context.newPage();
    await page.goto("https://api.ipify.org?format=json", { waitUntil: "domcontentloaded" });
    const ip = await page.evaluate(() => document.body.innerText);
    await browser.close();
    res.type("application/json").send(ip);
  } catch (e) { res.status(500).json({ error: e?.message || "ip-fail" }); }
});

app.get("/debug", async (_req, res) => {
  try {
    const { browser, context } = await makeContext();
    const page = await context.newPage();
    await page.goto("https://www.tiktok.com/explore", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2000);
    const info = await page.evaluate(() => {
      const hasSIGI = !!document.querySelector("#SIGI_STATE");
      const title = document.title;
      const text = document.body?.innerText?.toLowerCase() || "";
      const challenge = ["verify","challenge","access denied","captcha","robot"].some(w=>text.includes(w));
      const links = Array.from(document.querySelectorAll('a[href*="/video/"]')).map(a => a.href);
      return { title, hasSIGI, challenge, linkCount: links.length, firstLinks: links.slice(0,5) };
    });
    await browser.close();
    res.json(info);
  } catch (e) { res.status(500).json({ error: e?.message || "debug-fail" }); }
});

// --- API principale ---
app.get("/top50", async (_req,res)=>{
  try {
    const data = await getTrendingTop50();
    res.json(data);
  } catch(e){
    console.error("ERR /top50:", e);
    res.status(500).json({ error: "failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log("scraper on :"+PORT));
