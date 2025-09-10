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


