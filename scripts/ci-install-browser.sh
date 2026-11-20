#!/usr/bin/env bash
# Installs one Playwright browser engine and its system packages on a CI
# runner: scripts/ci-install-browser.sh webkit|firefox
#
# The system packages come from apt, whose mirror downloads can stall.
# - apt gives up on a stalled connection and retries it itself, instead of
#   hanging until the step's timeout.
# - apt waits for the dpkg lock instead of failing at once.
# - When an attempt is stopped, the apt-get it started (as root, through
#   sudo) is stopped too, and dpkg is left consistent, before the next
#   attempt. Stopping npx alone left that apt-get holding the lock, so every
#   retry failed with "Could not get lock /var/lib/dpkg/lock-frontend".
set -euo pipefail

ENGINE="${1:?usage: ci-install-browser.sh webkit|firefox}"
case "$ENGINE" in
  webkit | firefox | chromium) ;;
  *)
    echo "unknown engine: $ENGINE" >&2
    exit 2
    ;;
esac

sudo tee /etc/apt/apt.conf.d/99-ci-network > /dev/null << 'EOF'
Acquire::Retries "5";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
DPkg::Lock::Timeout "300";
EOF

apt_running() {
  pgrep -x apt-get > /dev/null || pgrep -x apt > /dev/null || pgrep -x dpkg > /dev/null
}

clean_up_apt() {
  # stop the downloads an interrupted attempt left behind; dpkg itself is
  # never killed, it is given time to finish so its database stays whole
  sudo pkill -TERM -x apt-get || true
  for _ in $(seq 1 24); do
    apt_running || break
    sleep 5
  done
  sudo pkill -KILL -x apt-get || true
  sudo dpkg --configure -a || true
}

for attempt in 1 2 3; do
  if timeout --kill-after=30 420 npx playwright-core install-deps "$ENGINE" &&
    timeout --kill-after=30 420 npx playwright-core install "$ENGINE"; then
    exit 0
  fi
  echo "::warning::browser install attempt $attempt failed or stalled"
  clean_up_apt
done
exit 1
