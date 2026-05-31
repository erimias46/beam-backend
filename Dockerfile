FROM node:20-alpine

# Non-root user for security (spec 0090 INFRA-4)
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --chown=app:app . .

# Ensure uploads dir exists with correct ownership
RUN mkdir -p uploads && chown app:app uploads

USER app

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:4000/health/ready || exit 1

CMD ["node", "src/app.js"]
