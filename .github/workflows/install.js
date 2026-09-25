import { readFile, writeFile, chmod, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const { HOME } = process.env;
const profile = join(HOME, ".profile");
const INSTALL_PATH = dirname(target);
const PATH_LINE = `PATH="\${PATH}:${INSTALL_PATH}"`;
let rc = [];
try {
  rc = (await readFile(profile, "utf8")).split("\n");
} catch (e) { }
const pathIndex = rc.indexOf(PATH_LINE);
if (pathIndex === -1) {
  rc.push(PATH_LINE);
}
await writeFile(profile, rc.join("\n"), "utf8");

let code = (await readFile(target, "utf8")).split("\n");
code.splice(0, code.findIndex(line => line.startsWith("import")), process.env.SHEBANG);
await writeFile(target, code.join("\n"), "utf8");
const mode = (await stat(target)).mode;
await chmod(target, mode | 0o100);
const PATH = process.env.PATH.split(":").indexOf(INSTALL_PATH);
if (PATH === -1) {
  console.log(PATH_LINE);
}
process.argv.push(target, "--help");