FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y \
    ca-certificates curl unzip sudo git patch \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -ms /bin/bash agent \
    && echo "agent ALL=(root) NOPASSWD:ALL" > /etc/sudoers.d/agent \
    && chmod 0440 /etc/sudoers.d/agent

ENV BUN_INSTALL=/usr/local/bun
ENV PATH=/usr/local/bun/bin:$PATH
RUN for i in 1 2 3 4 5; do curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.11" && break || sleep 5; done \
    && ln -sf /usr/local/bun/bin/bun /usr/local/bin/bun \
    && ln -sf /usr/local/bun/bin/bun /usr/local/bin/bunx \
    && chmod -R a+rX /usr/local/bun

WORKDIR /app
COPY --chown=agent:agent workspace/ /app/
RUN chown agent:agent /app

USER agent
RUN bun install --frozen-lockfile

# Test-only DOM double used by the trusted verifier to drive overlay/app.ts
# like a browser (window CustomEvents, real button clicks). Never imported by
# the shipped source; the verifier injects its own hidden test files at grading
# time and runs them with this already installed.
RUN bun add -D happy-dom@20.14.0

USER root
