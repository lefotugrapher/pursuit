# Pursuit: portable image (dashboard + worker share it). Runs on any x86_64 or ARM64 Linux/Mac/Windows Docker host,
# including a free Oracle Cloud ARM server. Secrets are NOT baked in: .env.local and config/ are mounted at runtime.
FROM node:24-bookworm-slim

ENV NEXT_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1 \
    TZ=Europe/Dublin \
    PURSUIT_BROWSER_CHANNEL=chromium \
    PURSUIT_FORCE_HEADLESS=1 \
    PURSUIT_MASTER_CV=/app/config/cv/Kshitiz_Mittal_CV.tex \
    PURSUIT_CHROME_PROFILE=/app/data/chrome-profile \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tini tzdata fontconfig \
 && rm -rf /var/lib/apt/lists/*

# Tectonic (LaTeX engine for the CVs): pinned upstream release from the official GitHub project.
ARG TECTONIC_VERSION=0.15.0
RUN set -eux; \
    case "$(uname -m)" in \
      x86_64) triple=x86_64-unknown-linux-musl ;; \
      aarch64) triple=aarch64-unknown-linux-musl ;; \
      *) echo "unsupported arch $(uname -m)"; exit 1 ;; \
    esac; \
    curl -fsSL --proto '=https' --tlsv1.2 \
      "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-${triple}.tar.gz" \
      | tar -xz -C /usr/local/bin tectonic; \
    tectonic --version

WORKDIR /app
RUN npm install -g pnpm@11.1.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
# Headless Chromium + its system libraries, matched to the installed playwright-core version.
RUN node_modules/.bin/playwright-core install --with-deps chromium && rm -rf /var/lib/apt/lists/*

COPY . .
RUN node_modules/.bin/next build

# Unprivileged user; data/ and config/ are volumes.
RUN useradd --create-home --uid 10001 pursuit && mkdir -p /app/data && chown -R pursuit:pursuit /app /ms-playwright
USER pursuit
EXPOSE 7020
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node_modules/.bin/next", "start", "-p", "7020"]
