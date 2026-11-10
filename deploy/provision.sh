#!/bin/bash
# One-time setup of the iasp-mcp LXC. Runs as root (tools/deploy.mjs --provision).
# Idempotent: rerunning it changes nothing that is already in place.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  apt-get update -q
  apt-get install -y -q ca-certificates curl gnupg
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q
  apt-get install -y -q nodejs
fi

# better-sqlite3 13 ships no prebuilt binaries, so npm ci compiles it.
# Pandoc, XeLaTeX, qpdf, epubcheck, and Pagella/DejaVu/Noto fonts power the rendering pipeline.
apt-get install -y -q \
  curl build-essential python3 \
  pandoc qpdf epubcheck \
  texlive-xetex texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended \
  tex-gyre fonts-texgyre fonts-dejavu-core fonts-noto-color-emoji fonts-symbola

id iasp >/dev/null 2>&1 || useradd --system --home-dir /var/lib/iasp-mcp --shell /usr/sbin/nologin iasp
install -d -o iasp -g iasp -m 0750 /var/lib/iasp-mcp /var/lib/iasp-mcp/backups /var/lib/iasp-mcp/renders
install -d -m 0755 /opt/iasp-mcp /opt/iasp-mcp/releases /etc/iasp-mcp
if [ ! -f /etc/iasp-mcp/env ]; then
  install -m 0640 -g iasp /dev/null /etc/iasp-mcp/env
  cat > /etc/iasp-mcp/env <<'ENV'
IASP_DB=/var/lib/iasp-mcp/iasp.db
IASP_RENDER_DIR=/var/lib/iasp-mcp/renders
IASP_HOST=0.0.0.0
IASP_PORT=8000
TERMINOLOGY_BASE=http://terminology-mcp.localdomain:8000
IASP_TERMS_SYNC=on
ENV
fi
grep -q '^IASP_RENDER_DIR=' /etc/iasp-mcp/env || echo 'IASP_RENDER_DIR=/var/lib/iasp-mcp/renders' >> /etc/iasp-mcp/env

echo "node=$(node --version)"
echo "pandoc=$(pandoc --version | head -n 1)"
echo "provisioned=$(hostname)"
