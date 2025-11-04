FROM node:22.12-bullseye

# ffmpeg + python3 + ตัวชี้ python -> python3 + certs + timezone
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg python3 python-is-python3 ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./

ENV NODE_ENV=production

# ติดตั้ง deps (เลี่ยง audit/peer conf)
RUN npm install --omit=dev --no-audit --no-fund --legacy-peer-deps

COPY . .

CMD ["npm","start"]
