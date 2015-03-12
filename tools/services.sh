#!/bin/bash

# Generate identities and starts daemons for chat app host.
# TODO(nlacasse): Consider re-writing this in Go.

source $VANADIUM_ROOT/release/go/src/v.io/x/ref/cmd/mgmt/shell/lib/shell.sh

trap at_exit INT TERM EXIT

at_exit() {
  # Note: shell::at_exit unsets our trap, so it won't run again on exit.
  shell::at_exit
  shell::kill_child_processes
}

usage() {
  echo "Usage: `basename $0`"
  exit 1
}

main() {
  if [[ $# -ne 0 ]]; then
    usage
  fi

  make vanadium-binaries

  local -r VANADIUM_BIN="${VANADIUM_ROOT}/release/go/bin"

  # Generate a self-signed identity to run identityd as.
  local -r VANADIUM_CREDENTIALS=$(shell::tmp_dir)
  "${VANADIUM_BIN}/principal" seekblessings --veyron.credentials "${VANADIUM_CREDENTIALS}"

  local -r PROXYD_ADDR="localhost:8100"
  local -r MOUNTTABLED_ADDR="localhost:8101"

  "${VANADIUM_BIN}/proxyd" --veyron.namespace.root="/${MOUNTTABLED_ADDR}" \
      --veyron.tcp.address="${PROXYD_ADDR}" \
      --name=proxy \
      --veyron.credentials="${VANADIUM_CREDENTIALS}" \
      --v=1 --alsologtostderr=true &

  "${VANADIUM_BIN}/mounttabled" --veyron.tcp.address="${MOUNTTABLED_ADDR}" \
      --veyron.tcp.protocol=ws \
      --veyron.credentials="${VANADIUM_CREDENTIALS}" \
      --v=1 --alsologtostderr=true &

  # Wait forever.
  sleep infinity
}

main "$@"