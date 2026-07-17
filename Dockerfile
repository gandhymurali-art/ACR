FROM node:22-bookworm

WORKDIR /app

RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    nano \
    vim \
    tesseract-ocr \
    build-essential \
    pkg-config \
    libjpeg-dev \
    libpng-dev \
    libtiff-dev \
    libwebp-dev \
    libheif-dev \
    libxml2-dev \
    libfreetype6-dev \
    liblcms2-dev \
    libx11-dev \
    libxt-dev \
    libltdl-dev \
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
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
    
RUN wget -O ImageMagick-7.1.2-25.tar.gz \
    https://github.com/ImageMagick/ImageMagick/archive/refs/tags/7.1.2-25.tar.gz && \
    tar -xzf ImageMagick-7.1.2-25.tar.gz && \
    cd ImageMagick-7.1.2-25 && \
    ./configure && \
    make -j"$(nproc)" && \
    make install && \
    ldconfig && \
    cd .. && \
    rm -rf ImageMagick-7.1.2-25 ImageMagick-7.1.2-25.tar.gz

RUN magick -version  

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
