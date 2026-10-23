# paw + its agents on the team2027 mesh (tls://2027-cotal.fly.dev:4222). Nothing inbound.
FROM debian:bookworm-slim

ARG NODE_VERSION=25.8.2
ARG NVM_VERSION=0.40.8
ARG PNPM_VERSION=11.1.2
ARG GH_VERSION=2.102.0
ARG GH_SHA256=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386
ARG BD_VERSION=1.2.2
ARG BD_SHA256=8140098a51d3b81d5548d1c5e6db1a2d9930e5d141efe2a4bff7d079c4d321e8
# The paw commit to run (deploy.sh passes origin/main's sha, which also busts the clone cache).
ARG PAW_REF=main

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git procps tmux build-essential python3 jq ripgrep less vim-tiny \
      openssh-client sudo locales \
 && rm -rf /var/lib/apt/lists/* \
 && sed -i 's/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen

RUN curl -fsSL -o /tmp/gh.tgz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
 && echo "${GH_SHA256}  /tmp/gh.tgz" | sha256sum -c - \
 && tar -xzf /tmp/gh.tgz -C /tmp && mv "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh && rm -rf /tmp/gh* \
 && curl -fsSL -o /tmp/bd.tgz "https://github.com/steveyegge/beads/releases/download/v${BD_VERSION}/beads_${BD_VERSION}_linux_amd64.tar.gz" \
 && echo "${BD_SHA256}  /tmp/bd.tgz" | sha256sum -c - \
 && tar -xzf /tmp/bd.tgz -C /tmp && mv /tmp/bd /usr/local/bin/bd && rm -rf /tmp/bd* \
 && gh --version && bd version

# node from nvm (never a distro/brew node), same version as the operator's Mac.
ENV NVM_DIR=/opt/nvm
RUN mkdir -p "$NVM_DIR" \
 && curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/v${NVM_VERSION}/install.sh" | PROFILE=/dev/null bash \
 && . "$NVM_DIR/nvm.sh" && nvm install "$NODE_VERSION" && nvm alias default "$NODE_VERSION" \
 && ln -s "$NVM_DIR/versions/node/v${NODE_VERSION}" /opt/node \
 && /opt/node/bin/npm install -g --ignore-scripts "pnpm@${PNPM_VERSION}" && /opt/node/bin/pnpm --version
ENV PATH=/opt/node/bin:$PATH

# Everything runs as root (a throwaway sandbox): IS_SANDBOX=1 lets claude bypassPermissions as root.
# root's HOME on the volume keeps ~/.claude (the Max login), ~/.kit (kit auth), ~/.paw and the
# transcripts across deploys.
RUN sed -i "s#^root:x:0:0:root:/root:#root:x:0:0:root:/data/home:#" /etc/passwd && grep -q "^root:x:0:0:root:/data/home:" /etc/passwd

# Claude Code via the official installer, then pinned into the image (updates ship with a rebuild).
RUN HOME=/opt/claude-install bash -c 'curl -fsSL https://claude.ai/install.sh | bash' \
 && cp -L /opt/claude-install/.local/bin/claude /usr/local/bin/claude && rm -rf /opt/claude-install \
 && claude --version

# kit: cross-compiled on the Mac by deploy.sh from ~/Github/caffeinum/kit (a private repo).
COPY bin/kit /usr/local/bin/kit
RUN kit --help >/dev/null 2>&1 || kit help >/dev/null 2>&1 || { echo "kit binary does not run" >&2; exit 1; }

RUN git clone --filter=blob:none https://github.com/caffeinum/paw.git /opt/paw \
 && cd /opt/paw && git checkout --detach "$PAW_REF" \
 && pnpm install --frozen-lockfile --ignore-scripts
COPY paw /usr/local/bin/paw
COPY start.sh boot.sh /usr/local/bin/
COPY profile.sh /etc/profile.d/paw.sh

ENV LANG=en_US.UTF-8 \
    HOME=/data/home \
    IS_SANDBOX=1 \
    PAW_HOME=/data/home/.paw \
    PAW_SPACE=team2027 \
    PAW_RUNTIME=pty \
    PAW_ALLOW_ANY_CWD=1 \
    KIT_BIN=/usr/local/bin/kit \
    DISABLE_AUTOUPDATER=1
CMD ["/usr/local/bin/start.sh"]
