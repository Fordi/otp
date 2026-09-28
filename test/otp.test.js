import { deepEqual, equal, ok, rejects, throws } from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as otp from "../otp";

describe("parseArgs", () => {
  it("parses an argument list and environment", async () => {
    const commands = await otp.parseArgs(["-cs", "code", "npm"], {});
    deepEqual(commands, [
      ["code", "npm", undefined, { clipboard: true, stdout: false }],
    ]);
  });

  it("defaults to list with no args", async () => {
    const commands = await otp.parseArgs([]);
    equal(commands.length, 1);
    equal(commands[0][0], "list");
  });

  it("parses add with name and url, resetting flags after", async () => {
    const commands = await otp.parseArgs([
      "-c",
      "add",
      "npm",
      "otpauth://totp/npm?secret=AAAA",
      "code",
      "npm",
    ]);
    equal(commands.length, 2);
    deepEqual(commands[0].slice(0, 3), [
      "add",
      "npm",
      "otpauth://totp/npm?secret=AAAA",
    ]);
    ok(commands[0][3].clipboard);
  });

  it("parses long flags --clip and --stdout", async () => {
    const original = process.stdout.isTTY;
    process.stdout.isTTY = false;
    try {
      const commands = await otp.parseArgs([
        "--clip",
        "--stdout",
        "code",
        "x",
      ]);
      ok(commands[0][3].clipboard);
      ok(!commands[0][3].stdout);
    } finally {
      process.stdout.isTTY = original;
    }
  });

  it("parses --verbose and -v as counters", async () => {
    const commands = await otp.parseArgs(["-vv", "code", "x"]);
    equal(commands[0][3].verbose, 2);
  });

  it("parses --home and -H", async () => {
    const commands = await otp.parseArgs(["--home", "/tmp/x", "code", "y"]);
    equal(commands[0][3].home, "/tmp/x");
  });

  it("throws when -H is not the last shorthand flag", async () => {
    await rejects(() => otp.parseArgs(["-Hc", "/tmp/x", "code", "y"]));
  });

  it("parses -H as the last shorthand flag", async () => {
    const commands = await otp.parseArgs(["-cH", "/tmp/x", "code", "y"]);
    equal(commands[0][3].home, "/tmp/x");
    ok(commands[0][3].clipboard);
  });

  it("parses --verbose as a long flag counter", async () => {
    const commands = await otp.parseArgs(["--verbose", "code", "x"]);
    equal(commands[0][3].verbose, 1);
  });

  it("calls update() on -u and --update", async (t) => {
    t.mock.method(process, "exit", () => {
      throw new Error("exit");
    });
    t.mock.method(globalThis, "fetch", async () => ({ body: "" }));
    const originalArgv1 = process.argv[1];
    process.argv[1] = "/tmp/otp-update-test";
    try {
      await rejects(() => otp.parseArgs(["-u"]), /exit/);
      await rejects(() => otp.parseArgs(["--update"]), /exit/);
    } finally {
      process.argv[1] = originalArgv1;
    }
  });

  it("treats a bare value as an implicit command", async () => {
    const commands = await otp.parseArgs(["myservice"]);
    deepEqual(commands[0].slice(0, 2), ["implicit", "myservice"]);
  });

  it("calls usage(1) on unknown long flag", async (t) => {
    t.mock.method(process, "exit", () => {
      throw new Error("exit");
    });
    const write = t.mock.method(process.stderr, "write", () => true);
    await rejects(() => otp.parseArgs(["--bogus"]), /exit/);
    ok(write.mock.calls[0].arguments[0].includes("Unknown flag: --bogus"));
    equal(process.exit.mock.calls[0].arguments[0], 1);
  });

  it("calls usage(1) on unknown short flag", async (t) => {
    t.mock.method(process, "exit", () => {
      throw new Error("exit");
    });
    t.mock.method(process.stderr, "write", () => true);
    await rejects(() => otp.parseArgs(["-z", "code", "x"]), /exit/);
    equal(process.exit.mock.calls[0].arguments[0], 1);
  });

  it("calls usage() on -h and --help", async (t) => {
    t.mock.method(process, "exit", () => {
      throw new Error("exit");
    });
    t.mock.method(process.stderr, "write", () => true);
    await rejects(() => otp.parseArgs(["-h"]), /exit/);
    equal(process.exit.mock.calls[0].arguments[0], 0);
    await rejects(() => otp.parseArgs(["--help"]), /exit/);
    equal(process.exit.mock.calls[1].arguments[0], 0);
  });

});

describe("flagsDefault", () => {
  it("defaults to stdout when not a tty", () => {
    const original = process.stdout.isTTY;
    process.stdout.isTTY = false;
    try {
      deepEqual(otp.flagsDefault(), { stdout: true });
    } finally {
      process.stdout.isTTY = original;
    }
  });

  it("defaults to clipboard when a tty", () => {
    const original = process.stdout.isTTY;
    process.stdout.isTTY = true;
    try {
      deepEqual(otp.flagsDefault(), { clipboard: true });
    } finally {
      process.stdout.isTTY = original;
    }
  });
});

describe("update", () => {
  it("fetches the script and overwrites argv[1], then exits", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    const file = join(dir, "otp-copy.js");
    const originalArgv1 = process.argv[1];
    process.argv[1] = file;
    t.mock.method(process, "exit", () => {
      throw new Error("exit");
    });
    t.mock.method(globalThis, "fetch", async () => ({
      body: Buffer.from("#!/usr/bin/env node\n"),
    }));
    try {
      await rejects(() => otp.update(), /exit/);
      const { readFileSync } = await import("node:fs");
      equal(readFileSync(file, "utf8"), "#!/usr/bin/env node\n");
    } finally {
      process.argv[1] = originalArgv1;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fromBase32 / toBase64 / fromBase64", () => {
  it("decodes a known base32 string to the RFC 4226 seed bytes", () => {
    const decoded = otp.fromBase32("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    equal(Buffer.from(decoded).toString("ascii"), "12345678901234567890");
  });

  it("returns undefined/falsy for empty input", () => {
    ok(!otp.fromBase32(""));
  });

  it("validates base32 strings with .is", () => {
    ok(otp.fromBase32.is("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"));
    ok(!otp.fromBase32.is("not-valid-base32!!"));
    ok(!otp.fromBase32.is(12345));
    ok(!otp.fromBase32.is("SHORT"));
  });

  it("generates random base32 strings of the expected shape", () => {
    const r = otp.fromBase32.random(2);
    equal(typeof r, "string");
    ok(otp.fromBase32.rx.test(r));
    equal(r.length % 8, 0);
  });

  it("round-trips arbitrary bytes through toBase64/fromBase64", () => {
    const bytes = otp.getRandomValues(new Uint8Array(20));
    const encoded = otp.toBase64(bytes);
    const decoded = otp.fromBase64(encoded);
    deepEqual(new Uint8Array(decoded), bytes);
  });
});

describe("padCounter", () => {
  it("pads a small counter to 8 bytes big-endian", () => {
    const arr = otp.padCounter(1);
    equal(arr.length, 8);
    deepEqual(Array.from(arr), [0, 0, 0, 0, 0, 0, 0, 1]);
  });

  it("handles counter 0", () => {
    deepEqual(Array.from(otp.padCounter(0)), [0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("handles a large counter value", () => {
    const arr = otp.padCounter(0x01020304);
    deepEqual(Array.from(arr), [0, 0, 0, 0, 1, 2, 3, 4]);
  });
});

describe("isOtpUrl", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it("accepts valid totp and hotp URLs", () => {
    ok(otp.isOtpUrl(`otpauth://totp/test?secret=${secret}`));
    ok(otp.isOtpUrl(`otpauth://hotp/test?secret=${secret}&counter=5`));
    ok(otp.isOtpUrl(new URL(`otpauth://totp/test?secret=${secret}`)));
  });

  it("rejects strings that aren't URLs", () => {
    ok(!otp.isOtpUrl("not a url"));
  });

  it("rejects hostnames other than totp/hotp", () => {
    ok(!otp.isOtpUrl(`otpauth://foo/test?secret=${secret}`));
  });

  it("rejects protocols other than otpauth:", () => {
    ok(!otp.isOtpUrl(`https://totp/test?secret=${secret}`));
    ok(!otp.isOtpUrl(`otpauth-migration://totp/test?secret=${secret}`));
  });

  it("rejects a missing or empty secret", () => {
    ok(!otp.isOtpUrl("otpauth://totp/test"));
    ok(!otp.isOtpUrl("otpauth://totp/test?secret="));
  });

  it("rejects a secret that isn't valid base32", () => {
    ok(!otp.isOtpUrl("otpauth://totp/test?secret=not-valid!!"));
  });

  it("rejects a non-numeric or zero digits", () => {
    ok(!otp.isOtpUrl(`otpauth://totp/test?secret=${secret}&digits=abc`));
    ok(!otp.isOtpUrl(`otpauth://totp/test?secret=${secret}&digits=0`));
  });

  it("accepts a valid digits value", () => {
    ok(otp.isOtpUrl(`otpauth://totp/test?secret=${secret}&digits=8`));
  });

  it("rejects an unsupported algorithm", () => {
    ok(!otp.isOtpUrl(`otpauth://totp/test?secret=${secret}&algorithm=md5`));
  });

  it("accepts supported algorithms", () => {
    ok(otp.isOtpUrl(`otpauth://totp/test?secret=${secret}&algorithm=SHA256`));
  });

  it("rejects a non-numeric totp period", () => {
    ok(!otp.isOtpUrl(`otpauth://totp/test?secret=${secret}&period=abc`));
  });

  it("rejects a non-numeric hotp counter", () => {
    ok(!otp.isOtpUrl(`otpauth://hotp/test?secret=${secret}&counter=abc`));
  });

  it("rejects period on hotp and counter on totp", () => {
    ok(!otp.isOtpUrl(`otpauth://hotp/test?secret=${secret}&period=30`));
    ok(!otp.isOtpUrl(`otpauth://totp/test?secret=${secret}&counter=5`));
  });
});

describe("otp() - RFC test vectors", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it("matches RFC 4226 HOTP vectors", async () => {
    equal(
      await otp.otp(`otpauth://hotp/test?secret=${secret}&counter=0`),
      "755224",
    );
    equal(
      await otp.otp(`otpauth://hotp/test?secret=${secret}&counter=1`),
      "287082",
    );
  });

  it("matches RFC 6238 TOTP vector at T=59 with 8 digits", async (t) => {
    t.mock.method(Date, "now", () => 59 * 1000);
    const code = await otp.otp(
      `otpauth://totp/test?secret=${secret}&digits=8&period=30`,
    );
    equal(code, "94287082");
  });

  it("accepts a URL instance directly", async () => {
    const url = new URL(`otpauth://hotp/test?secret=${secret}&counter=0`);
    equal(await otp.otp(url), "755224");
  });

  it("defaults digits to 6 and counter to 0", async () => {
    const code = await otp.otp(`otpauth://hotp/test?secret=${secret}`);
    equal(code, "755224");
  });

  it("supports sha256 and sha512 algorithms", async () => {
    const code256 = await otp.otp(
      `otpauth://hotp/test?secret=${secret}&counter=0&algorithm=sha256`,
    );
    const code512 = await otp.otp(
      `otpauth://hotp/test?secret=${secret}&counter=0&algorithm=sha512`,
    );
    equal(code256.length, 6);
    equal(code512.length, 6);
    ok(code256 !== code512);
  });

  it("rejects an unsupported algorithm", async () => {
    await rejects(() =>
      otp.otp(`otpauth://hotp/test?secret=${secret}&counter=0&algorithm=md5`),
    );
  });
});

describe("encrypt / decrypt", () => {
  it("round-trips a payload with the correct key", async () => {
    const key = otp.getRandomValues(new Uint8Array(32));
    const plaintext = otp.encode("hello world");
    const cipher = await otp.encrypt(key, plaintext);
    const result = await otp.decrypt(key, cipher);
    equal(otp.decode(result), "hello world");
  });

  it("returns undefined when no iv is present", async () => {
    const key = otp.getRandomValues(new Uint8Array(32));
    equal(await otp.decrypt(key, undefined), undefined);
    equal(await otp.decrypt(key), undefined);
  });

  it("fails to decrypt with the wrong key", async () => {
    const key = otp.getRandomValues(new Uint8Array(32));
    const wrongKey = otp.getRandomValues(new Uint8Array(32));
    const cipher = await otp.encrypt(key, otp.encode("secret"));
    await rejects(() => otp.decrypt(wrongKey, cipher));
  });
});

describe("getUserHash", () => {
  it("is deterministic for the same inputs", async () => {
    const a = await otp.getUserHash("alice", 1000);
    const b = await otp.getUserHash("alice", 1000);
    deepEqual(new Uint8Array(a), new Uint8Array(b));
  });

  it("differs for different inputs", async () => {
    const a = await otp.getUserHash("alice", 1000);
    const b = await otp.getUserHash("bob", 1000);
    ok(Buffer.from(a).toString("hex") !== Buffer.from(b).toString("hex"));
  });
});

describe("urlFromSecret", () => {
  it("builds a totp URL carrying the secret", () => {
    const url = otp.urlFromSecret("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    ok(url instanceof URL);
    equal(url.protocol, "otpauth:");
    equal(url.hostname, "totp");
    equal(url.searchParams.get("secret"), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });
});

describe("clip", () => {
  it("invokes xclip and returns its spawnSync result", () => {
    const result = otp.clip("123456");
    equal(typeof result.status, "number");
  });

  it("passes the expected argv and input to spawnSync", (t) => {
    const spawnSync = t.mock.method(otp.proc, "spawnSync", () => ({
      status: 0,
    }));
    otp.clip("123456");
    equal(spawnSync.mock.calls.length, 1);
    const [cmd, args, opts] = spawnSync.mock.calls[0].arguments;
    equal(cmd, "xclip");
    deepEqual(args, ["-selection", "clipboard"]);
    equal(opts.input, "123456");
  });
});

describe("SecretServiceSecret", () => {
  it("reads via `secret-tool lookup` with flattened attributes", async (t) => {
    const spawnSync = t.mock.method(otp.proc, "spawnSync", () => ({
      status: 0,
      stdout: Buffer.from("hello").toString("base64url"),
    }));
    const s = new otp.SecretServiceSecret(
      { domain: "org.fordi.otp", user: "alice" },
      "label",
    );
    const result = await s.read();
    equal(spawnSync.mock.calls.length, 1);
    const [cmd, args, opts] = spawnSync.mock.calls[0].arguments;
    equal(cmd, "secret-tool");
    deepEqual(args, ["lookup", "domain", "org.fordi.otp", "user", "alice"]);
    equal(opts.encoding, "utf8");
    equal(otp.decode(result), "hello");
  });

  it("writes via `secret-tool store` with label and attributes", async (t) => {
    const spawnSync = t.mock.method(otp.proc, "spawnSync", () => ({
      status: 0,
    }));
    const s = new otp.SecretServiceSecret(
      { domain: "org.fordi.otp", user: "alice" },
      "my label",
    );
    await s.write(otp.encode("hello"));
    equal(spawnSync.mock.calls.length, 1);
    const [cmd, args, opts] = spawnSync.mock.calls[0].arguments;
    equal(cmd, "secret-tool");
    deepEqual(args, [
      "store",
      `--label="my label"`,
      "domain",
      "org.fordi.otp",
      "user",
      "alice",
    ]);
    equal(opts.encoding, "utf8");
    equal(opts.input, Buffer.from(otp.encode("hello")).toString("base64url"));
  });

  it("drops undefined/null attributes and rejects non-scalar ones", () => {
    const s = new otp.SecretServiceSecret(
      { domain: "org.fordi.otp", skip: undefined, alsoSkip: null },
      "label",
    );
    equal(s instanceof otp.SecretServiceSecret, true);
    throws(() => new otp.SecretServiceSecret({ bad: { nested: true } }, "l"));
  });

  it("throws ENOENT when secret-tool lookup fails", async (t) => {
    t.mock.method(otp.proc, "spawnSync", () => ({ status: 1 }));
    const s = new otp.SecretServiceSecret({ domain: "x" }, "label");
    await rejects(() => s.read(), { code: "ENOENT" });
  });

  it("throws a descriptive error when secret-tool store fails", async (t) => {
    t.mock.method(otp.proc, "spawnSync", () => ({ status: 1 }));
    const s = new otp.SecretServiceSecret(
      { domain: "org.fordi.otp", user: "alice" },
      "my label",
    );
    await rejects(() => s.write(otp.encode("hello")), (e) => {
      ok(e instanceof Error);
      ok(e.message.includes('Couldn\'t write secret "my label"'));
      ok(e.message.includes('domain="org.fordi.otp"'));
      ok(e.message.includes('user="alice"'));
      return true;
    });
  });
});

describe("WindowsSecureStringSecret", () => {
  it("reads via powershell Import-CliXml with the given path", async (t) => {
    const spawnSync = t.mock.method(otp.proc, "spawnSync", () => ({
      status: 0,
      stdout: Buffer.from("hello").toString("base64url"),
    }));
    const s = new otp.WindowsSecureStringSecret("C:\\creds.xml");
    const result = await s.read();
    equal(spawnSync.mock.calls.length, 1);
    const [cmd, args] = spawnSync.mock.calls[0].arguments;
    equal(cmd, "powershell");
    equal(args[0], "-NoProfile");
    equal(args[1], "-Command");
    ok(args[2].includes('Import-CliXml -Path "C:\\\\creds.xml"'));
    ok(args[2].includes("ConvertFrom-SecureString -AsPlainText"));
    equal(otp.decode(result), "hello");
  });

  it("writes via powershell ConvertTo-SecureString/Export-CliXml", async (t) => {
    const spawnSync = t.mock.method(otp.proc, "spawnSync", () => ({
      status: 0,
    }));
    const s = new otp.WindowsSecureStringSecret("C:\\creds.xml");
    await s.write(otp.encode("hello"));
    equal(spawnSync.mock.calls.length, 1);
    const [cmd, args] = spawnSync.mock.calls[0].arguments;
    equal(cmd, "powershell");
    ok(args[2].includes("ConvertTo-SecureString -AsPlainText -Force"));
    ok(args[2].includes('Export-CliXml -Path "C:\\\\creds.xml"'));
    ok(
      args[2].includes(
        JSON.stringify(Buffer.from(otp.encode("hello")).toString("base64url")),
      ),
    );
  });

  it("throws ENOENT when powershell read fails", async (t) => {
    t.mock.method(otp.proc, "spawnSync", () => ({ status: 1 }));
    const s = new otp.WindowsSecureStringSecret("C:\\creds.xml");
    await rejects(() => s.read(), { code: "ENOENT" });
  });

  it("throws when powershell write fails", async (t) => {
    t.mock.method(otp.proc, "spawnSync", () => ({ status: 1 }));
    const s = new otp.WindowsSecureStringSecret("C:\\creds.xml");
    await rejects(() => s.write(otp.encode("hello")));
  });
});

describe("logAndClipCode", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const url = `otpauth://hotp/test?secret=${secret}&counter=0`;

  it("logs to stdout when flags.stdout is set", async (t) => {
    const log = t.mock.method(console, "log", () => {});
    await otp.logAndClipCode(url, { stdout: true, clipboard: false });
    equal(log.mock.calls.length, 1);
    equal(log.mock.calls[0].arguments[0], "755224");
  });

  it("copies to clipboard when flags.clipboard is set", async () => {
    const result = await otp.logAndClipCode(url, {
      stdout: false,
      clipboard: true,
    });
    equal(result, undefined);
  });

  it("accepts a URL instance", async (t) => {
    const log = t.mock.method(console, "log", () => {});
    await otp.logAndClipCode(new URL(url), { stdout: true, clipboard: false });
    equal(log.mock.calls[0].arguments[0], "755224");
  });
});

describe("BinarySecret", () => {
  it("round-trips a written secret through read()", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    const file = join(dir, "secret.bin");
    try {
      const bs = new otp.BinarySecret(file, "testuser", 1000);
      const original = otp.getRandomValues(new Uint8Array(32));
      await bs.write(original);
      const result = await bs.read();
      deepEqual(new Uint8Array(result), original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a string secret on write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    const file = join(dir, "secret.bin");
    try {
      const bs = new otp.BinarySecret(file, "testuser", 1000);
      await bs.write("a string secret");
      const result = await bs.read();
      equal(otp.decode(result), "a string secret");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SecretManager", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const makeEnv = (home) => ({
    XDG_SESSION_TYPE: "tty",
    USER: "tester",
    UID: 1000,
    HOME: home,
  });

  it("stores, gets and lists OTP URLs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const flags = { home: join(dir, "local") };
      const store = new otp.SecretManager("org.fordi.otp", makeEnv(dir), flags);
      const url = `otpauth://totp/svc?secret=${secret}`;
      await store.set("svc", url);
      equal(await store.get("svc"), url);
      deepEqual(await store.list(), ["svc"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for a missing key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const flags = { home: join(dir, "local") };
      const store = new otp.SecretManager("org.fordi.otp", makeEnv(dir), flags);
      equal(await store.get("nope"), "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derives a default home directory from USER when HOME is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const flags = { home: join(dir, "local") };
      const env = { XDG_SESSION_TYPE: "tty", USER: "tester", UID: 1000 };
      const store = new otp.SecretManager("org.fordi.otp", env, flags);
      deepEqual(await store.list(), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logs verbose output when verbose flag is set", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const write = t.mock.method(process.stderr, "write", () => true);
      const flags = { home: join(dir, "local"), verbose: true };
      new otp.SecretManager("org.fordi.otp", makeEnv(dir), flags);
      ok(write.mock.calls[0].arguments[0].includes("BinarySecret"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses BinarySecret in a tty session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const flags = { home: join(dir, "local") };
      const store = new otp.SecretManager("org.fordi.otp", makeEnv(dir), flags);
      ok(store.secretService instanceof otp.BinarySecret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses SecretServiceSecret when a session is non-tty with dbus", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const flags = { home: join(dir, "local") };
      const env = {
        XDG_SESSION_TYPE: "x11",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        USER: "tester",
        UID: 1000,
        HOME: dir,
      };
      const store = new otp.SecretManager("org.fordi.otp", env, flags);
      ok(store.secretService instanceof otp.SecretServiceSecret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logs verbose output when using SecretServiceSecret", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const write = t.mock.method(process.stderr, "write", () => true);
      const flags = { home: join(dir, "local"), verbose: true };
      const env = {
        XDG_SESSION_TYPE: "x11",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        USER: "tester",
        UID: 1000,
        HOME: dir,
      };
      new otp.SecretManager("org.fordi.otp", env, flags);
      ok(write.mock.calls[0].arguments[0].includes("Using SecretService"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses WindowsSecureStringSecret when non-tty without dbus", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const flags = { home: join(dir, "local") };
      const env = {
        XDG_SESSION_TYPE: "x11",
        DBUS_SESSION_BUS_ADDRESS: undefined,
        USER: "tester",
        UID: 1000,
        HOME: dir,
      };
      const store = new otp.SecretManager("org.fordi.otp", env, flags);
      ok(store.secretService instanceof otp.WindowsSecureStringSecret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logs verbose output when using WindowsSecureStringSecret", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const write = t.mock.method(process.stderr, "write", () => true);
      const flags = { home: join(dir, "local"), verbose: true };
      const env = {
        XDG_SESSION_TYPE: "x11",
        DBUS_SESSION_BUS_ADDRESS: undefined,
        USER: "tester",
        UID: 1000,
        HOME: dir,
      };
      new otp.SecretManager("org.fordi.otp", env, flags);
      ok(
        write.mock.calls[0].arguments[0].includes(
          "Using WindowsSecureString",
        ),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("main", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const makeEnv = (dir) => ({
    XDG_SESSION_TYPE: "tty",
    USER: "tester",
    UID: 1000,
    HOME: dir,
  });

  const withTmpDir = async (fn) => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("adds an OTP by URL, then generates a code for it", async (t) => {
    await withTmpDir(async (dir) => {
      const log = t.mock.method(console, "log", () => {});
      const env = makeEnv(dir);
      await otp.main(
        ["--home", dir, "add", "svc", `otpauth://totp/svc?secret=${secret}`],
        env,
      );
      ok(log.mock.calls[0].arguments[0].includes("Stored svc"));

      log.mock.resetCalls();
      await otp.main(["--home", dir, "code", "svc"], env);
      equal(log.mock.calls.length, 1);
      equal(typeof log.mock.calls[0].arguments[0], "string");
    });
  });

  it("adds a bare base32 secret when the value isn't a URL", async (t) => {
    await withTmpDir(async (dir) => {
      t.mock.method(console, "log", () => {});
      const env = makeEnv(dir);
      await otp.main(["--home", dir, "add", "svc", secret], env);
      const flags = { home: dir };
      const store = new otp.SecretManager("org.fordi.otp", env, flags);
      const stored = await store.get("svc");
      ok(stored.startsWith("otpauth://totp/"));
    });
  });

  it("calls usage(1) when add value is neither a URL nor base32", async (t) => {
    await withTmpDir(async (dir) => {
      t.mock.method(process, "exit", () => {
        throw new Error("exit");
      });
      t.mock.method(process.stderr, "write", () => true);
      const env = makeEnv(dir);
      await rejects(
        () => otp.main(["--home", dir, "add", "svc", "not a url or secret"], env),
        /exit/,
      );
      equal(process.exit.mock.calls[0].arguments[0], 1);
    });
  });

  it("calls usage(1) when add value is a URL but not a valid OTP URL", async (t) => {
    await withTmpDir(async (dir) => {
      t.mock.method(process, "exit", () => {
        throw new Error("exit");
      });
      t.mock.method(process.stderr, "write", () => true);
      const env = makeEnv(dir);
      await rejects(
        () =>
          otp.main(
            ["--home", dir, "add", "svc", "otpauth://totp/svc"],
            env,
          ),
        /exit/,
      );
      equal(process.exit.mock.calls[0].arguments[0], 1);
    });
  });

  it("generates a code directly from a bare base32 secret", async (t) => {
    await withTmpDir(async (dir) => {
      const log = t.mock.method(console, "log", () => {});
      const env = makeEnv(dir);
      await otp.main(["--home", dir, "code", secret], env);
      equal(log.mock.calls.length, 1);
      equal(typeof log.mock.calls[0].arguments[0], "string");
    });
  });

  it("generates a code directly from a full OTP URL without storing it", async (t) => {
    await withTmpDir(async (dir) => {
      const log = t.mock.method(console, "log", () => {});
      const env = makeEnv(dir);
      await otp.main(
        ["--home", dir, "code", `otpauth://hotp/svc?secret=${secret}&counter=0`],
        env,
      );
      equal(log.mock.calls.length, 1);
      equal(log.mock.calls[0].arguments[0], "755224");

      const flags = { home: dir };
      const store = new otp.SecretManager("org.fordi.otp", env, flags);
      deepEqual(await store.list(), []);
    });
  });

  it("calls usage(1) when the named code doesn't exist", async (t) => {
    await withTmpDir(async (dir) => {
      t.mock.method(process, "exit", () => {
        throw new Error("exit");
      });
      t.mock.method(process.stderr, "write", () => true);
      const env = makeEnv(dir);
      await rejects(
        () => otp.main(["--home", dir, "code", "missing"], env),
        /exit/,
      );
      equal(process.exit.mock.calls[0].arguments[0], 1);
    });
  });

  it("lists stored OTP names, or a message when empty", async (t) => {
    await withTmpDir(async (dir) => {
      const log = t.mock.method(console, "log", () => {});
      const errWrite = t.mock.method(process.stderr, "write", () => true);
      const env = makeEnv(dir);

      await otp.main(["--home", dir], env);
      ok(errWrite.mock.calls[0].arguments[0].includes("No OTPs in the store"));

      log.mock.resetCalls();
      await otp.main(
        ["--home", dir, "add", "svc", `otpauth://totp/svc?secret=${secret}`],
        env,
      );
      log.mock.resetCalls();
      await otp.main(["--home", dir], env);
      equal(log.mock.calls[0].arguments[0], "svc");
    });
  });

  it("defaults to list with no args", async (t) => {
    await withTmpDir(async (dir) => {
      const log = t.mock.method(console, "log", () => {});
      const env = makeEnv(dir);
      await otp.main(["--home", dir], env);
      equal(log.mock.calls.length, 1);
    });
  });
});
