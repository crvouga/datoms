FROM oven/bun:1.3.4-alpine

RUN apk add --no-cache curl

WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
COPY packages/datoms/package.json packages/datoms/
COPY apps/movie-finder/package.json apps/movie-finder/

RUN bun install --frozen-lockfile

COPY . .

ARG NODE_ENV=production
ARG PORT=3847

ENV NODE_ENV=${NODE_ENV}
ENV PORT=${PORT}

EXPOSE ${PORT}

# Build datoms package + movie-finder frontend (Vite) + serve from Bun server
RUN bun run build

CMD ["bun", "run", "server", "--cwd", "apps/movie-finder"]

