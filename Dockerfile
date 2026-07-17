FROM node:22-bookworm

WORKDIR /app

RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    nano \
    vim \
    tesseract-ocr \
    imagemagick \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxshmfence1 \
    xdg-utils \
    libglib2.0-0

RUN wget -qO- https://dl.google.com/linux/linux_signing_key.pub \
| gpg --dearmor \
> /usr/share/keyrings/google.gpg

RUN echo \
"deb [arch=amd64 signed-by=/usr/share/keyrings/google.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
> /etc/apt/sources.list.d/google.list

RUN apt-get update

RUN apt-get install -y google-chrome-stable

COPY package*.json ./

RUN npm install

COPY . .

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome

EXPOSE 3000

CMD ["node","server.js"]
