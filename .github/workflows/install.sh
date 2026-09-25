#!/usr/bin/bash
# Bash bootstrap.  Installs node, via nvm, if needed.
TARGET="${TARGET:-${HOME}/.local/opt/otp/otp}"
if ! NODE="$(command -v node)"; then
  if ! NVM="$(command -v nvm)"; then
    # shellcheck disable=SC2312
    wget -qO- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash
    NVM_DIR="${HOME}/.nvm"
    echo "NVM_DIR=\"${NVM_DIR}\""
    echo "source \"\${NVM_DIR}/nvm.sh\""
    # shellcheck disable=SC1091
    . "${NVM_DIR}/nvm.sh"
  fi
  "${NVM}" install --lts stable
  
  NODE="$(command -v node)"
fi
# Secret sauce here.  It consumes `stdin` - which we're getting piped.  So no more bash, just node.
# shellcheck disable=SC2312
echo -n "const target=\"${TARGET}\"; $(gzip -d)" | tee "${TARGET}" | "${NODE}" --no-warnings=ExperimentalWarning
