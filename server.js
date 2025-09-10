// server.js migliorato
import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import { chromium as chromiumExtra } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

// Configura stealth plugin
chromiumExtra.use(StealthPlugin());

const app = express();

// Middleware di sicurezza e performance
app.use(helmet());
app.use(cors());
app.use(compression());
app.use(express.json());

// ---- Configuration
const CONFIG = {
  HEADLESS: (process.env.HEADLESS ?? "true") !== "false",
  LIMIT_DEFAULT: parseInt(process.env.LIMIT ?? "50", 10),
  PORT: process.env.PORT || 3000,
  LOG_LEVEL: process.env.LOG_LEVEL || "info",
  CACHE_TTL_MS: parseInt(process.env.CACHE_TTL_MINUTES ?? "15", 10) * 60 * 1000,
  BASE_EXPLORE: "https://www.tiktok.com/explore?lang=en",
  VIEWPORT: { width: 1366, height: 768 },
  MAX_RETRIES: 3,
  REQUEST_TIMEOUT: 45000
};

// Logger semplice
const logger = {
  info: (...args) => CONFIG.LOG_LEVEL !== "silent" && console.log(new Date().toISOString(), "[INFO]", ...args),
  error: (...args) => console.error(new Date().toISOString(), "[ERROR]", ...args),
  warn: (...args) => CONFIG.LOG_LEVEL === "debug" && console.warn(new Date().toISOString(), "[WARN]", ...args),
  debug: (...args) => CONFIG.LOG_LEVEL === "debug" && console.log(new Date().toISOString(), "[DEBUG]", ...args)
};

// Cache in-memory migliorata
class SimpleCache {
  constructor(ttl = CONFIG.CACHE_TTL_MS) {
    this.cache = new Map();
    this.ttl = ttl;
  }

  set(key, value) {
    const expires = Date.now() + this.ttl;
    this.cache.set(key, { value, expires });
    logger.debug(`Cache SET: ${key}`);
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    
    if (Date.now() > item.expires) {
      this.cache.delete(key);
      logger.debug(`Cache EXPIRED: ${key}`);
      return null;
    }
    
    logger.debug(`Cache HIT: ${key}`);
    return item.value;
  }

  clear() {
    this.cache.clear();
    logger.debug("Cache CLEARED");
  }

  size() {
    return this.cache.size;
  }
}

const cache = new SimpleCache();

// Rate limiting semplice
const rateLimiter = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minuto
const RATE_LIMIT_MAX = 10; // Max 10 richieste per minuto

function checkRateLimit(ip) {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW;
  
  if (!rateLimiter.has(ip)) {
    rateLimiter.set(ip, []);
  }
  
  const requests = rateLimiter.get(ip).filter(time => time > windowStart);
  rateLimiter.set(ip, requests);
  
  if (requests.length >= RATE_LIMIT_MAX) {
    return false;
  }
  
  requests.push(now);
  return true;
}

// Middleware rate limiting
app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ 
      error: "rate_limit_exceeded", 
      message: "Too many requests, please try again later" 
    });
  }
  next();
});

// ---- Browser Utilities
async function createBrowserContext(retries = 0) {
  try {
    logger.debug("Creating browser context...");
    const browser = await chromiumExtra.launch({
      headless: CONFIG.HEADLESS,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-web-security",
        "--disable-features=VizDisplayCompositor",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding"
      ],
    });

    const context = await browser.newContext({
      viewport: CONFIG.VIEWPORT,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "en-US",
      timezoneId: "America/New_York",
      geolocation: { latitude: 40.7128, longitude: -74.0060 }, // NYC
      permissions: ["geolocation"],
      hasTouch: true,
      deviceScaleFactor: 1,
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });

    return { browser, context };
  } catch (error) {
    logger.error("Failed to create browser context:", error.message);
    if (retries < CONFIG.MAX_RETRIES) {
      logger.info(`Retrying browser creation... (${retries + 1}/${CONFIG.MAX_RETRIES})`);
      await new Promise(resolve => setTimeout(resolve, 2000 * (retries + 1)));
      return createBrowserContext(retries + 1);
    }
    throw error;
  }
}

async function acceptCookiesEverywhere(page) {
  const cookieSelectors = [
    'button:has-text("Accept all")',
    'button:has-text("Accept All")', 
    'button:has-text("I agree")',
    'button:has-text("Agree")',
    'button:has-text("Allow all")',
    '[data-e2e="cookie-banner-ok"]',
    '.cookie-banner button',
    '#cookie-banner-accept'
  ];

  const frames = [page, ...page.frames()];
  
  for (const frame of frames) {
    for (const selector of cookieSelectors) {
      try {
        const element = frame.locator(selector).first();
        if (await element.isVisible({ timeout: 1000 }).catch(() => false)) {
          await element.click({ delay: 100 });
          await page.waitForTimeout(500);
          logger.debug("Accepted cookies");
          return true;
        }
      } catch (e) {
        // Ignora errori sui cookie
      }
    }
  }
  return false;
}

async function smartScroll(page, options = {}) {
  const { steps = 12, waitMs = 900, direction = "down" } = options;
  
  for (let i = 0; i < steps; i++) {
    // Scroll più naturale con variazione
    const scrollAmount = direction === "down" ? 
      800 + Math.random() * 600 : 
      -(800 + Math.random() * 600);
    
    await page.mouse.wheel(0, scrollAmount);
    
    // Wait tempo variabile per sembrare più umano
    const waitTime = waitMs + Math.random() * 600;
    await page.waitForTimeout(waitTime);
    
    // Occasionalmente simula pause più lunghe
    if (Math.random() < 0.1) {
      await page.waitForTimeout(2000 + Math.random() * 1000);
    }
  }
}

// ---- Data Extraction
async function extractTikTokData(page) {
  return await page.evaluate(() => {
    // Cerca SIGI_STATE (TikTok usa questo per i dati)
    let state = null;
    
    // Metodo 1: SIGI_STATE window object
    if (window.SIGI_STATE) {
      state = window.SIGI_STATE;
    }
    
    // Metodo 2: Script tags con JSON
    if (!state) {
      const scripts = Array.from(document.scripts);
      for (const script of scripts) {
        const text = script.textContent || script.innerText || "";
        if (text.includes('"ItemModule"') || text.includes('SIGI_STATE')) {
          try {
            // Prova a estrarre JSON dallo script
            const matches = text.match(/SIGI_STATE\s*=\s*({.+?});/) || 
                           text.match(/window\.__INITIAL_STATE__\s*=\s*({.+?});/) ||
                           [null, text];
            if (matches[1]) {
              state = JSON.parse(matches[1]);
              break;
            }
          } catch (e) {
            // Continua con il prossimo script
          }
        }
      }
    }
    
    // Metodo 3: application/json scripts
    if (!state) {
      const jsonScripts = document.querySelectorAll('script[type="application/json"]');
      for (const script of jsonScripts) {
        try {
          const json = JSON.parse(script.textContent);
          if (json.ItemModule || json.props?.pageProps?.itemModule) {
            state = json;
            break;
          }
        } catch (e) {
          // Continua
        }
      }
    }
    
    return state;
  });
}

function extractHashtags(text = "") {
  if (!text) return [];
  const matches = text.match(/#[\p{L}\p{N}_]+/gu) || [];
  return [...new Set(matches)].slice(0, 10);
}

function mapVideoData(state) {
  if (!state) return [];
  
  // Estrai i video dal state
  let items = [];
  
  if (state.ItemModule) {
    items = Object.values(state.ItemModule);
  } else if (state.props?.pageProps?.itemModule) {
    items = Object.values(state.props.pageProps.itemModule);
  } else if (state.items) {
    items = state.items;
  }
  
  return items.map(item => {
    try {
      return {
        video_id: item.id,
        video_url: `https://www.tiktok.com/@${item.author}/video/${item.id}`,
        author_username: item.author,
        author_display_name: item.authorName || item.author,
        caption: item.desc || "",
        hashtags: extractHashtags(item.desc || ""),
        sound_title: item.music?.title || "",
        sound_artist: item.music?.authorName || item.music?.author || "",
        views: item.stats?.playCount ?? 0,
        likes: item.stats?.diggCount ?? 0,
        comments: item.stats?.commentCount ?? 0,
        shares: item.stats?.shareCount ?? 0,
        duration_sec: item.video?.duration ?? null,
        published_at: item.createTime ? new Date(item.createTime * 1000).toISOString() : null,
        thumbnail_url: item.video?.cover || item.video?.originCover || null,
        engagement_rate: item.stats ? 
          ((item.stats.diggCount + item.stats.commentCount + item.stats.shareCount) / 
           Math.max(item.stats.playCount, 1) * 100).toFixed(2) : 0
      };
    } catch (e) {
      logger.warn("Error mapping video data:", e.message);
      return null;
    }
  }).filter(Boolean);
}

// ---- Main Scraping Functions
async function getExploreVideos(page, minVideos = 60) {
  logger.info("Starting explore page scraping...");
  
  await page.goto(CONFIG.BASE_EXPLORE, { 
    waitUntil: "domcontentloaded", 
    timeout: CONFIG.REQUEST_TIMEOUT 
  });
  
  await acceptCookiesEverywhere(page);
  await page.waitForTimeout(2000);
  
  // Estrai dati direttamente dalla pagina explore
  let state = await extractTikTokData(page);
  let videos = mapVideoData(state);
  
  if (videos.length >= minVideos) {
    logger.info(`Found ${videos.length} videos from initial load`);
    return videos;
  }
  
  // Se non abbastanza video, scrolla per caricarne altri
  logger.info("Scrolling to load more videos...");
  await smartScroll(page, { steps: 15, waitMs: 1200 });
  
  state = await extractTikTokData(page);
  videos = mapVideoData(state);
  
  logger.info(`Found ${videos.length} videos after scrolling`);
  return videos;
}

async function scrapeTopTrending(limit = CONFIG.LIMIT_DEFAULT) {
  const cacheKey = `trending_${limit}`;
  const cached = cache.get(cacheKey);
  
  if (cached) {
    logger.info("Returning cached results");
    return cached;
  }
  
  logger.info(`Starting scrape for top ${limit} trending videos`);
  const startTime = Date.now();
  
  let browser, context;
  try {
    ({ browser, context } = await createBrowserContext());
    const page = await context.newPage();
    
    // Blocca risorse non necessarie per velocizzare
    await page.route("**/*", (route) => {
      const resourceType = route.request().resourceType();
      if (["image", "media", "font"].includes(resourceType)) {
        return route.abort();
      }
      return route.continue();
    });
    
    const videos = await getExploreVideos(page, limit * 2);
    
    // Ordina per engagement
    const sortedVideos = videos
      .filter(video => video && video.video_url && video.video_id)
      .sort((a, b) => {
        const engagementA = a.likes + a.comments + a.shares + (a.views || 0) / 100;
        const engagementB = b.likes + b.comments + b.shares + (b.views || 0) / 100;
        return engagementB - engagementA;
      })
      .slice(0, limit);
    
    const result = {
      videos: sortedVideos,
      metadata: {
        scraped_at: new Date().toISOString(),
        total_found: videos.length,
        returned: sortedVideos.length,
        duration_ms: Date.now() - startTime
      }
    };
    
    cache.set(cacheKey, result);
    logger.info(`Scraping completed in ${Date.now() - startTime}ms`);
    
    return result;
    
  } catch (error) {
    logger.error("Scraping failed:", error.message);
    throw error;
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

// ---- API Routes
app.get("/", (_req, res) => {
  res.json({ 
    ok: true, 
    service: "TikTok Trending Scraper",
    version: "2.0.0",
    routes: [
      "GET /health - Health check",
      "GET /debug - Debug info", 
      "GET /trending - Get trending videos",
      "GET /stats - Cache statistics",
      "POST /cache/clear - Clear cache"
    ]
  });
});

app.get("/health", (_req, res) => {
  res.json({ 
    ok: true, 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    cache_size: cache.size()
  });
});

app.get("/trending", async (req, res) => {
  try {
    const limit = Math.min(
      parseInt(req.query.limit ?? CONFIG.LIMIT_DEFAULT, 10) || CONFIG.LIMIT_DEFAULT, 
      100
    );
    
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
    
    const info = {
      url: CONFIG.BASE_EXPLORE,
      timestamp: new Date().toISOString(),
      browser_launched: true,
      page_loaded: false,
      has_data: false,
      video_links: 0,
      error: null
    };
    
    try {
      await page.goto(CONFIG.BASE_EXPLORE, { 
        waitUntil: "domcontentloaded", 
        timeout: CONFIG.REQUEST_TIMEOUT 
      });
      info.page_loaded = true;
      info.page_title = await page.title();
      
      await acceptCookiesEverywhere(page);
      
      const state = await extractTikTokData(page);
      info.has_data = Boolean(state);
      
      if (state) {
        const videos = mapVideoData(state);
        info.video_count = videos.length;
        info.sample_video = videos[0] || null;
      }
      
      // Conta i link video visibili
      const videoLinks = await page.locator('a[href*="/video/"]').count();
      info.video_links = videoLinks;
      
    } catch (e) {
      info.error = e.message;
    }
    
    res.json(info);
    
  } catch (error) {
    res.status(500).json({ 
      error: "debug_failed", 
      message: error.message 
    });
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
});

app.get("/stats", (req, res) => {
  res.json({
    cache: {
      size: cache.size(),
      ttl_minutes: CONFIG.CACHE_TTL_MS / 60000
    },
    config: {
      headless: CONFIG.HEADLESS,
      default_limit: CONFIG.LIMIT_DEFAULT,
      max_retries: CONFIG.MAX_RETRIES,
      request_timeout: CONFIG.REQUEST_TIMEOUT
    },
    system: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      node_version: process.version
    }
  });
});

app.post("/cache/clear", (req, res) => {
  cache.clear();
  res.json({ 
    ok: true, 
    message: "Cache cleared",
    timestamp: new Date().toISOString()
  });
});

// Legacy endpoint compatibility
app.get("/top50", async (req, res) => {
  logger.warn("Using deprecated endpoint /top50, use /trending instead");
  req.url = "/trending";
  return app._router.handle(req, res);
});

// Error handling middleware
app.use((error, req, res, next) => {
  logger.error("Unhandled error:", error);
  res.status(500).json({
    error: "internal_server_error",
    message: "An unexpected error occurred"
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: "not_found",
    message: `Route ${req.method} ${req.path} not found`
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully'); 
  process.exit(0);
});

// Start server
const server = app.listen(CONFIG.PORT, () => {
  logger.info(`🚀 TikTok Scraper running on port ${CONFIG.PORT}`);
  logger.info(`🔗 Health check: http://localhost:${CONFIG.PORT}/health`);
  logger.info(`📊 Debug info: http://localhost:${CONFIG.PORT}/debug`);
  logger.info(`🎯 Trending API: http://localhost:${CONFIG.PORT}/trending`);
});

// Handle server errors
server.on('error', (error) => {
  logger.error('Server error:', error);
  process.exit(1);
});

export default app;
