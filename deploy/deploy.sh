#!/usr/bin/env bash
# Deploy the NRPC Parcel Report Planner to Cloud Run as a DRAFT service.
#
# Run it from the repo root of a checkout of RTGS-Lab/nrpc-interactive-map:
#
#     cd /home/rtgs/Documents/nrpc/repos/<worktree>
#     ./deploy/deploy.sh                 # build + push + deploy
#     ./deploy/deploy.sh --local         # build + run on localhost:8099 only
#     ./deploy/deploy.sh --dry-run       # print every command, run none
#
# Every setting mirrors the existing pull-parcels service in the same project
# (context/run_services.json in the task dir): europe-west1, port 8080,
# concurrency 80, maxScale 100, the default compute service account, ingress
# all. The differences are deliberate and listed in deploy-plan.md.
#
# NO API KEY IS PASSED. The app takes the Anthropic key and the Google Street
# View key from the browser at runtime; the image build refuses to proceed if a
# key-shaped string is in the context.

set -euo pipefail

PROJECT="${PROJECT:-con000000109891-henn-carbon}"
REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-parcel-planner-draft}"
AR_REPO="${AR_REPO:-cloud-run-source-deploy}"
IMAGE_HOST="${REGION}-docker.pkg.dev"
IMAGE="${IMAGE_HOST}/${PROJECT}/${AR_REPO}/${SERVICE}"
TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || date -u +%Y%m%dT%H%M%SZ)}"
LOCAL_PORT="${LOCAL_PORT:-8099}"

DRY=0
LOCAL_ONLY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --local)   LOCAL_ONLY=1 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done

run() {
  printf '+ %s\n' "$*" >&2
  [ "$DRY" = 1 ] || "$@"
}

# ── Preflight ─────────────────────────────────────────────────────────────
[ -f index.html ] && [ -d js ] \
  || { echo "run this from the repo root (index.html + js/ not found)" >&2; exit 1; }
[ -f deploy/Dockerfile ] \
  || { echo "deploy/Dockerfile not found" >&2; exit 1; }

# .dockerignore must sit at the build-context root or docker will not read it,
# and js/config.js — Bryan's real Google key — would land in the image.
if [ ! -f .dockerignore ]; then
  echo "FATAL: .dockerignore missing at repo root. Copy deploy/.dockerignore" >&2
  echo "       to ./.dockerignore before building; without it js/config.js" >&2
  echo "       (a real Google API key) is baked into the image." >&2
  exit 1
fi
grep -qx 'js/config.js' .dockerignore \
  || { echo "FATAL: .dockerignore does not exclude js/config.js" >&2; exit 1; }

# ── Build ─────────────────────────────────────────────────────────────────
run docker build -f deploy/Dockerfile -t "${SERVICE}:${TAG}" .

# ── Local smoke test ──────────────────────────────────────────────────────
if [ "$DRY" = 0 ]; then
  docker rm -f "${SERVICE}-smoke" >/dev/null 2>&1 || true
  echo "+ smoke test on http://127.0.0.1:${LOCAL_PORT}/" >&2
  docker run -d --rm --name "${SERVICE}-smoke" \
    -p "127.0.0.1:${LOCAL_PORT}:8080" "${SERVICE}:${TAG}" >/dev/null
  for _ in $(seq 1 30); do
    curl -fsS "http://127.0.0.1:${LOCAL_PORT}/healthz" >/dev/null 2>&1 && break
    sleep 0.5
  done
  curl -fsS "http://127.0.0.1:${LOCAL_PORT}/healthz" >/dev/null \
    || { docker logs "${SERVICE}-smoke" >&2; docker rm -f "${SERVICE}-smoke"; exit 1; }
  curl -fsS "http://127.0.0.1:${LOCAL_PORT}/" | grep -q '<title>' \
    || { echo "index.html did not serve" >&2; docker rm -f "${SERVICE}-smoke"; exit 1; }
  # The key check the Dockerfile already made, made again against the running
  # container — belt and braces, because this is the failure that matters.
  if docker exec "${SERVICE}-smoke" grep -rqE 'AIza[0-9A-Za-z_-]{30,}' /usr/share/nginx/html; then
    echo "FATAL: a Google API key is in the running image" >&2
    docker rm -f "${SERVICE}-smoke"; exit 1
  fi
  echo "+ smoke test OK" >&2
  if [ "$LOCAL_ONLY" = 1 ]; then
    echo "container left running at http://127.0.0.1:${LOCAL_PORT}/ (docker rm -f ${SERVICE}-smoke)" >&2
    exit 0
  fi
  docker rm -f "${SERVICE}-smoke" >/dev/null
fi
# Not `[ ... ] && exit 0`: under `set -e` a false test is a failed command and
# would exit the script on the normal path.
if [ "$LOCAL_ONLY" = 1 ]; then exit 0; fi

# ── Push ──────────────────────────────────────────────────────────────────
# One-time per machine; harmless to repeat.
run gcloud auth configure-docker "${IMAGE_HOST}" --quiet --project "${PROJECT}"
run docker tag "${SERVICE}:${TAG}" "${IMAGE}:${TAG}"
run docker tag "${SERVICE}:${TAG}" "${IMAGE}:latest"
run docker push "${IMAGE}:${TAG}"
run docker push "${IMAGE}:latest"

# ── Deploy ────────────────────────────────────────────────────────────────
# --allow-unauthenticated: it is a browser demo with no server-side secret and
# no server-side data. If Bryan wants it behind Google sign-in instead, drop
# this flag and grant run.invoker to named principals. See deploy-plan.md.
run gcloud run deploy "${SERVICE}" \
  --project "${PROJECT}" \
  --region "${REGION}" \
  --image "${IMAGE}:${TAG}" \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --cpu 1 \
  --memory 512Mi \
  --concurrency 80 \
  --min-instances 0 \
  --max-instances 4 \
  --timeout 300 \
  --ingress all \
  --service-account "603040657991-compute@developer.gserviceaccount.com" \
  --labels "draft=true,app=parcel-planner" \
  --set-env-vars "APP_COMMIT=${TAG}" \
  --quiet

if [ "$DRY" = 0 ]; then
  URL=$(gcloud run services describe "${SERVICE}" \
          --project "${PROJECT}" --region "${REGION}" \
          --format 'value(status.url)')
  echo
  echo "DEPLOYED: ${URL}"
  echo "image:    ${IMAGE}:${TAG}"
  curl -fsS -o /dev/null -w 'GET %{url_effective} -> %{http_code}\n' "${URL}/healthz" || true
fi
