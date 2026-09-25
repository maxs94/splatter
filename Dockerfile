FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js room.js room-worker.js profiler.js accounts.js ./
COPY shared ./shared
COPY bots ./bots
COPY public ./public
RUN mkdir -p data && chown node:node data
ENV PORT=3000
EXPOSE 3000
USER node
CMD ["node", "server.js"]
