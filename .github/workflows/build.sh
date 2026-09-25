#!/usr/bin/bash
mkdir -p pages
# shellcheck disable=SC2016
# shellcheck disable=SC2028
(
  cat .github/workflows/install.sh
  # Separate subshell for the compressed part
  (
    # cat .github/workflows/install.js >> pages/install
    # Trap the install script and transform its imports so they don't collide with `otp`
    echo 'await (async () => {'
    echo "process.env.SHEBANG=\"$(head -1 otp)\";"
    # shellcheck disable=SC2312
    sed -E 's/import[[:space:]]+\{[[:space:]]*([^}]+)[[:space:]]*\}[[:space:]]+from[[:space:]]+["'\'']([^"'\''\\]+)["'\'']/const { \1 } = await import("\2")/g' .github/workflows/install.js | sed 's/^/  /'
    echo '})();'
    # shellcheck disable=SC2312
    tail +2 otp
  ) | gzip -9
) > pages/install
cp README.md pages/index.md