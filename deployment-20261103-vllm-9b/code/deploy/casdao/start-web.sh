#!/bin/sh
set -eu

base=/opt/disabled-appraisal
# Casdao assigns a new pod hostname on boot. Nginx resolves it to the pod interface.
pod=$(hostname)
listen_file=$(mktemp "$base/run/vllm-listen.XXXXXX")
trap 'rm -f "$listen_file"' EXIT
printf 'listen %s:8000;\n' "$pod" > "$listen_file"
mv -f "$listen_file" "$base/run/vllm-listen.conf"
exec /usr/sbin/nginx -c "$base/config/nginx.conf" "$@"
