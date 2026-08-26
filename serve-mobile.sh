#!/usr/bin/env bash
#
# serve-mobile.sh — serve the NRPC map over HTTPS so a real phone can use
# "Use my location".
#
# Why this exists
# ---------------
# navigator.geolocation is a secure-context API. On the laptop it works over
# http://localhost, because localhost is a secure context by definition. On a
# phone you are not on localhost — you are on http://192.168.x.x, which is
# not — so the browser refuses to hand over a position, and it does not always
# refuse through the geolocation error codes. The mobile build says so in plain
# language ("Location needs a secure connection"), but saying so is not the
# same as testing it.
#
# So: HTTPS on the LAN, with a certificate this script generates.
#
# It will not commit anything. The key and certificate are written to a
# gitignored directory under the repo, regenerated whenever they are missing
# or expired, and never leave the machine.
#
# Usage
#   ./serve-mobile.sh                # serve the repo this script sits beside
#   ./serve-mobile.sh -p 8443        # a different port
#   ./serve-mobile.sh -d /path/to/repo
#
# On the phone
#   1. Same Wi-Fi as this machine.
#   2. Open the https:// URL printed below (scan the QR if qrencode is here).
#   3. The browser will warn that the certificate is not trusted. It is a
#      self-signed certificate for a machine on your own LAN, so accept it —
#      "Advanced" then "Proceed" on Android, "Show Details" then "visit this
#      website" on iOS. You do this once per device.
#      (If mkcert is installed the certificate is trusted on THIS machine, but
#      a phone still needs mkcert's root CA installed to skip the warning.
#      Accepting the warning is the shortcut.)
#   4. Tap "Use my location" and allow the permission prompt.
#
# iOS note: Safari will not offer the permission prompt at all over plain
# http, and it will not offer it outside a user gesture. Both are handled —
# this script gives you https, and the button gives you the gesture.

set -euo pipefail

PORT=8443
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  sed -n '2,45p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--port) PORT="$2"; shift 2 ;;
    -d|--dir)  DIR="$(cd "$2" && pwd)"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage 1 >&2 ;;
  esac
done

if [[ ! -f "$DIR/index.html" ]]; then
  echo "No index.html in $DIR — point -d at the nrpc-interactive-map checkout." >&2
  exit 1
fi

command -v python3 >/dev/null || { echo "python3 is required." >&2; exit 1; }

CERTDIR="$DIR/.dev-certs"
CERT="$CERTDIR/dev.pem"
KEY="$CERTDIR/dev-key.pem"
mkdir -p "$CERTDIR"
chmod 700 "$CERTDIR"

# Keep the keys out of git no matter which branch this is run from. A stray
# certificate in a commit is a bad habit even when the key is worthless.
if ! grep -qs '^\.dev-certs/$' "$DIR/.gitignore" 2>/dev/null; then
  printf '\n# Local HTTPS dev certificates — never commit these.\n.dev-certs/\n' >> "$DIR/.gitignore"
  echo "note: added .dev-certs/ to .gitignore"
fi

# The LAN address the phone must dial. Prefer the route the default gateway
# uses; fall back to hostname -I, which lists them all.
lan_ip() {
  local ip=""
  if command -v ip >/dev/null; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
  fi
  [[ -z "$ip" ]] && ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [[ -z "$ip" ]] && ip="127.0.0.1"
  printf '%s' "$ip"
}

IP="$(lan_ip)"

# Regenerate when missing, unreadable, or expiring within a day.
need_cert=1
if [[ -s "$CERT" && -s "$KEY" ]] && openssl x509 -in "$CERT" -noout -checkend 86400 >/dev/null 2>&1; then
  # Also require the certificate to actually cover the address we will print,
  # or the phone's warning turns into a hard failure on some browsers.
  if openssl x509 -in "$CERT" -noout -text 2>/dev/null | grep -q "IP Address:$IP"; then
    need_cert=0
  fi
fi

if [[ $need_cert -eq 1 ]]; then
  if command -v mkcert >/dev/null; then
    echo "Generating a certificate with mkcert for $IP …"
    mkcert -cert-file "$CERT" -key-file "$KEY" "$IP" localhost 127.0.0.1 ::1 >/dev/null
  else
    command -v openssl >/dev/null || { echo "Need mkcert or openssl to make a certificate." >&2; exit 1; }
    echo "Generating a self-signed certificate for $IP (openssl) …"
    # subjectAltName is not optional: every current browser ignores CN and
    # will refuse a certificate whose SAN does not list the address dialled.
    openssl req -x509 -newkey rsa:2048 -sha256 -days 90 -nodes \
      -keyout "$KEY" -out "$CERT" \
      -subj "/CN=$IP" \
      -addext "subjectAltName=IP:$IP,IP:127.0.0.1,DNS:localhost" >/dev/null 2>&1
  fi
  chmod 600 "$KEY"
fi

URL="https://$IP:$PORT/"

cat <<BANNER

  NRPC map — HTTPS dev server
  ───────────────────────────────────────────────────────────────
  Serving : $DIR
  URL     : $URL
  Cert    : $CERT  (self-signed; accept the warning once per phone)

  Phone-sized harness : ${URL}mobile-harness.html
  Force mobile on any browser : ${URL}?mobile=1

BANNER

if command -v qrencode >/dev/null; then
  qrencode -t ANSIUTF8 "$URL"
  echo
else
  echo "  (install qrencode to get a scannable QR here: apt install qrencode)"
  echo
fi

echo "  Ctrl-C to stop."
echo

# python3's http.server plus ssl. Bound to every interface on purpose — the
# whole point is that another device on the LAN can reach it. Do not leave it
# running on an untrusted network.
exec python3 - "$DIR" "$PORT" "$CERT" "$KEY" <<'PY'
import http.server, os, ssl, sys

directory, port, cert, key = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
os.chdir(directory)


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # No caching: the point of this server is to look at the edit you just
        # made, on a device whose cache you cannot easily clear.
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))


ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(certfile=cert, keyfile=key)

httpd = http.server.ThreadingHTTPServer(("0.0.0.0", port), Handler)
httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
try:
    httpd.serve_forever()
except KeyboardInterrupt:
    print("\n  stopped.")
PY
