FROM public.ecr.aws/docker/library/debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        gnupg \
        jq \
        patch \
        sudo \
        unzip \
        wget && \
    rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash -u 1000 agent

ENV BUN_INSTALL=/usr/local/bun
ENV PATH=/usr/local/bun/bin:$PATH
RUN for i in 1 2 3 4 5; do curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.11" && break || sleep 5; done && \
    ln -sf /usr/local/bun/bin/bun /usr/local/bin/bun && \
    ln -sf /usr/local/bun/bin/bun /usr/local/bin/bunx

COPY --chown=agent:agent workspace /app
WORKDIR /app

RUN su agent -c 'bun install --frozen-lockfile'

