FROM node:22.12-bullseye

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./

ENV NODE_ENV=production
# ใช้ npm install เพื่อไม่พังเพราะ lockfile ยังไม่อัปเดต
RUN npm install --omit=dev

COPY . .

CMD ["npm","start"]
