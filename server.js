// server.js - Versione completa per trending italiani
import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromiumExtra.use(StealthPlugin());

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(compression());
app.use(express.json());

// Configuration per Italia
const CONFIG = {
  HEADLESS: (process.env.HEADLESS ?? "true") !== "false",
  LIMIT_DEFAULT: parseInt(process.env.LIMIT ?? "50", 10),
  PORT: process.env.PORT || 3000,
  LOG_LEVEL: process.env.LOG_LEVEL || "info",
  CACHE_TTL_MS: parseInt(process.env.CACHE_TTL_MINUTES ?? "15", 10) * 60 * 1000,
  VIEWPORT: { width: 414, height: 896 },
  MAX_RETRIES: 3,
  REQUEST_TIMEOUT: 60000,
  USER_AGENT: "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1"
};

// URLs per trending italiani
const TIKTOK_TRENDING_URLS = [
  "https://www.tiktok.com/explore?lang=it",
  "https://www.tiktok.com/foryou?lang=it",
  "https://www.tiktok.com/trending?lang=it",
  "https://www.tiktok.com/tag/italia?lang=it",
  "https://www.tiktok.com/tag/fyp?lang=it",
  "https://www.tiktok.com/tag/viral?lang=it",
  "https://www.tiktok.com/tag/trend?lang=it",
  "https://www.tiktok.com/tag/comedy?lang=it",
  "https://www.tiktok.com/tag/meme?lang=it"
];

// Logger semplice
const logger = {
  info: (...args) => console.log(new Date().toISOString(), "[INFO]", ...args),
  error: (...args) => console.error(new Date().toISOString(), "[ERROR]", ...args),
  warn: (...args) => console.warn(new Date().toISOString(), "[WARN]", ...args),
  debug: (...args) => CONFIG.LOG_LEVEL === "debug" && console.log(new Date().toISOString(), "[DEBUG]", ...args)
};

// Cache semplice
class SimpleCache {
  constructor(ttl = CONFIG.CACHE_TTL_MS) {
    this.cache = new Map();
    this.ttl = ttl;
  }

  set(key, value) {
    const expires = Date.now() + this.ttl;
    this.cache.set(key, { value, expires });
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    if (Date.now() > item.expires) {
      this.cache.delete(key);
      return null;
    }
    return item.value;
  }

  clear() {
    this.cache.clear();
  }

  size() {
    return this.cache.size;
  }
}

const cache = new SimpleCache();

// Crea browser context per Italia
async function createBrowserContext(retries = 0) {
  try {
    const browser = await chromiumExtra.launch({
      headless: CONFIG.HEADLESS,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-web-security",
        "--disable-features=VizDisplayCompositor",
        "--disable-blink-features=AutomationControlled",
        "--no-first-run"
      ],
    });

    const context = await browser.newContext({
      viewport: CONFIG.VIEWPORT,
      userAgent: CONFIG.USER_AGENT,
      locale: "it-IT",
      timezoneId: "Europe/Rome",
      geolocation: { latitude: 41.9028, longitude: 12.4964 },
      permissions: ["geolocation"],
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
      extraHTTPHeaders: {
        'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8'
      }
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'language', { get: () => 'it-IT' });
      Object.defineProperty(navigator, 'languages', { get: () => ['it-IT', 'it', 'en'] });
    });

    return { browser, context };
  } catch (error) {
    logger.error("Browser context creation failed:", error.message);
    if (retries < CONFIG.MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      return createBrowserContext(retries + 1);
    }
    throw error;
  }
}

// Accetta cookie
async function acceptCookies(page) {
  const selectors = [
    'button:has-text("Accept all")',
    'button:has-text("Accetta tutto")',
    'button:has-text("Accetta")',
    '[data-e2e="cookie-banner-ok"]'
  ];

  for (const selector of selectors) {
    try {
      const element = page.locator(selector).first();
      if (await element.isVisible({ timeout: 1000 }).catch(() => false)) {
        await element.click();
        await page.waitForTimeout(500);
        return true;
      }
    } catch (e) {
      continue;
    }
  }
  return false;
}

// Estrai hashtag dal testo
function extractHashtags(text = "") {
  if (!text) return [];
  const matches = text.match(/#[\p{L}\p{N}_]+/gu) || [];
  return [...new Set(matches)].slice(0, 10);
}

// Parse numeri con K/M/B
function parseCount(text, pattern) {
  const match = text.match(pattern);
  if (!match) return 0;
  const [, number, unit] = match;
  let count = parseFloat(number);
  switch (unit?.toUpperCase()) {
    case 'K': count *= 1000; break;
    case 'M': count *= 1000000; break;
    case 'B': count *= 1000000000; break;
  }
  return Math.floor(count);
}

// Estrai dati JSON dalla pagina
async function extractTikTokData(page) {
  return await page.evaluate(() => {
    let state = null;
    
    if (window.__INITIAL_STATE__) {
      state = window.__INITIAL_STATE__;
    } else if (window.SIGI_STATE) {
      state = window.SIGI_STATE;
    }
    
    if (!state) {
      const scripts = Array.from(document.scripts);
      for (const script of scripts) {
        const text = script.textContent || '';
        if (text.length < 1000) continue;
        
        try {
          const patterns = [
            /window\.__INITIAL_STATE__\s*=\s*({.+?});/,
            /SIGI_STATE\s*=\s*({.+?});/,
            /"ItemModule":\s*({.+?})/
          ];
          
          for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match && match[1]) {
              const parsed = JSON.parse(match[1]);
              if (parsed.ItemModule || parsed.itemModule) {
                state = parsed;
                break;
              }
            }
          }
          if (state) break;
        } catch (e) {
          continue;
        }
      }
    }
    
    return state;
  });
}

// Estrai video dalla pagina trending
async function extractTrendingVideos(page) {
  return await page.evaluate(() => {
    const videos = [];
    const selectors = [
      'a[href*="/video/"]',
      '[data-e2e="recommend-list-item"] a',
      '[data-e2e="challenge-item"] a',
      '.video-feed-item a'
    ];
    
    for (const selector of selectors) {
      const links = document.querySelectorAll(selector);
      
      for (const link of links) {
        try {
          const href = link.href;
          if (!href || !href.includes('/video/')) continue;
          
          const match = href.match(/\/@([^/]+)\/video\/(\d+)/);
          if (!match) continue;
          
          const [, username, videoId] = match;
          const container = link.closest('[data-e2e="recommend-list-item"]') || link.parentElement;
          const img = container?.querySelector('img');
          const text = container?.textContent || '';
          
          videos.push({
            video_id: videoId,
            video_url: href,
            author_username: username,
            caption: img?.alt || '',
            hashtags: [], // Sarà popolato dopo
            thumbnail_url: img?.src || '',
            views: 0, // Sarà estratto dal testo se disponibile
            likes: 0,
            comments: 0,
            shares: 0,
            published_at: new Date().toISOString(),
            source: 'trending_page',
            region: 'IT'
          });
          
        } catch (e) {
          continue;
        }
      }
      
      if (videos.length > 0) break;
    }
    
    return videos;
  });
}

// Mappa dati video da JSON
function mapVideoData(state) {
  if (!state) return [];
  
  let items = [];
  if (state.ItemModule) {
    items = Object.values(state.ItemModule);
  } else if (state.itemModule) {
    items = Object.values(state.itemModule);
  }
  
  return items.map(item => {
    try {
      return {
        video_id: item.id || '',
        video_url: `https://www.tiktok.com/@${item.author}/video/${item.id}`,
        author_username: item.author || '',
        caption: item.desc || '',
        hashtags: extractHashtags(item.desc || ''),
        thumbnail_url: item.video?.cover || '',
        views: item.stats?.playCount || 0,
        likes: item.stats?.diggCount || 0,
        comments: item.stats?.commentCount || 0,
        shares: item.stats?.shareCount || 0,
        published_at: item.createTime ? new Date(item.createTime * 1000).toISOString() : null,
        source: 'json_data',
        region: 'IT'
      };
    } catch (e) {
      return null;
    }
  }).filter(Boolean);
}

// Funzione principale per ottenere video trending
async function getTrendingVideos(page, limit = 50) {
  const allVideos = [];
  
  for (const url of TIKTOK_TRENDING_URLS) {
    try {
      logger.info(`Fetching trending from: ${url}`);
      
      await page.goto(url, { 
        waitUntil: "domcontentloaded", 
        timeout: CONFIG.REQUEST_TIMEOUT 
      });
      
      await page.waitForTimeout(5000);
      await acceptCookies(page);
      await page.waitForTimeout(2000);
      
      // Check per challenge
      const title = await page.title();
      if (title.includes('verify') || title.includes('challenge')) {
        logger.warn(`Challenge detected on ${url}`);
        continue;
      }
      
      let videos = [];
      
      // Strategy 1: Estrazione trending
      videos = await extractTrendingVideos(page);
      logger.info(`Trending extraction: ${videos.length} videos`);
      
      // Strategy 2: JSON fallback
      if (videos.length === 0) {
        const state = await extractTikTokData(page);
        videos = mapVideoData(state);
        logger.info(`JSON extraction: ${videos.length} videos`);
      }
      
      // Strategy 3: Scroll e riprova
      if (videos.length < 5) {
        logger.info(`Scrolling for more content...`);
        for (let i = 0; i < 3; i++) {
          await page.evaluate(() => window.scrollBy(0, window.innerHeight));
          await page.waitForTimeout(2000);
        }
        
        const scrollVideos = await extractTrendingVideos(page);
        if (scrollVideos.length > videos.length) {
          videos = scrollVideos;
        }
      }
      
      if (videos.length > 0) {
        // Processa hashtag
        videos.forEach(video => {
          video.hashtags = extractHashtags(video.caption);
        });
        
        allVideos.push(...videos);
        logger.info(`Success with ${url}: ${videos.length} videos`);
        
        if (allVideos.length >= 50) break;
      }
      
      await page.waitForTimeout(2000);
      
    } catch (error) {
      logger.warn(`Error with ${url}: ${error.message}`);
      continue;
    }
  }
  
  // Remove duplicates
  const uniqueVideos = allVideos.filter((video, index, self) => 
    index === self.findIndex(v => v.video_id === video.video_id)
  );
  
  // Sort by engagement
  const sortedVideos = uniqueVideos.sort((a, b) => {
    const scoreA = (a.views || 0) + (a.likes || 0) * 10;
    const scoreB = (b.views || 0) + (b.likes || 0) * 10;
    return scoreB - scoreA;
  });
  
  logger.info(`Total trending videos found: ${sortedVideos.length}`);
  return sortedVideos.slice(0, limit);
}

// Scraper principale
async function scrapeTopTrending(limit = CONFIG.LIMIT_DEFAULT) {
  const cacheKey = `trending_italy_${limit}`;
  const cached = cache.get(cacheKey);
  
  if (cached) {
    logger.info("Returning cached results");
    return cached;
  }
  
  logger.info(`Starting scrape for ${limit} trending videos in Italy`);
  
  let browser, context;
  try {
    ({ browser, context } = await createBrowserContext());
    const page = await context.newPage();
    
    const videos = await getTrendingVideos(page, limit);
    
    // Analisi hashtag trending
    const hashtagCount = {};
    videos.forEach(video => {
      video.hashtags?.forEach(tag => {
        hashtagCount[tag] = (hashtagCount[tag] || 0) + 1;
      });
    });
    
    const topHashtags = Object.entries(hashtagCount)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 10)
      .map(([tag, count]) => ({ tag, count }));
    
    const result = {
      videos,
      metadata: {
        scraped_at: new Date().toISOString(),
        total_found: videos.length,
        returned: videos.length,
        region: 'Italy',
        trending_hashtags: topHashtags,
        cache_ttl_minutes: CONFIG.CACHE_TTL_MS / 60000
      }
    };
    
    cache.set(cacheKey, result);
    logger.info(`Scraping completed: ${videos.length} videos`);
    
    return result;
    
  } catch (error) {
    logger.error("Scraping failed:", error.message);
    throw error;
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

// Routes
app.get("/", (_req, res) => {
  res.json({ 
    ok: true, 
    service: "TikTok Italy Trending Scraper",
    version: "4.0.0",
    routes: ["/health", "/debug", "/trending", "/test"],
    region: "Italy"
  });
});

app.get("/health", (_req, res) => {
  res.json({ 
    ok: true, 
    timestamp: new Date().toISOString(),
    cache_size: cache.size(),
    uptime: process.uptime(),
    region: "Italy"
  });
});

app.get("/trending", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit ?? CONFIG.LIMIT_DEFAULT, 10) || CONFIG.LIMIT_DEFAULT, 100);
    const result = await scrapeTopTrending(limit);
    res.json(result);
  } catch (error) {
    logger.error("API Error:", error.message);
    res.status(500).json({ 
      error: "scraping_failed", 
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.get("/debug", async (req, res) => {
  let browser, context;
  try {
    ({ browser, context } = await createBrowserContext());
    const page = await context.newPage();
    
    const testUrl = "https://www.tiktok.com/explore?lang=it";
    const info = {
      url: testUrl,
      timestamp: new Date().toISOString(),
      config: {
        locale: "it-IT",
        timezone: "Europe/Rome",
        geolocation: "Rome, Italy"
      }
    };
    
    try {
      await page.goto(testUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      info.page_loaded = true;
      info.title = await page.title();
      info.final_url = page.url();
      
      await acceptCookies(page);
      await page.waitForTimeout(3000);
      
      info.video_links = await page.locator('a[href*="/video/"]').count();
      
      const videos = await extractTrendingVideos(page);
      info.videos_found = videos.length;
      info.sample_video = videos[0] || null;
      
    } catch (e) {
      info.error = e.message;
    }
    
    res.json(info);
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
});

app.get("/test", async (req, res) => {
  let browser, context;
  try {
    ({ browser, context } = await createBrowserContext());
    const page = await context.newPage();
    
    const testUrl = req.query.url || "https://www.tiktok.com/explore?lang=it";
    await page.goto(testUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);
    
    const info = {
      url: testUrl,
      title: await page.title(),
      final_url: page.url(),
      video_links: await page.locator('a[href*="/video/"]').count(),
      user_agent: await page.evaluate(() => navigator.userAgent),
      language: await page.evaluate(() => navigator.language)
    };
    
    const videos = await extractTrendingVideos(page);
    info.videos_found = videos.length;
    info.sample_videos = videos.slice(0, 2);
    
    res.json(info);
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
});

// Legacy compatibility
app.get("/top50", async (req, res) => {
  req.url = "/trending";
  app._router.handle(req, res);
});

// Error handlers
app.use((error, req, res, next) => {
  logger.error("Unhandled error:", error);
  res.status(500).json({ error: "internal_server_error" });
});

app.use((req, res) => {
  res.status(404).json({ error: "not_found" });
});

// Start server
const server = app.listen(CONFIG.PORT, () => {
  logger.info(`TikTok Italy Trending Scraper running on port ${CONFIG.PORT}`);
  logger.info(`Targeting trending content in Italy`);
});

server.on('error', (error) => {
  logger.error('Server error:', error);
  process.exit(1);
});

export default app;
