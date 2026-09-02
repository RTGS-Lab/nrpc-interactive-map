# NRPC Parcel Report Planner — Cloud Run image
#
# The app is a pure static site: index.html + styles.css + js/*.js, every
# dependency loaded from a CDN at runtime (ArcGIS 4.29, JSZip 3.10.1). There is
# no build step and no server-side code, so the image is nginx plus the repo.
#
# NO API KEYS ARE BAKED IN.
#   - Anthropic key (the LLM brief): typed into the panel, kept in that
#     browser's localStorage, POSTed straight to api.anthropic.com.
#     js/parcel-report.js:26 STORAGE_KEY = "nrpc-parcel-report.apiKey".
#   - Google Street View key: same deal — localStorage first
#     (js/main.js:1344 SV_STORAGE_KEY), then window.STREET_VIEW_API_KEY from
#     js/config.js, then ask the user.
# js/config.js is gitignored and holds Bryan's real Google key on his box, so
# .dockerignore excludes it and this stage writes the placeholder version in
# its place. svConfigKey() rejects anything starting with "YOUR_", so the app
# falls through to asking the user — which is what a draft deploy should do.

FROM nginx:1.27-alpine

# nginx:alpine runs every /etc/nginx/templates/*.template through envsubst at
# container start, which is how ${PORT} from Cloud Run reaches the listen
# directive. Only PORT is substituted so nginx's own $uri/$host survive.
ENV NGINX_ENVSUBST_TEMPLATE_SUFFIX=".template"
ENV NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx/conf.d
ENV PORT=8080

COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template

WORKDIR /usr/share/nginx/html
COPY index.html styles.css ./
COPY js/ ./js/

# The key-less config.js. Must land AFTER js/ so it wins if anything slipped
# past .dockerignore.
COPY js/config.example.js ./js/config.js

# Fail the build rather than ship a key. Both checks must pass: config.js is
# still the placeholder, and no credential-shaped string survives anywhere in
# the served tree. (js/main.js:1475 has the literal "AIza…" as an input
# placeholder — an ellipsis, not 30 base64 chars — so the pattern skips it.)
RUN set -eu; \
    grep -q 'YOUR_GOOGLE_STREET_VIEW_API_KEY' js/config.js \
      || { echo "REFUSING TO BUILD: js/config.js is not the placeholder" >&2; exit 1; }; \
    if grep -rqE 'AIza[0-9A-Za-z_-]{30,}|sk-ant-[0-9A-Za-z_-]{20,}' .; then \
      echo "REFUSING TO BUILD: a credential-shaped string is in the image" >&2; exit 1; \
    fi

EXPOSE 8080

# Cloud Run's own health check is a TCP probe on $PORT (see the reference
# service's startupProbe in context/run_services.json), so no HEALTHCHECK here.
CMD ["nginx", "-g", "daemon off;"]
