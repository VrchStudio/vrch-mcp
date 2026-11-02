FROM node:22.23.4-bookworm-slim
WORKDIR /app
COPY remote/package.json remote/package-lock.json ./remote/
RUN npm ci --prefix remote --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY remote/*.mjs ./remote/
ARG COMMIT=unknown
LABEL org.opencontainers.image.revision="${COMMIT}"
USER node
ENV VRCH_MCP_PORT=18916 VRCH_MCP_DATA=/data
CMD ["node", "remote/server.mjs"]
