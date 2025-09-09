FROM node:18-slim
RUN apt-get update && apt-get install -y wget gnupg ca-certificates \
    fonts-liberation libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libgtk-3-0 libnss3 libxshmfence1 libasound2 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.js ./server.js
RUN npx playwright install chromium --with-deps
EXPOSE 3000
CMD ["node","server.js"]

