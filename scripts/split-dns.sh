#!/usr/bin/env bash
# split-dns.sh — закрепить домены за DNS-серверами через /etc/resolver
#
# Примеры:
#   sudo ./scripts/split-dns.sh apply  corp.example.com,intranet.local  10.0.0.10 10.0.0.11
#   sudo ./scripts/split-dns.sh clear  corp.example.com,intranet.local
#   sudo ./scripts/split-dns.sh show
#   ./scripts/split-dns.sh capture          # текущие nameserver'ы (без sudo)

set -euo pipefail

cmd="${1:-}"
shift || true

resolver_dir="/etc/resolver"

sanitize_domain() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9.-]//g'
}

parse_list() {
  # "a,b c;d" → строки
  echo "$1" | tr ',;' ' ' | xargs -n1
}

capture() {
  scutil --dns | awk '
    /^resolver #/ { inblock=0 }
    /if_index/ { inblock=1 }
    inblock && /nameserver\[[0-9]+\]/ {
      for (i=1;i<=NF;i++) if ($i ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) print $i
    }
  ' | awk '!seen[$0]++'
}

show() {
  echo "=== /etc/resolver ==="
  if [[ ! -d "$resolver_dir" ]] || [[ -z "$(ls -A "$resolver_dir" 2>/dev/null || true)" ]]; then
    echo "(пусто)"
  else
    for f in "$resolver_dir"/*; do
      echo "--- $(basename "$f") ---"
      cat "$f"
      echo
    done
  fi
  echo "=== scutil nameservers (основной) ==="
  capture || true
}

apply() {
  local domains_raw="${1:-}"
  shift || true
  local servers=("$@")

  if [[ -z "$domains_raw" || ${#servers[@]} -eq 0 ]]; then
    echo "usage: sudo $0 apply <domains> <dns1> [dns2...]" >&2
    echo "  domains: corp.example.com,intranet.local" >&2
    exit 1
  fi

  mkdir -p "$resolver_dir"

  local ns_content=""
  local s
  for s in "${servers[@]}"; do
    ns_content+="nameserver ${s}"$'\n'
  done

  local d clean
  while read -r d; do
    [[ -z "$d" ]] && continue
    clean="$(sanitize_domain "$d")"
    [[ -z "$clean" ]] && continue
    printf '%s' "$ns_content" > "$resolver_dir/$clean"
    echo "ok: $clean → ${servers[*]}"
  done < <(parse_list "$domains_raw")

  dscacheutil -flushcache 2>/dev/null || true
  killall -HUP mDNSResponder 2>/dev/null || true
  echo "готово. проверь: dig +short <host>"
}

clear_domains() {
  local domains_raw="${1:-}"
  if [[ -z "$domains_raw" ]]; then
    echo "usage: sudo $0 clear <domains>" >&2
    exit 1
  fi
  local d clean
  while read -r d; do
    [[ -z "$d" ]] && continue
    clean="$(sanitize_domain "$d")"
    rm -f "$resolver_dir/$clean"
    echo "removed: $clean"
  done < <(parse_list "$domains_raw")
  dscacheutil -flushcache 2>/dev/null || true
  killall -HUP mDNSResponder 2>/dev/null || true
}

case "$cmd" in
  capture) capture ;;
  show)    show ;;
  apply)
    if [[ "$(id -u)" -ne 0 ]]; then echo "нужен sudo" >&2; exit 1; fi
    apply "$@"
    ;;
  clear)
    if [[ "$(id -u)" -ne 0 ]]; then echo "нужен sudo" >&2; exit 1; fi
    clear_domains "$@"
    ;;
  *)
    cat >&2 <<EOF
usage:
  $0 capture
  sudo $0 show
  sudo $0 apply <domains> <dns1> [dns2...]
  sudo $0 clear <domains>

пример (VPN уже up, DNS из capture):
  $0 capture
  sudo $0 apply corp.example.com,intranet.local 10.0.0.10
EOF
    exit 1
    ;;
esac
