# Dockerfile migliorato
FROM node:18-slim

# Installa dipendenze di sistema per Playwright
RUN apt-get update && apt-get install -y \
    wget gnupg ca-certificates \
    fonts-liberation libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libgtk-3-0 libnss3 libxshmfence1 libasound2 \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copia package.json e installa dipendenze
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copia il codice sorgente
COPY . .

# Installa browser Chromium per Playwright
RUN npx playwright install chromium --with-deps

# Crea utente non-root per sicurezza
RUN groupadd -r appuser && useradd -r -g appuser appuser
RUN chown -R appuser:appuser /app
USER appuser

EXPOSE 3000

# Usa dumb-init per gestire correttamente i segnali
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]

---

# package.json migliorato
{
  "name": "tiktok-scraper",
  "version": "1.0.0",
  "description": "TikTok trending videos scraper",
  "type": "module",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js",
    "test": "node test.js"
  },
  "dependencies": {
    "express": "^4.19.2",
    "playwright": "^1.46.0",
    "playwright-extra": "^4.3.6",
    "puppeteer-extra-plugin-stealth": "^2.11.2",
    "cors": "^2.8.5",
    "helmet": "^7.1.0",
    "compression": "^1.7.4"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "keywords": ["tiktok", "scraper", "trending", "playwright"],
  "author": "Your Name",
  "license": "MIT"
}

---

# docker-compose.yml per sviluppo e produzione
version: '3.8'

services:
  tiktok-scraper:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - HEADLESS=true
      - LIMIT=50
      - PORT=3000
      - LOG_LEVEL=info
    restart: unless-stopped
    mem_limit: 1g
    cpus: 0.5
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
    networks:
      - scraper-network

  # Redis per cache distribuita (opzionale)
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    networks:
      - scraper-network

volumes:
  redis_data:

networks:
  scraper-network:
    driver: bridge

---

# .env di esempio
NODE_ENV=production
HEADLESS=true
LIMIT=50
PORT=3000
LOG_LEVEL=info
REDIS_URL=redis://redis:6379
CACHE_TTL_MINUTES=15

---

# .dockerignore
node_modules
npm-debug.log
.git
.gitignore
README.md
.env
.env.local
.nyc_output
coverage
.DS_Store
