FROM node:20-bookworm

WORKDIR /app

COPY package*.json ./
RUN npm install

# Install Chromium and all required system dependencies
RUN npx playwright install chromium --with-deps

COPY . .

RUN mkdir -p output/screenshots

ENV ANTHROPIC_API_KEY=""
ENV PORT=9786

EXPOSE 9786

CMD ["node", "server.js"]
