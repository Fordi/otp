#!/usr/bin/bash
mkdir -p pages
# shellcheck disable=SC2016
# shellcheck disable=SC2028
echo '#!/usr/bin/bash
TARGET="${HOME}/.local/opt/otp/otp-test"
echo "const target=\"${TARGET}\"; $(cat)" | tee "${TARGET}" | node --no-warnings=ExperimentalWarning
await (async () => {
  const { readFile, writeFile, chmod, stat } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");

  const { HOME } = process.env;
  const profile = join(HOME, ".profile");
  const INSTALL_PATH = dirname(target);
  const PATH_LINE = `PATH="\${PATH}:${INSTALL_PATH}"`;
  const SHEBANG="#!/usr/bin/env -S node --no-warnings=ExperimentalWarning";
  
  const rc = (await readFile(profile, "utf8")).split("\n");
  const pathIndex = rc.indexOf(PATH_LINE);
  if (pathIndex === -1) {
    rc.push(PATH_LINE);
  }
  await writeFile(profile, rc.join("\n"), "utf8");
  
  let code = (await readFile(target, "utf8")).split("\n");
  code.splice(0, code.findIndex(line => line.startsWith("import")), SHEBANG);
  code.unshift(SHEBANG);
  await writeFile(target, code.join("\n"), "utf8");
  const mode = (await stat(target)).mode;
  await chmod(target, mode | 0o100);
  const PATH = process.env.PATH.split(":").indexOf(INSTALL_PATH);
  if (PATH === -1) {
    console.log(PATH_LINE);
  }
  process.argv.push(target, "--help");
})();' > pages/install
tail +2 otp >> pages/install