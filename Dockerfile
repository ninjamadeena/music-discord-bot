FROM node:22.12-bullseye

# ติดตั้ง ffmpeg + timezone + certs
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./

# ติดตั้ง dependency สำหรับ production เท่านั้น
ENV NODE_ENV=production
RUN npm ci --omit=dev

# คัดลอกซอร์สโค้ดทั้งหมด
COPY . .

# คำสั่งเริ่มรันบอท
CMD ["npm","start"]
