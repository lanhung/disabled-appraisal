#!/usr/bin/env bash
set -euo pipefail

if [[ $(id -u) != 0 ]]; then
  printf 'Run this installer as root inside the casdao instance.\n' >&2
  exit 1
fi

release=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
base=/opt/disabled-appraisal
test -x "$base/bin/node"
test -f "$release/dist/analyst.lintsing.net/index.html"
test -d "$release/gemini/node_modules"
for command in nginx supervisorctl openssl setfacl; do command -v "$command" >/dev/null; done

if ! id appraisal >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$base" --shell /usr/sbin/nologin appraisal
fi
install -d -o appraisal -g appraisal -m 750 "$base/logs" "$base/cache" "$base/run"
install -d -o root -g appraisal -m 750 "$base/config"
chown root:appraisal "$base" "$base/bin" "$base/releases"
chmod 750 "$base" "$base/bin" "$base/releases"
# Shared model files are mounted under /root; allow only this service user to traverse it.
setfacl -m u:appraisal:--x /root
previous_model_config=$(sha256sum "$base/config/vllm.yaml" 2>/dev/null | cut -d' ' -f1 || true)

python3 - "$release" <<'PY'
from pathlib import Path
import os, pwd, secrets, sys, yaml

base = Path('/opt/disabled-appraisal')
release = Path(sys.argv[1])
group = pwd.getpwnam('appraisal').pw_gid
key_file = base / 'config/vllm.key'
if not key_file.exists():
    key_file.write_text(secrets.token_urlsafe(36) + '\n')
key = key_file.read_text().strip()
config = yaml.safe_load((release / 'deploy/casdao/vllm.yaml').read_text())
config['api-key'] = key
(base / 'config/vllm.yaml').write_text(yaml.safe_dump(config))
settings = {
    'ASSESSMENT_PROVIDER': 'vllm', 'VLLM_API_KEY': key,
    'VLLM_BASE_URL': 'http://127.0.0.1:8000/v1',
    'VLLM_TEXT_MODEL': config['served-model-name'], 'VLLM_VISION_MODEL': config['served-model-name'],
    'VLLM_TEMPERATURE': '0', 'VLLM_JSON_MODE': 'schema', 'VLLM_MAX_TOKENS': '10000',
    'HOST': '127.0.0.1', 'PORT': '3301', 'LOCAL_HTTP': 'false',
    'SSL_KEY_PATH': str(base / 'config/backend.key'), 'SSL_CERT_PATH': str(base / 'config/backend.crt'),
    'REQUEST_TIMEOUT_MS': '300000', 'ANALYSIS_CONCURRENCY_GLOBAL': '2',
    'ANALYSIS_CONCURRENCY_PER_IP': '2', 'ANALYSIS_BODY_CONCURRENCY_GLOBAL': '2',
    'ANALYSIS_BODY_CONCURRENCY_PER_IP': '2', 'CACHE_TTL_MS': '900000', 'CACHE_CAPACITY': '200',
    'APP_CODE_VERSION': release.name,
}
(base / 'config/backend.env').write_text(''.join(f'{key}={value}\n' for key, value in settings.items()))
for name in ['vllm.key', 'vllm.yaml', 'backend.env']:
    path = base / 'config' / name
    os.chown(path, 0, group)
    os.chmod(path, 0o640)
PY

if [[ ! -f "$base/config/backend.crt" ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
    -subj /CN=localhost -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
    -keyout "$base/config/backend.key" -out "$base/config/backend.crt" 2>/dev/null
fi
chown root:appraisal "$base/config/backend.key" "$base/config/backend.crt"
chmod 640 "$base/config/backend.key" "$base/config/backend.crt"
ln -sfn "$base/config/backend.env" "$release/gemini/.env"
if [[ -d "$base/current/dist/assets" && "$release" != "$(readlink -f "$base/current")" ]]; then
  cp -an "$base/current/dist/assets/." "$release/dist/assets/"
fi
chown -R root:appraisal "$release"
chmod -R g+rX,o-rwx "$release"

ln -sfn "$release" "$base/current.next"
mv -Tf "$base/current.next" "$base/current"
install -o root -g appraisal -m 640 "$release/deploy/casdao/nginx.conf" "$base/config/nginx.conf"
runuser -u appraisal -- /bin/sh "$release/deploy/casdao/start-web.sh" -t
install -o root -g root -m 644 "$release/deploy/casdao/supervisor.conf" /etc/supervisor/conf.d/appraisal.conf
# Replace only the temporary bootstrap config used for the initial model load.
if [[ -f /etc/supervisor/conf.d/appraisal-vllm.conf ]]; then
  rm /etc/supervisor/conf.d/appraisal-vllm.conf
fi
supervisorctl reread
supervisorctl update appraisal-vllm appraisal-backend appraisal-web
current_model_config=$(sha256sum "$base/config/vllm.yaml" | cut -d' ' -f1)
if [[ -n "$previous_model_config" && "$previous_model_config" != "$current_model_config" ]]; then
  supervisorctl restart appraisal-vllm
fi
supervisorctl restart appraisal-backend appraisal-web
supervisorctl status appraisal-vllm appraisal-backend appraisal-web
