FROM node:22.12-bullseye

# ติดตั้ง ffmpeg + python3 + timezone + certs
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./

ENV NODE_ENV=production

# ติดตั้ง dependencies แบบไม่ตรวจ peer/audit
RUN npm install --omit=dev --no-audit --no-fund --legacy-peer-deps

COPY . .

CMD ["npm","start"]
