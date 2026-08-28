#!/bin/zsh
set -euo pipefail

fail=0

node_version=$(node --version 2>/dev/null || echo "none")
if [[ "$node_version" == "none" ]]; then
  echo "FAIL: node not found"
  fail=1
elif [[ "${node_version#v}" < "22" ]]; then
  echo "FAIL: node version $node_version < 22"
  fail=1
else
  echo "PASS: node $node_version"
fi

if command -v pnpm >/dev/null 2>&1; then
  echo "PASS: pnpm $(pnpm --version)"
else
  echo "FAIL: pnpm not found"
  fail=1
fi

if command -v tmux >/dev/null 2>&1; then
  echo "PASS: tmux $(tmux -V)"
else
  echo "FAIL: tmux not found"
  fail=1
fi

if command -v sysadminctl >/dev/null 2>&1; then
  echo "PASS: sysadminctl found"
else
  echo "FAIL: sysadminctl not found (required for workspace user creation)"
  fail=1
fi

if sudo -n true 2>/dev/null; then
  echo "PASS: sudo available without password"
else
  echo "WARN: sudo -n true failed; workspace user creation may require manual password entry"
fi

registry_path="$HOME/.agent-os/registry.json"
if [[ -f "$registry_path" ]]; then
  echo "PASS: $registry_path readable"
  if node -e "JSON.parse(require('fs').readFileSync('$registry_path'))" 2>/dev/null; then
    echo "PASS: $registry_path is valid JSON"
  else
    echo "FAIL: $registry_path is not valid JSON"
    fail=1
  fi
else
  echo "WARN: $registry_path missing (will be created on first agent start)"
fi

config_path="$HOME/.agent-os/config.json"
if [[ -f "$config_path" ]]; then
  echo "PASS: $config_path exists"
else
  echo "FAIL: $config_path missing"
  fail=1
fi

if nc -z localhost 8787 2>/dev/null; then
  echo "PASS: supervisor port 8787 is reachable"
else
  echo "WARN: supervisor port 8787 is not reachable (supervisor may not be running)"
fi

for port in 9100 9101 9102; do
  if nc -z localhost "$port" 2>/dev/null; then
    echo "PASS: agent port $port is reachable"
  else
    echo "WARN: agent port $port is not reachable"
  fi
done

exit $fail
