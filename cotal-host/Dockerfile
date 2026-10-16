FROM node:24.21.0-bookworm-slim

ARG COTAL_VERSION=0.81.1
ARG LEGO_VERSION=5.5.2
ARG LEGO_SHA256=2a35505089e7772c92e1e9ac144df91151ef2eca8568630db0ff91fca06d9bef

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl procps \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL -o /tmp/lego.tgz "https://github.com/go-acme/lego/releases/download/v${LEGO_VERSION}/lego_v${LEGO_VERSION}_linux_amd64.tar.gz" \
 && echo "${LEGO_SHA256}  /tmp/lego.tgz" | sha256sum -c - \
 && tar -xzf /tmp/lego.tgz -C /usr/local/bin lego && rm /tmp/lego.tgz

# cotal-ai pins every @cotal-ai/* dependency to its own exact version; nats-server comes with it.
RUN npm install -g --ignore-scripts "cotal-ai@${COTAL_VERSION}" && cotal --version

COPY start.sh /usr/local/bin/start.sh
ENV HOME=/data/home COTAL_NO_PROMPT=1 COTAL_SKIP_CONNECTOR_SEED=1
CMD ["/usr/local/bin/start.sh"]
