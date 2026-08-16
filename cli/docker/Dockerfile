FROM oven/bun:1.3.14-debian

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl git jq poppler-utils python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

ARG TECTONIC_VERSION=0.17.0
RUN set -eux; \
    case "$(uname -m)" in \
      x86_64) tectonic_arch=x86_64 ;; \
      aarch64) tectonic_arch=aarch64 ;; \
      *) echo "No Tectonic release for $(uname -m)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/tectonic.tar.gz \
      "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-${tectonic_arch}-unknown-linux-musl.tar.gz"; \
    tar -xzf /tmp/tectonic.tar.gz -C /usr/local/bin tectonic; \
    rm /tmp/tectonic.tar.gz; \
    tectonic --version

WORKDIR /opt/omnisci
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile

COPY skills/omnisci/requirements.txt /tmp/omnisci-requirements.txt
RUN python3 -m venv /opt/omnisci/.venv \
    && /opt/omnisci/.venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/omnisci/.venv/bin/pip install --no-cache-dir -r /tmp/omnisci-requirements.txt

COPY src ./src
COPY tests ./tests
COPY skills ./skills
COPY bin ./bin
COPY docker ./docker

RUN chmod 0755 /opt/omnisci/bin/omnisci /opt/omnisci/bin/credential-env.sh /opt/omnisci/docker/*.sh \
    && install -d -o bun -g bun /home/bun/.omnisci /opt/omnisci/dist /work

ENV PATH="/opt/omnisci/.venv/bin:/opt/omnisci/node_modules/.bin:${PATH}" \
    OMNISCI_ROOT=/opt/omnisci \
    OMNISCI_SKILLS_DIR=/opt/omnisci/skills \
    OMNISCI=/opt/omnisci/skills/omnisci/bin \
    HOME=/home/bun \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

USER bun
WORKDIR /work
ENTRYPOINT ["/opt/omnisci/docker/entrypoint.sh"]
CMD ["/opt/omnisci/bin/omnisci", "-C", "/work"]
