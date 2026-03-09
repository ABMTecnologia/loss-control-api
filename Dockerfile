FROM node:20-bookworm-slim AS deps
WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

FROM node:20-bookworm-slim AS build
RUN apt-get update -y && apt-get install -y openssl
WORKDIR /app

ARG DATABASE_URL=postgresql://dummy:dummy@localhost:5432/dummy?schema=public
ENV DATABASE_URL=${DATABASE_URL}

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:20-bookworm-slim AS runner
RUN apt-get update -y && apt-get install -y openssl
WORKDIR /app
ENV NODE_ENV=production

ARG DATABASE_URL=postgresql://dummy:dummy@localhost:5432/dummy?schema=public
ENV DATABASE_URL=${DATABASE_URL}

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev
RUN npx prisma generate

COPY --from=build /app/dist ./dist

EXPOSE 8080
CMD ["npm", "run", "start"]