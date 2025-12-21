FROM node:18-alpine

WORKDIR /usr/src/app

COPY package*.json ./

RUN apk add --no-cache python3 make g++

RUN npm ci --only=production

COPY . .

# Create data directory
RUN mkdir -p data

ENV NODE_ENV=production

CMD [ "node", "src/bot.js" ]
