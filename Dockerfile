FROM node:25-slim

RUN apt-get update && apt-get upgrade -y

RUN apt-get clean && \
    rm -rf /var/cache/apt/archives /var/lib/apt/lists/*

USER node

WORKDIR /app

COPY --chown=node:node *.json .
COPY --chown=node:node yarn.lock .

RUN yarn install
COPY --chown=node:node generate-data.ts .

CMD ["yarn", "generate-data"]
