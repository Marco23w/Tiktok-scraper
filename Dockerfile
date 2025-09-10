# Dockerfile per Render
FROM node:18-slim

# Installa dipendenze sistema per Playwright
RUN apt-get update && apt-get install -y \
    wget \
    ca-certificates \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libxshmfence1 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copia package.json e installa dipendenze
COPY package.json ./
RUN npm install --production

# Copia codice sorgente
COPY server.js ./

# Installa Chromium per Playwright
RUN npx playwright install chromium --with-deps

# Render usa automaticamente PORT env var
EXPOSE $PORT

CMD ["node", "server.js"]
