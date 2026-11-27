FROM node:24-slim

# Hugging Face Spaces runs containers as UID 1000
RUN useradd -m -u 1000 user

WORKDIR /app

COPY --chown=user:user package.json package-lock.json ./
COPY --chown=user:user packages ./packages
COPY --chown=user:user projects ./projects
COPY --chown=user:user scripts ./scripts

RUN npm ci --omit=dev && mkdir -p /app/.data && chown -R user:user /app

USER user

ENV NODE_ENV=production
ENV PORT=7860
ENV CLOUD_SINGLE_PORT=true
ENV FINTECH_DATA_DIR=/app/.data

EXPOSE 7860

CMD ["node", "scripts/cloud-server.ts"]
