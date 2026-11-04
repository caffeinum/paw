FROM node:24.21.0-bookworm-slim

ARG COTAL_VERSION=0.84.0
ARG LEGO_VERSION=5.5.2
ARG LEGO_SHA256=2a35505089e7772c92e1e9ac144df91151ef2eca8568630db0ff91fca06d9bef

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl procps \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL -o /tmp/lego.tgz "https://github.com/go-acme/lego/releases/download/v${LEGO_VERSION}/lego_v${LEGO_VERSION}_linux_amd64.tar.gz" \
 && echo "${LEGO_SHA256}  /tmp/lego.tgz" | sha256sum -c - \
 && tar -xzf /tmp/lego.tgz -C /usr/local/bin lego && rm /tmp/lego.tgz

# cotal-ai pins every @cotal-ai/* dependency to its own exact version; nats-server comes with it.
RUN npm install -g --ignore-scripts "cotal-ai@${COTAL_VERSION}" && cotal --version

# Optional: paw at a pinned caffeinum/paw commit, for the agent-office bridge (README "Office bridge").
# Empty (the default) installs nothing. caffeinum/paw is public, so no build secret is needed.
ARG PAW_REF=""
RUN if [ -n "$PAW_REF" ]; then \
      apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/* \
      && git init -q /opt/paw && cd /opt/paw \
      && git fetch -q --depth 1 https://github.com/caffeinum/paw.git "$PAW_REF" && git checkout -q FETCH_HEAD \
      && npm install -g --ignore-scripts pnpm@11.1.2 \
      && pnpm install --frozen-lockfile --prod --ignore-scripts \
      && rm -rf .git /root/.cache /root/.local/share/pnpm/store \
      && node bin/paw.mjs office --help >/dev/null; \
    fi

COPY start.sh /usr/local/bin/start.sh
COPY office-bridge.sh /usr/local/bin/office-bridge.sh
ENV HOME=/data/home COTAL_NO_PROMPT=1 COTAL_SKIP_CONNECTOR_SEED=1
CMD ["/usr/local/bin/start.sh"]
