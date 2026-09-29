import { deepEqual, equal, ok, rejects, throws } from "node:assert";
import { describe, it } from "node:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { gzipSync } from "node:zlib";
import * as otp from "../otp";

process.exit = () => {
  throw new Error("Process.exit called");
};

const withPlatform = (platform, fn) => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
};

describe("parseArgs", () => {
  it("parses an argument list and environment", async () => {
    const commands = await otp.parseArgs(["-cs", "code", "npm"], {});
    deepEqual(commands, [
      { name: "code", args: ["npm"], flags: { clipboard: true, stdout: false } },
    ]);
  });

  it("defaults to list with no args", async () => {
    const commands = await otp.parseArgs([]);
    equal(commands.length, 1);
    equal(commands[0].name, "list");
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
    deepEqual(commands[0], {
      name: "add",
      args: ["npm", "otpauth://totp/npm?secret=AAAA"],
      flags: { clipboard: true, stdout: true },
    });
    ok(commands[0].flags.clipboard);
  });

  it("parses delete with a name", async () => {
    const commands = await otp.parseArgs(["delete", "npm"]);
    deepEqual(commands[0], {
      name: "delete",
      args: ["npm"],
      flags: { stdout: true },
    });
  });

  it("parses rename with a current and new name", async () => {
    const commands = await otp.parseArgs(["rename", "npm", "npm-work"]);
    deepEqual(commands[0], {
      name: "rename",
      args: ["npm", "npm-work"],
      flags: { stdout: true },
    });
  });

  it("parses export with just a filename", async () => {
    const commands = await otp.parseArgs(["export", "out.bin"]);
    deepEqual(commands[0], {
      name: "export",
      args: ["out.bin"],
      flags: { stdout: true },
    });
  });

  it("throws when export has no filename", async () => {
    await rejects(() => otp.parseArgs(["export"]));
  });

  it("throws when export has no filename, even with a preceding flag", async () => {
    await rejects(() => otp.parseArgs(["--unencrypted", "export"]));
  });

  it("parses import with just a filename", async () => {
    const commands = await otp.parseArgs(["import", "out.bin"]);
    deepEqual(commands[0], {
      name: "import",
      args: ["out.bin"],
      flags: { stdout: true },
    });
  });

  it("parses long flags --clip and --stdout", async () => {
    const original = process.stdout.isTTY;
    process.stdout.isTTY = false;
    try {
      const commands = await otp.parseArgs(["--clip", "--stdout", "code", "x"]);
      ok(commands[0].flags.clipboard);
      ok(!commands[0].flags.stdout);
    } finally {
      process.stdout.isTTY = original;
    }
  });

  it("parses --verbose and -v as counters", async () => {
    const commands = await otp.parseArgs(["-vv", "code", "x"]);
    equal(commands[0].flags.verbose, 2);
  });

  it("parses --home and -H", async () => {
    const commands = await otp.parseArgs(["--home", "/tmp/x", "code", "y"]);
    equal(commands[0].flags.home, "/tmp/x");
  });

  it("throws when -H is not the last shorthand flag", async () => {
    await rejects(() => otp.parseArgs(["-Hc", "/tmp/x", "code", "y"]));
  });

  it("parses -H as the last shorthand flag", async () => {
    const commands = await otp.parseArgs(["-cH", "/tmp/x", "code", "y"]);
    equal(commands[0].flags.home, "/tmp/x");
    ok(commands[0].flags.clipboard);
  });

  it("parses --verbose as a long flag counter", async () => {
    const commands = await otp.parseArgs(["--verbose", "code", "x"]);
    equal(commands[0].flags.verbose, 1);
  });

  it("calls update() on -u and --update", async (t) => {
    t.mock.method(globalThis, "fetch", async () => ({ body: "" }));
    const originalArgv1 = process.argv[1];
    process.argv[1] = "/tmp/otp-update-test";
    try {
      await rejects(() => otp.parseArgs(["-u"]), otp.UpdateCompleteNonError);
      await rejects(
        () => otp.parseArgs(["--update"]),
        otp.UpdateCompleteNonError,
      );
    } finally {
      process.argv[1] = originalArgv1;
    }
  });

  it("treats a bare value as an implicit code command", async () => {
    const commands = await otp.parseArgs(["myservice"]);
    equal(commands[0].name, "code");
    deepEqual(commands[0].args, ["myservice"]);
  });

  it("throws on unknown long flag", async () => {
    await rejects(() => otp.parseArgs(["--bogus"]), /Unknown flag: --bogus/);
  });

  it("throws on unknown short flag", async () => {
    await rejects(() => otp.parseArgs(["-z", "code", "x"]));
  });

  it("throws a HelpNonError on -h and --help", async () => {
    await rejects(() => otp.parseArgs(["-h"]), otp.HelpNonError);
    await rejects(() => otp.parseArgs(["--help"]), otp.HelpNonError);
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
    t.mock.method(globalThis, "fetch", async () => ({
      body: Buffer.from("#!/usr/bin/env node\n"),
    }));
    try {
      await rejects(() => otp.update(), otp.UpdateCompleteNonError);
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

  it("accepts a valid base32 secret whose length isn't a multiple of 8", () => {
    // Real-world secrets (e.g. from services like Postman) are often not
    // padded to a multiple of 8 characters.
    const secret52 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST";
    equal(secret52.length, 52);
    ok(otp.isOtpUrl(`otpauth://totp/test?secret=${secret52}`));
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

describe("parseOtpUrl", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it("splits issuer:account out of the label", () => {
    const result = otp.parseOtpUrl(`otpauth://totp/npm:fordi?secret=${secret}`);
    equal(result.type, "totp");
    equal(result.issuer, "npm");
    equal(result.account, "fordi");
  });

  it("prefers the issuer query param over the label prefix", () => {
    const result = otp.parseOtpUrl(
      `otpauth://totp/label-issuer:fordi?secret=${secret}&issuer=real-issuer`,
    );
    equal(result.issuer, "real-issuer");
    equal(result.account, "fordi");
  });

  it("treats the whole label as the account when there's no colon", () => {
    const result = otp.parseOtpUrl(`otpauth://totp/justaname?secret=${secret}`);
    equal(result.issuer, undefined);
    equal(result.account, "justaname");
  });

  it("only splits on the first colon", () => {
    const result = otp.parseOtpUrl(
      `otpauth://totp/issuer:account:with:colons?secret=${secret}`,
    );
    equal(result.issuer, "issuer");
    equal(result.account, "account:with:colons");
  });

  it("decodes URL-encoded labels", () => {
    const result = otp.parseOtpUrl(
      `otpauth://totp/Acme%20Co%3Ajane%40acme.com?secret=${secret}`,
    );
    equal(result.issuer, "Acme Co");
    equal(result.account, "jane@acme.com");
  });

  it("reports hotp type, algorithm, and digits", () => {
    const result = otp.parseOtpUrl(
      `otpauth://hotp/svc?secret=${secret}&counter=0&algorithm=sha256&digits=8`,
    );
    equal(result.type, "hotp");
    equal(result.algorithm, "SHA256");
    equal(result.digits, "8");
  });

  it("defaults algorithm to SHA1 and digits to 6", () => {
    const result = otp.parseOtpUrl(`otpauth://totp/svc?secret=${secret}`);
    equal(result.algorithm, "SHA1");
    equal(result.digits, "6");
  });

  it("accepts a URL instance", () => {
    const result = otp.parseOtpUrl(
      new URL(`otpauth://totp/npm:fordi?secret=${secret}`),
    );
    equal(result.account, "fordi");
  });
});

describe("markdownTable", () => {
  it("renders a header, separator, and aligned rows", () => {
    const result = otp.markdownTable([
      ["Flag", "Description"],
      ["-c", "toggle clipboard"],
      ["-H {home}", "use a home directory"],
    ]);
    deepEqual(result.split("\n"), [
      "| Flag      | Description          |",
      "| --------- | -------------------- |",
      "| -c        | toggle clipboard     |",
      "| -H {home} | use a home directory |",
    ]);
  });

  it("pads columns to the widest cell, including the header", () => {
    const result = otp.markdownTable([
      ["A", "B"],
      ["short", "x"],
      ["y", "much longer value"],
    ]);
    const lines = result.split("\n");
    const pipeColumns = lines.map((line) =>
      [...line].reduce((acc, ch, i) => (ch === "|" ? [...acc, i] : acc), []),
    );
    deepEqual(pipeColumns[0], pipeColumns[1]);
    deepEqual(pipeColumns[0], pipeColumns[2]);
  });

  it("handles a single-row (header-only) table", () => {
    const result = otp.markdownTable([["Only", "Header"]]);
    deepEqual(result.split("\n"), ["| Only | Header |", "| ---- | ------ |"]);
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

describe("getPasswordHash", () => {
  it("is a SHA-256 digest of the password", async () => {
    const hash = await otp.getPasswordHash("hunter2");
    const expected = await crypto.subtle.digest(
      "SHA-256",
      otp.encode("hunter2"),
    );
    deepEqual(new Uint8Array(hash), new Uint8Array(expected));
  });

  it("is deterministic for the same password", async () => {
    const a = await otp.getPasswordHash("hunter2");
    const b = await otp.getPasswordHash("hunter2");
    deepEqual(new Uint8Array(a), new Uint8Array(b));
  });

  it("differs for different passwords", async () => {
    const a = await otp.getPasswordHash("hunter2");
    const b = await otp.getPasswordHash("hunter3");
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

  it("labels the account with ANONYMOUS_NO_ACCOUNT", () => {
    const url = otp.urlFromSecret("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    equal(url.pathname, `/${otp.ANONYMOUS_NO_ACCOUNT}`);
    equal(otp.parseOtpUrl(url).account, otp.ANONYMOUS_NO_ACCOUNT);
  });
});

describe("slugify", () => {
  it("lowercases and replaces non-alphanumerics with underscores", () => {
    equal(otp.slugify("Cesium Ion"), "cesium_ion");
  });

  it("collapses runs of separators and trims leading/trailing ones", () => {
    equal(otp.slugify("  Weird!!  Name__ "), "weird_name");
  });

  it("leaves an already-clean lowercase name alone", () => {
    equal(otp.slugify("github"), "github");
  });
});

describe("isGoogleAuthenticatorExport", () => {
  it("accepts a valid accounts array", () => {
    ok(otp.isGoogleAuthenticatorExport({ accounts: [{ secret: "x" }] }));
  });

  it("accepts an empty accounts array", () => {
    ok(otp.isGoogleAuthenticatorExport({ accounts: [] }));
  });

  it("rejects the plain name->url export format", () => {
    ok(
      !otp.isGoogleAuthenticatorExport({ npm: "otpauth://totp/npm?secret=x" }),
    );
  });

  it("rejects an accounts array with a non-string secret", () => {
    ok(!otp.isGoogleAuthenticatorExport({ accounts: [{ secret: 5 }] }));
  });

  it("rejects null and non-objects", () => {
    ok(!otp.isGoogleAuthenticatorExport(null));
    ok(!otp.isGoogleAuthenticatorExport("accounts"));
  });
});

describe("isOtpUrlListExport", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it("accepts an array of valid OTP URLs", () => {
    ok(
      otp.isOtpUrlListExport([
        `otpauth://totp/npm?secret=${secret}`,
        `otpauth://hotp/svc?secret=${secret}&counter=0`,
      ]),
    );
  });

  it("rejects an array containing an invalid entry", () => {
    ok(
      !otp.isOtpUrlListExport([`otpauth://totp/npm?secret=${secret}`, "nope"]),
    );
  });

  it("rejects the Google Authenticator export shape", () => {
    ok(!otp.isOtpUrlListExport({ accounts: [{ secret: "x" }] }));
  });

  it("rejects the plain name->url export format", () => {
    ok(!otp.isOtpUrlListExport({ npm: `otpauth://totp/npm?secret=${secret}` }));
  });
});

describe("nameForImportedUrl", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it("names by slugged issuer", () => {
    const used = new Set();
    const name = otp.nameForImportedUrl(
      used,
      `otpauth://totp/Cesium%20Ion:jane@cesium.io?secret=${secret}&issuer=Cesium+Ion`,
    );
    equal(name, "cesium_ion");
    ok(used.has("cesium_ion"));
  });

  it("appends slugged account on collision", () => {
    const used = new Set(["cesium_ion"]);
    const name = otp.nameForImportedUrl(
      used,
      `otpauth://totp/Cesium%20Ion:john@cesium.io?secret=${secret}&issuer=Cesium+Ion`,
    );
    equal(name, "cesium_ion_john_cesium_io");
  });

  it("falls back to the account when there's no issuer", () => {
    const used = new Set();
    const name = otp.nameForImportedUrl(
      used,
      `otpauth://totp/justaname?secret=${secret}`,
    );
    equal(name, "justaname");
  });
});

describe("urlFromGoogleAuthenticatorAccount", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it("omits algorithm, digits, and period when they match the defaults", () => {
    const url = otp.urlFromGoogleAuthenticatorAccount({
      secret,
      name: "jane@cesium.io",
      issuer: "Cesium Ion",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
    });
    ok(!url.searchParams.has("algorithm"));
    ok(!url.searchParams.has("digits"));
    ok(!url.searchParams.has("period"));
    equal(url.searchParams.get("secret"), secret);
    equal(url.searchParams.get("issuer"), "Cesium Ion");
  });

  it("includes algorithm, digits, and period when they differ from the defaults", () => {
    const url = otp.urlFromGoogleAuthenticatorAccount({
      secret,
      name: "jane@cesium.io",
      issuer: "Cesium Ion",
      algorithm: "SHA256",
      digits: 8,
      period: 60,
    });
    equal(url.searchParams.get("algorithm"), "SHA256");
    equal(url.searchParams.get("digits"), "8");
    equal(url.searchParams.get("period"), "60");
  });

  it("builds a label from issuer:name", () => {
    const url = otp.urlFromGoogleAuthenticatorAccount({
      secret,
      name: "jane@cesium.io",
      issuer: "Cesium Ion",
    });
    equal(otp.parseOtpUrl(url).issuer, "Cesium Ion");
    equal(otp.parseOtpUrl(url).account, "jane@cesium.io");
  });

  it("falls back to just the name when there's no issuer", () => {
    const url = otp.urlFromGoogleAuthenticatorAccount({
      secret,
      name: "jane@cesium.io",
    });
    equal(otp.parseOtpUrl(url).account, "jane@cesium.io");
    ok(!url.searchParams.has("issuer"));
  });

  it("produces a valid, working OTP URL", async () => {
    const url = otp.urlFromGoogleAuthenticatorAccount({
      secret,
      name: "jane@cesium.io",
      issuer: "Cesium Ion",
    });
    ok(otp.isOtpUrl(url));
    const code = await otp.otp(url);
    equal(code.length, 6);
  });
});

describe("prompt.password", () => {
  const makeFakeInput = ({ isTTY = false } = {}) => {
    const input = new EventEmitter();
    input.isTTY = isTTY;
    input.setRawMode = () => {};
    input.setEncoding = () => {};
    input.resume = () => {};
    input.pause = () => {};
    return input;
  };
  const makeFakeOutput = () => {
    const written = [];
    return { written, write: (s) => written.push(s) };
  };

  it("resolves with the typed characters on enter", async () => {
    const input = makeFakeInput();
    const output = makeFakeOutput();
    const result = otp.prompt.password("Password: ", { input, output });
    input.emit("data", "hunter2\n");
    equal(await result, "hunter2");
    deepEqual(output.written, ["Password: "]);
  });

  it("echoes a trailing newline only on a tty", async () => {
    const input = makeFakeInput({ isTTY: true });
    const output = makeFakeOutput();
    const result = otp.prompt.password("Password: ", { input, output });
    input.emit("data", "hunter2\n");
    await result;
    deepEqual(output.written, ["Password: ", "\n"]);
  });

  it("resolves on carriage return", async () => {
    const input = makeFakeInput();
    const output = makeFakeOutput();
    const result = otp.prompt.password("Password: ", { input, output });
    input.emit("data", "abc\r");
    equal(await result, "abc");
  });

  it("handles backspace characters", async () => {
    const input = makeFakeInput();
    const output = makeFakeOutput();
    const result = otp.prompt.password("Password: ", { input, output });
    input.emit("data", "abcd\u007f\u007f\n");
    equal(await result, "ab");
  });

  it("rejects on Ctrl-C", async () => {
    const input = makeFakeInput();
    const output = makeFakeOutput();
    const result = otp.prompt.password("Password: ", { input, output });
    input.emit("data", "abc\u0003");
    await rejects(() => result, { code: "SIGINT" });
  });

  it("enables and disables raw mode on a tty input", async () => {
    const input = makeFakeInput({ isTTY: true });
    let rawMode;
    input.setRawMode = (v) => {
      rawMode = v;
    };
    const output = makeFakeOutput();
    const result = otp.prompt.password("Password: ", { input, output });
    equal(rawMode, true);
    input.emit("data", "x\n");
    await result;
    equal(rawMode, false);
  });
});

describe("hasCommand", () => {
  it("returns true when the command resolves", (t) => {
    const spawnSync = t.mock.method(otp.proc, "spawnSync", () => ({
      status: 0,
    }));
    ok(otp.hasCommand("secret-tool"));
    equal(spawnSync.mock.calls.length, 1);
    const [cmd, args] = spawnSync.mock.calls[0].arguments;
    equal(cmd, "sh");
    deepEqual(args, ["-c", "command -v secret-tool"]);
  });

  it("returns false when the command is missing", (t) => {
    t.mock.method(otp.proc, "spawnSync", () => ({ status: 1 }));
    ok(!otp.hasCommand("not-a-real-command"));
  });
});

describe("clip", () => {
  it("returns the spawnSync result", (t) => {
    t.mock.method(otp.proc, "spawnSync", () => ({ status: 0 }));
    const result = otp.clip("123456");
    equal(typeof result.status, "number");
  });

  it("uses xclip on X11 Linux sessions", (t) => {
    const spawnSync = t.mock.method(otp.proc, "spawnSync", () => ({
      status: 0,
    }));
    const original = process.env.WAYLAND_DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    try {
      withPlatform("linux", () => otp.clip("123456"));
    } finally {
      if (original !== undefined) process.env.WAYLAND_DISPLAY = original;
    }
    equal(spawnSync.mock.calls.length, 1);
    const [cmd, args, opts] = spawnSync.mock.calls[0].arguments;
    equal(cmd, "xclip");
    deepEqual(args, ["-selection", "clipboard"]);
    equal(opts.input, "123456");
  });

  it("uses wl-copy on Wayland Linux sessions", (t) => {
    const spawnSync = t.mock.method(otp.proc, "spawnSync", () => ({
      status: 0,
    }));
    const original = process.env.WAYLAND_DISPLAY;
    process.env.WAYLAND_DISPLAY = "wayland-0";
    try {
      withPlatform("linux", () => otp.clip("123456"));
    } finally {
      if (original === undefined) delete process.env.WAYLAND_DISPLAY;
      else process.env.WAYLAND_DISPLAY = original;
    }
    equal(spawnSync.mock.calls.length, 1);
    const [cmd, args, opts] = spawnSync.mock.calls[0].arguments;
    equal(cmd, "wl-copy");
    deepEqual(args, []);
    equal(opts.input, "123456");
  });

  it("uses clip on Windows", (t) => {
    const spawnSync = t.mock.method(otp.proc, "spawnSync", () => ({
      status: 0,
    }));
    withPlatform("win32", () => otp.clip("123456"));
    equal(spawnSync.mock.calls.length, 1);
    const [cmd, args, opts] = spawnSync.mock.calls[0].arguments;
    equal(cmd, "clip");
    deepEqual(args, []);
    equal(opts.input, "123456");
  });

  it("uses pbcopy on macOS", (t) => {
    const spawnSync = t.mock.method(otp.proc, "spawnSync", () => ({
      status: 0,
    }));
    withPlatform("darwin", () => otp.clip("123456"));
    equal(spawnSync.mock.calls.length, 1);
    const [cmd, args, opts] = spawnSync.mock.calls[0].arguments;
    equal(cmd, "pbcopy");
    deepEqual(args, []);
    equal(opts.input, "123456");
  });
});

describe("KeychainSecret", () => {
  it("reads via `security find-generic-password -w`", async (t) => {
    const spawnSync = t.mock.method(otp.proc, "spawnSync", () => ({
      status: 0,
      stdout: Buffer.from("hello").toString("base64url") + "\n",
    }));
    const s = new otp.KeychainSecret("org.fordi.otp", "alice");
    const result = await s.read();
    equal(spawnSync.mock.calls.length, 1);
    const [cmd, args, opts] = spawnSync.mock.calls[0].arguments;
    equal(cmd, "security");
    deepEqual(args, [
      "find-generic-password",
      "-s",
      "org.fordi.otp",
      "-a",
      "alice",
      "-w",
    ]);
    equal(opts.encoding, "utf8");
    equal(otp.decode(result), "hello");
  });

  it("writes via `security add-generic-password -U`", async (t) => {
    const spawnSync = t.mock.method(otp.proc, "spawnSync", () => ({
      status: 0,
    }));
    const s = new otp.KeychainSecret("org.fordi.otp", "alice");
    await s.write(otp.encode("hello"));
    equal(spawnSync.mock.calls.length, 1);
    const [cmd, args, opts] = spawnSync.mock.calls[0].arguments;
    equal(cmd, "security");
    deepEqual(args, [
      "add-generic-password",
      "-U",
      "-s",
      "org.fordi.otp",
      "-a",
      "alice",
      "-w",
      Buffer.from(otp.encode("hello")).toString("base64url"),
    ]);
    equal(opts.encoding, "utf8");
  });

  it("throws ENOENT when the keychain lookup fails", async (t) => {
    t.mock.method(otp.proc, "spawnSync", () => ({ status: 1 }));
    const s = new otp.KeychainSecret("org.fordi.otp", "alice");
    await rejects(() => s.read(), { code: "ENOENT" });
  });

  it("throws a descriptive error when the keychain write fails", async (t) => {
    t.mock.method(otp.proc, "spawnSync", () => ({ status: 1 }));
    const s = new otp.KeychainSecret("org.fordi.otp", "alice");
    await rejects(
      () => s.write(otp.encode("hello")),
      (e) => {
        ok(e instanceof Error);
        ok(e.message.includes("org.fordi.otp"));
        ok(e.message.includes("alice"));
        return true;
      },
    );
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
    await rejects(
      () => s.write(otp.encode("hello")),
      (e) => {
        ok(e instanceof Error);
        ok(e.message.includes('Couldn\'t write secret "my label"'));
        ok(e.message.includes('domain="org.fordi.otp"'));
        ok(e.message.includes('user="alice"'));
        return true;
      },
    );
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

  it("deletes a stored entry and reports success", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const flags = { home: join(dir, "local") };
      const store = new otp.SecretManager("org.fordi.otp", makeEnv(dir), flags);
      const url = `otpauth://totp/svc?secret=${secret}`;
      await store.set("svc", url);
      equal(await store.delete("svc"), true);
      deepEqual(await store.list(), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false when deleting a name that doesn't exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const flags = { home: join(dir, "local") };
      const store = new otp.SecretManager("org.fordi.otp", makeEnv(dir), flags);
      equal(await store.delete("nope"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renames a stored entry, preserving its value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const flags = { home: join(dir, "local") };
      const store = new otp.SecretManager("org.fordi.otp", makeEnv(dir), flags);
      const url = `otpauth://totp/svc?secret=${secret}`;
      await store.set("svc", url);
      equal(await store.rename("svc", "svc2"), true);
      deepEqual(await store.list(), ["svc2"]);
      equal(await store.get("svc2"), url);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false when renaming a name that doesn't exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const flags = { home: join(dir, "local") };
      const store = new otp.SecretManager("org.fordi.otp", makeEnv(dir), flags);
      equal(await store.rename("nope", "also-nope"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when renaming to a name that already exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const flags = { home: join(dir, "local") };
      const store = new otp.SecretManager("org.fordi.otp", makeEnv(dir), flags);
      await store.set("svc1", `otpauth://totp/svc1?secret=${secret}`);
      await store.set("svc2", `otpauth://totp/svc2?secret=${secret}`);
      await rejects(() => store.rename("svc1", "svc2"), /already exists/);
      deepEqual((await store.list()).sort(), ["svc1", "svc2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exports as a plain URL list when password is falsy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const flags = { home: join(dir, "local") };
      const store = new otp.SecretManager("org.fordi.otp", makeEnv(dir), flags);
      const url1 = `otpauth://totp/svc1?secret=${secret}`;
      const url2 = `otpauth://hotp/svc2?secret=${secret}&counter=5`;
      await store.set("svc1", url1);
      await store.set("svc2", url2);

      const file = join(dir, "plain.txt");
      await store.export(undefined, file);
      const contents = readFileSync(file, "utf8");
      const lines = contents.trim().split("\n");
      ok(otp.isOtpUrlListExport(lines));
      deepEqual(lines.sort(), [url1, url2].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exports and imports a store, round-tripping every entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const env = makeEnv(dir);
      const flags1 = { home: join(dir, "local1") };
      const store1 = new otp.SecretManager("org.fordi.otp", env, flags1);
      const url1 = `otpauth://totp/svc1?secret=${secret}`;
      const url2 = `otpauth://hotp/svc2?secret=${secret}&counter=5`;
      await store1.set("svc1", url1);
      await store1.set("svc2", url2);

      const exportFile = join(dir, "export.bin");
      await store1.export("hunter2", exportFile);
      ok(existsSync(exportFile));

      const flags2 = { home: join(dir, "local2") };
      const store2 = new otp.SecretManager("org.fordi.otp", env, flags2);
      await store2.import("hunter2", exportFile);

      deepEqual((await store2.list()).sort(), ["svc1", "svc2"]);
      equal(await store2.get("svc1"), url1);
      equal(await store2.get("svc2"), url2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports every entry as added into an empty store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const env = makeEnv(dir);
      const flags1 = { home: join(dir, "local1") };
      const store1 = new otp.SecretManager("org.fordi.otp", env, flags1);
      await store1.set("svc1", `otpauth://totp/svc1?secret=${secret}`);
      await store1.set("svc2", `otpauth://totp/svc2?secret=${secret}`);
      const exportFile = join(dir, "export.bin");
      await store1.export("hunter2", exportFile);

      const flags2 = { home: join(dir, "local2") };
      const store2 = new otp.SecretManager("org.fordi.otp", env, flags2);
      const report = await store2.import("hunter2", exportFile);
      deepEqual(report.added.sort(), ["svc1", "svc2"]);
      deepEqual(report.updated, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports pre-existing entries as updated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const flags = { home: join(dir, "local") };
      const store = new otp.SecretManager("org.fordi.otp", makeEnv(dir), flags);
      await store.set("svc", `otpauth://totp/svc?secret=${secret}`);
      const file = join(dir, "map.json");
      writeFileSync(
        file,
        JSON.stringify({
          svc: `otpauth://totp/svc?secret=${secret}&digits=8`,
          other: `otpauth://totp/other?secret=${secret}`,
        }),
      );
      const report = await store.import("unused", file);
      deepEqual(report.added, ["other"]);
      deepEqual(report.updated, ["svc"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const writeEncryptedExport = async (file, password, data) => {
    const json = gzipSync(otp.encode(JSON.stringify(data)));
    const [iv, encrypted] = await otp.encrypt(
      await otp.getPasswordHash(password),
      json,
    );
    writeFileSync(
      file,
      Buffer.concat([Buffer.from(iv), Buffer.from(encrypted)]),
    );
  };

  it("imports a Google Authenticator export, naming by slugged issuer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const flags = { home: join(dir, "local") };
      const store = new otp.SecretManager("org.fordi.otp", makeEnv(dir), flags);
      const file = join(dir, "ga-export.bin");
      await writeEncryptedExport(file, "hunter2", {
        accounts: [
          {
            secret,
            name: "jane@cesium.io",
            issuer: "Cesium Ion",
            algorithm: "SHA1",
            digits: 6,
            period: 30,
          },
          {
            secret,
            name: "john@cesium.io",
            issuer: "Cesium Ion",
            algorithm: "SHA1",
            digits: 6,
            period: 30,
          },
        ],
      });
      await store.import("hunter2", file);
      deepEqual((await store.list()).sort(), [
        "cesium_ion",
        "cesium_ion_john_cesium_io",
      ]);
      ok((await store.get("cesium_ion")).includes("jane%40cesium.io"));
      ok(
        (await store.get("cesium_ion_john_cesium_io")).includes(
          "john%40cesium.io",
        ),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("imports a plain list of OTP URLs, naming with the same rules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const flags = { home: join(dir, "local") };
      const store = new otp.SecretManager("org.fordi.otp", makeEnv(dir), flags);
      const file = join(dir, "urllist-export.bin");
      const urls = [
        `otpauth://totp/npm:jane@corp.io?secret=${secret}&issuer=npm`,
        `otpauth://totp/npm:john@corp.io?secret=${secret}&issuer=npm`,
        `otpauth://totp/justaname?secret=${secret}`,
      ];
      await writeEncryptedExport(file, "hunter2", urls);
      await store.import("hunter2", file);
      deepEqual((await store.list()).sort(), [
        "justaname",
        "npm",
        "npm_john_corp_io",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a UTF-8 text file that is neither JSON nor a URL list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const flags = { home: join(dir, "local") };
      const store = new otp.SecretManager("org.fordi.otp", makeEnv(dir), flags);
      const file = join(dir, "garbage.txt");
      writeFileSync(file, "this is just some plain text, not otp urls");
      await rejects(() => store.import("unused", file), /not a recognized/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("imports a plaintext (unencrypted) URL list without requesting a password", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const flags = { home: join(dir, "local") };
      const store = new otp.SecretManager("org.fordi.otp", makeEnv(dir), flags);
      const file = join(dir, "plain-urllist.json");
      const urls = [
        `otpauth://totp/npm:jane@corp.io?secret=${secret}&issuer=npm`,
      ];
      writeFileSync(file, JSON.stringify(urls));

      let called = false;
      await store.import(() => {
        called = true;
        return "unused";
      }, file);
      equal(called, false);
      deepEqual(await store.list(), ["npm"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("imports a newline-separated (non-JSON) URL list without requesting a password", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const flags = { home: join(dir, "local") };
      const store = new otp.SecretManager("org.fordi.otp", makeEnv(dir), flags);
      const file = join(dir, "urls.txt");
      writeFileSync(
        file,
        [
          `otpauth://totp/npm:jane@corp.io?secret=${secret}&issuer=npm`,
          `otpauth://totp/GitHub:jane?secret=${secret}`,
        ].join("\n"),
      );

      let called = false;
      await store.import(() => {
        called = true;
        return "unused";
      }, file);
      equal(called, false);
      deepEqual((await store.list()).sort(), ["github", "npm"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips blank lines and # comments in a newline-separated URL list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const flags = { home: join(dir, "local") };
      const store = new otp.SecretManager("org.fordi.otp", makeEnv(dir), flags);
      const file = join(dir, "urls.txt");
      writeFileSync(
        file,
        [
          "# My OTP backup",
          "",
          `otpauth://totp/npm:jane@corp.io?secret=${secret}&issuer=npm`,
          "  # indented comment",
          "",
          `otpauth://totp/GitHub:jane?secret=${secret}`,
          "",
        ].join("\n"),
      );

      let called = false;
      await store.import(() => {
        called = true;
        return "unused";
      }, file);
      equal(called, false);
      deepEqual((await store.list()).sort(), ["github", "npm"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("imports a plaintext (unencrypted) Google Authenticator export without requesting a password", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const flags = { home: join(dir, "local") };
      const store = new otp.SecretManager("org.fordi.otp", makeEnv(dir), flags);
      const file = join(dir, "plain-ga.json");
      writeFileSync(
        file,
        JSON.stringify({
          accounts: [{ secret, name: "jane@cesium.io", issuer: "Cesium Ion" }],
        }),
      );

      let called = false;
      await store.import(() => {
        called = true;
        return "unused";
      }, file);
      equal(called, false);
      deepEqual(await store.list(), ["cesium_ion"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("imports a plaintext (unencrypted) name->url map without requesting a password", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const flags = { home: join(dir, "local") };
      const store = new otp.SecretManager("org.fordi.otp", makeEnv(dir), flags);
      const file = join(dir, "plain-map.json");
      const url = `otpauth://totp/svc?secret=${secret}`;
      writeFileSync(file, JSON.stringify({ svc: url }));

      let called = false;
      await store.import(() => {
        called = true;
        return "unused";
      }, file);
      equal(called, false);
      equal(await store.get("svc"), url);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still prompts for and decrypts an encrypted export", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const env = makeEnv(dir);
      const flags1 = { home: join(dir, "local1") };
      const store1 = new otp.SecretManager("org.fordi.otp", env, flags1);
      const url = `otpauth://totp/svc?secret=${secret}`;
      await store1.set("svc", url);
      const file = join(dir, "encrypted.bin");
      await store1.export("hunter2", file);

      const flags2 = { home: join(dir, "local2") };
      const store2 = new otp.SecretManager("org.fordi.otp", env, flags2);
      let called = 0;
      await store2.import(() => {
        called++;
        return "hunter2";
      }, file);
      equal(called, 1);
      equal(await store2.get("svc"), url);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects import with the wrong password", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const env = makeEnv(dir);
      const flags1 = { home: join(dir, "local1") };
      const store1 = new otp.SecretManager("org.fordi.otp", env, flags1);
      await store1.set("svc", `otpauth://totp/svc?secret=${secret}`);

      const exportFile = join(dir, "export.bin");
      await store1.export("correct-password", exportFile);

      const flags2 = { home: join(dir, "local2") };
      const store2 = new otp.SecretManager("org.fordi.otp", env, flags2);
      await rejects(() => store2.import("wrong-password", exportFile));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exports an empty store as an empty, importable file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const env = makeEnv(dir);
      const flags1 = { home: join(dir, "local1") };
      const store1 = new otp.SecretManager("org.fordi.otp", env, flags1);
      const exportFile = join(dir, "export.bin");
      await store1.export("hunter2", exportFile);

      const flags2 = { home: join(dir, "local2") };
      const store2 = new otp.SecretManager("org.fordi.otp", env, flags2);
      await store2.import("hunter2", exportFile);
      deepEqual(await store2.list(), []);
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
      withPlatform("linux", () => {
        new otp.SecretManager("org.fordi.otp", makeEnv(dir), flags);
      });
      ok(write.mock.calls[0].arguments[0].includes("BinarySecret"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses BinarySecret in a tty session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const flags = { home: join(dir, "local") };
      const store = withPlatform(
        "linux",
        () => new otp.SecretManager("org.fordi.otp", makeEnv(dir), flags),
      );
      ok(store.secretService instanceof otp.BinarySecret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses BinarySecret as the ultimate fallback (non-Windows, no dbus)", async () => {
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
      const store = withPlatform(
        "linux",
        () => new otp.SecretManager("org.fordi.otp", env, flags),
      );
      ok(store.secretService instanceof otp.BinarySecret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses SecretServiceSecret when a session is non-tty with dbus and secret-tool is present", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      t.mock.method(otp.proc, "spawnSync", () => ({ status: 0 }));
      const flags = { home: join(dir, "local") };
      const env = {
        XDG_SESSION_TYPE: "x11",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        USER: "tester",
        UID: 1000,
        HOME: dir,
      };
      const store = withPlatform(
        "linux",
        () => new otp.SecretManager("org.fordi.otp", env, flags),
      );
      ok(store.secretService instanceof otp.SecretServiceSecret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logs verbose output when using SecretServiceSecret", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      t.mock.method(otp.proc, "spawnSync", () => ({ status: 0 }));
      const write = t.mock.method(process.stderr, "write", () => true);
      const flags = { home: join(dir, "local"), verbose: true };
      const env = {
        XDG_SESSION_TYPE: "x11",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        USER: "tester",
        UID: 1000,
        HOME: dir,
      };
      withPlatform("linux", () => {
        new otp.SecretManager("org.fordi.otp", env, flags);
      });
      ok(write.mock.calls[0].arguments[0].includes("Using SecretService"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to BinarySecret when secret-tool is absent", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      t.mock.method(otp.proc, "spawnSync", () => ({ status: 1 }));
      const flags = { home: join(dir, "local") };
      const env = {
        XDG_SESSION_TYPE: "x11",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        USER: "tester",
        UID: 1000,
        HOME: dir,
      };
      const store = withPlatform(
        "linux",
        () => new otp.SecretManager("org.fordi.otp", env, flags),
      );
      ok(store.secretService instanceof otp.BinarySecret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates an existing BinarySecret to a newly chosen provider", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const flags = { home: join(dir, "local") };
      const ttyEnv = makeEnv(dir);

      const originalStore = withPlatform(
        "linux",
        () => new otp.SecretManager("org.fordi.otp", ttyEnv, flags),
      );
      const originalSecret = await originalStore.getSecret();
      const keyFile = join(dir, "local", "org.fordi.otp.key");
      ok(existsSync(keyFile));

      let stashed;
      t.mock.method(otp.proc, "spawnSync", (cmd, args, opts) => {
        if (cmd === "sh") return { status: 0 };
        if (cmd === "secret-tool" && args[0] === "lookup") {
          return stashed ? { status: 0, stdout: stashed } : { status: 1 };
        }
        if (cmd === "secret-tool" && args[0] === "store") {
          stashed = opts.input;
          return { status: 0 };
        }
        throw new Error(`unexpected spawnSync(${cmd})`);
      });

      const dbusEnv = {
        XDG_SESSION_TYPE: "x11",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        USER: "tester",
        UID: 1000,
        HOME: dir,
      };
      const migratedStore = withPlatform(
        "linux",
        () => new otp.SecretManager("org.fordi.otp", dbusEnv, flags),
      );
      ok(migratedStore.secretService instanceof otp.SecretServiceSecret);

      const migratedSecret = await migratedStore.getSecret();
      deepEqual(new Uint8Array(migratedSecret), new Uint8Array(originalSecret));
      ok(!existsSync(keyFile));
      ok(existsSync(`${keyFile}.migrated`));

      const secretAgain = await migratedStore.getSecret();
      deepEqual(new Uint8Array(secretAgain), new Uint8Array(originalSecret));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logs a message when migrating", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const flags = { home: join(dir, "local") };
      const ttyEnv = makeEnv(dir);
      const originalStore = withPlatform(
        "linux",
        () => new otp.SecretManager("org.fordi.otp", ttyEnv, flags),
      );
      await originalStore.getSecret();

      t.mock.method(otp.proc, "spawnSync", () => ({ status: 0 }));
      const write = t.mock.method(process.stderr, "write", () => true);
      const dbusEnv = {
        XDG_SESSION_TYPE: "x11",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        USER: "tester",
        UID: 1000,
        HOME: dir,
      };
      withPlatform(
        "linux",
        () =>
          new otp.SecretManager("org.fordi.otp", dbusEnv, {
            ...flags,
            verbose: true,
          }),
      );
      ok(write.mock.calls.some((c) => c.arguments[0].includes("Migrating")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses WindowsSecureStringSecret when platform is win32", async () => {
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
      const store = withPlatform(
        "win32",
        () => new otp.SecretManager("org.fordi.otp", env, flags),
      );
      ok(store.secretService instanceof otp.WindowsSecureStringSecret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses KeychainSecret when platform is darwin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const flags = { home: join(dir, "local") };
      const env = {
        XDG_SESSION_TYPE: "tty",
        USER: "tester",
        UID: 1000,
        HOME: dir,
      };
      const store = withPlatform(
        "darwin",
        () => new otp.SecretManager("org.fordi.otp", env, flags),
      );
      ok(store.secretService instanceof otp.KeychainSecret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logs verbose output when using KeychainSecret", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "otp-test-"));
    try {
      const write = t.mock.method(process.stderr, "write", () => true);
      const flags = { home: join(dir, "local"), verbose: true };
      const env = {
        XDG_SESSION_TYPE: "tty",
        USER: "tester",
        UID: 1000,
        HOME: dir,
      };
      withPlatform("darwin", () => {
        new otp.SecretManager("org.fordi.otp", env, flags);
      });
      ok(write.mock.calls[0].arguments[0].includes("Using Keychain"));
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
      withPlatform("win32", () => {
        new otp.SecretManager("org.fordi.otp", env, flags);
      });
      ok(
        write.mock.calls[0].arguments[0].includes("Using WindowsSecureString"),
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
        () =>
          otp.main(["--home", dir, "add", "svc", "not a url or secret"], env),
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
          otp.main(["--home", dir, "add", "svc", "otpauth://totp/svc"], env),
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
        [
          "--home",
          dir,
          "code",
          `otpauth://hotp/svc?secret=${secret}&counter=0`,
        ],
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

  it("deletes a named OTP", async (t) => {
    await withTmpDir(async (dir) => {
      const log = t.mock.method(console, "log", () => {});
      const env = makeEnv(dir);
      await otp.main(
        ["--home", dir, "add", "svc", `otpauth://totp/svc?secret=${secret}`],
        env,
      );
      log.mock.resetCalls();
      await otp.main(["--home", dir, "delete", "svc"], env);
      ok(log.mock.calls[0].arguments[0].includes("Deleted svc"));

      const store = new otp.SecretManager("org.fordi.otp", env, {
        home: dir,
      });
      deepEqual(await store.list(), []);
    });
  });

  it("calls usage(1) when deleting a name that doesn't exist", async (t) => {
    await withTmpDir(async (dir) => {
      t.mock.method(process, "exit", () => {
        throw new Error("exit");
      });
      t.mock.method(process.stderr, "write", () => true);
      const env = makeEnv(dir);
      await rejects(
        () => otp.main(["--home", dir, "delete", "missing"], env),
        /exit/,
      );
      equal(process.exit.mock.calls[0].arguments[0], 1);
    });
  });

  it("renames a named OTP", async (t) => {
    await withTmpDir(async (dir) => {
      const log = t.mock.method(console, "log", () => {});
      const env = makeEnv(dir);
      await otp.main(
        ["--home", dir, "add", "svc", `otpauth://totp/svc?secret=${secret}`],
        env,
      );
      log.mock.resetCalls();
      await otp.main(["--home", dir, "rename", "svc", "svc2"], env);
      ok(log.mock.calls[0].arguments[0].includes("Renamed svc to svc2"));

      const store = new otp.SecretManager("org.fordi.otp", env, {
        home: dir,
      });
      deepEqual(await store.list(), ["svc2"]);
    });
  });

  it("calls usage(1) when renaming a name that doesn't exist", async (t) => {
    await withTmpDir(async (dir) => {
      t.mock.method(process, "exit", () => {
        throw new Error("exit");
      });
      t.mock.method(process.stderr, "write", () => true);
      const env = makeEnv(dir);
      await rejects(
        () =>
          otp.main(["--home", dir, "rename", "missing", "also-missing"], env),
        /exit/,
      );
      equal(process.exit.mock.calls[0].arguments[0], 1);
    });
  });

  it("calls usage(1) when renaming to a name that already exists", async (t) => {
    await withTmpDir(async (dir) => {
      t.mock.method(process, "exit", () => {
        throw new Error("exit");
      });
      t.mock.method(process.stderr, "write", () => true);
      const env = makeEnv(dir);
      await otp.main(
        ["--home", dir, "add", "svc1", `otpauth://totp/svc1?secret=${secret}`],
        env,
      );
      await otp.main(
        ["--home", dir, "add", "svc2", `otpauth://totp/svc2?secret=${secret}`],
        env,
      );
      await rejects(
        () => otp.main(["--home", dir, "rename", "svc1", "svc2"], env),
        /exit/,
      );
      equal(process.exit.mock.calls[0].arguments[0], 1);
    });
  });

  it("lists stored OTPs as a table when interactive, or a message when empty", async (t) => {
    const originalIsTTY = process.stdout.isTTY;
    process.stdout.isTTY = true;
    try {
      await withTmpDir(async (dir) => {
        const log = t.mock.method(console, "log", () => {});
        const errWrite = t.mock.method(process.stderr, "write", () => true);
        const env = makeEnv(dir);

        await otp.main(["--home", dir], env);
        ok(
          errWrite.mock.calls[0].arguments[0].includes("No OTPs in the store"),
        );
        equal(log.mock.calls.length, 0);

        log.mock.resetCalls();
        await otp.main(
          [
            "--home",
            dir,
            "add",
            "svc",
            `otpauth://totp/npm:fordi?secret=${secret}&issuer=npm`,
          ],
          env,
        );
        log.mock.resetCalls();
        await otp.main(["--home", dir], env);
        const output = log.mock.calls[0].arguments[0];
        ok(output.includes("| Name | Type | Issuer | Account |"));
        ok(output.includes("svc"));
        ok(output.includes("totp"));
        ok(output.includes("npm"));
        ok(output.includes("fordi"));
      });
    } finally {
      process.stdout.isTTY = originalIsTTY;
    }
  });

  it("blanks the account column for ANONYMOUS_NO_ACCOUNT entries", async (t) => {
    const originalIsTTY = process.stdout.isTTY;
    process.stdout.isTTY = true;
    try {
      await withTmpDir(async (dir) => {
        const log = t.mock.method(console, "log", () => {});
        const env = makeEnv(dir);
        await otp.main(["--home", dir, "add", "raw", secret], env);
        log.mock.resetCalls();
        await otp.main(["--home", dir], env);
        const output = log.mock.calls[0].arguments[0];
        ok(!output.includes(otp.ANONYMOUS_NO_ACCOUNT));
        const row = output.split("\n").find((line) => line.includes("raw"));
        ok(row.trim().endsWith("|"));
        ok(/\|\s*\|$/.test(row));
      });
    } finally {
      process.stdout.isTTY = originalIsTTY;
    }
  });

  it("lists plain names when piped (stdout flag set)", async (t) => {
    const originalIsTTY = process.stdout.isTTY;
    process.stdout.isTTY = false;
    try {
      await withTmpDir(async (dir) => {
        const log = t.mock.method(console, "log", () => {});
        const env = makeEnv(dir);
        await otp.main(
          [
            "--home",
            dir,
            "add",
            "svc",
            `otpauth://totp/npm:fordi?secret=${secret}&issuer=npm`,
          ],
          env,
        );
        log.mock.resetCalls();
        await otp.main(["--home", dir], env);
        equal(log.mock.calls[0].arguments[0], "svc");
      });
    } finally {
      process.stdout.isTTY = originalIsTTY;
    }
  });

  it("defaults to list with no args", async (t) => {
    await withTmpDir(async (dir) => {
      const log = t.mock.method(console, "log", () => {});
      const env = makeEnv(dir);
      await otp.main(
        ["--home", dir, "add", "svc", `otpauth://totp/svc?secret=${secret}`],
        env,
      );
      log.mock.resetCalls();
      await otp.main(["--home", dir], env);
      equal(log.mock.calls.length, 1);
    });
  });

  it("exports the store to a file, then imports it into a fresh store (interactive)", async (t) => {
    const originalStdoutTTY = process.stdout.isTTY;
    const originalStdinTTY = process.stdin.isTTY;
    process.stdout.isTTY = true;
    process.stdin.isTTY = true;
    try {
      await withTmpDir(async (dir) => {
        const log = t.mock.method(console, "log", () => {});
        const password = t.mock.method(
          otp.prompt,
          "password",
          async () => "hunter2",
        );
        const env = makeEnv(dir);
        await otp.main(
          ["--home", dir, "add", "svc", `otpauth://totp/svc?secret=${secret}`],
          env,
        );

        const exportFile = join(dir, "export.bin");
        log.mock.resetCalls();
        await otp.main(["--home", dir, "export", exportFile], env);
        ok(existsSync(exportFile));
        equal(password.mock.calls.length, 2);
        equal(password.mock.calls[0].arguments[0], "Password: ");
        equal(password.mock.calls[1].arguments[0], "Confirm password: ");

        const otherDir = join(dir, "other-home");
        password.mock.resetCalls();
        await otp.main(["--home", otherDir, "import", exportFile], env);
        equal(password.mock.calls.length, 1);
        equal(password.mock.calls[0].arguments[0], "Password: ");

        const store = new otp.SecretManager("org.fordi.otp", env, {
          home: otherDir,
        });
        deepEqual(await store.list(), ["svc"]);
      });
    } finally {
      process.stdout.isTTY = originalStdoutTTY;
      process.stdin.isTTY = originalStdinTTY;
    }
  });

  it("exports and imports with a single piped password (stdin not a tty)", async (t) => {
    const originalStdoutTTY = process.stdout.isTTY;
    const originalStdinTTY = process.stdin.isTTY;
    process.stdout.isTTY = false;
    process.stdin.isTTY = false;
    try {
      await withTmpDir(async (dir) => {
        const log = t.mock.method(console, "log", () => {});
        const password = t.mock.method(
          otp.prompt,
          "password",
          async () => "hunter2",
        );
        const env = makeEnv(dir);
        await otp.main(
          ["--home", dir, "add", "svc", `otpauth://totp/svc?secret=${secret}`],
          env,
        );

        const exportFile = join(dir, "export.bin");
        log.mock.resetCalls();
        await otp.main(["--home", dir, "export", exportFile], env);
        ok(
          log.mock.calls[0].arguments[0].includes(`Exported to ${exportFile}`),
        );
        ok(existsSync(exportFile));
        equal(password.mock.calls.length, 1);
        equal(password.mock.calls[0].arguments[0], "");

        const otherDir = join(dir, "other-home");
        log.mock.resetCalls();
        password.mock.resetCalls();
        await otp.main(["--home", otherDir, "import", exportFile], env);
        ok(
          log.mock.calls[0].arguments[0].includes(
            `Imported from ${exportFile}`,
          ),
        );
        equal(password.mock.calls.length, 1);
        equal(password.mock.calls[0].arguments[0], "");

        log.mock.resetCalls();
        await otp.main(["--home", otherDir], env);
        ok(log.mock.calls[0].arguments[0].includes("svc"));
      });
    } finally {
      process.stdout.isTTY = originalStdoutTTY;
      process.stdin.isTTY = originalStdinTTY;
    }
  });

  it("aborts export when the password confirmation doesn't match (interactive)", async (t) => {
    const originalStdinTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    try {
      await withTmpDir(async (dir) => {
        t.mock.method(process, "exit", () => {
          throw new Error("exit");
        });
        t.mock.method(process.stderr, "write", () => true);
        let call = 0;
        t.mock.method(otp.prompt, "password", async () =>
          call++ === 0 ? "hunter2" : "different",
        );
        const env = makeEnv(dir);
        const exportFile = join(dir, "export.bin");
        await rejects(
          () => otp.main(["--home", dir, "export", exportFile], env),
          /exit/,
        );
        equal(process.exit.mock.calls[0].arguments[0], 1);
        ok(!existsSync(exportFile));
      });
    } finally {
      process.stdin.isTTY = originalStdinTTY;
    }
  });

  it("rejects --unencrypted export when stdin is not a tty", async (t) => {
    const originalStdinTTY = process.stdin.isTTY;
    process.stdin.isTTY = false;
    try {
      await withTmpDir(async (dir) => {
        t.mock.method(process, "exit", () => {
          throw new Error("exit");
        });
        t.mock.method(process.stderr, "write", () => true);
        const password = t.mock.method(otp.prompt, "password", async () => {
          throw new Error("should not prompt");
        });
        const env = makeEnv(dir);
        const exportFile = join(dir, "export.txt");
        await rejects(
          () =>
            otp.main(
              ["--home", dir, "--unencrypted", "export", exportFile],
              env,
            ),
          /exit/,
        );
        equal(process.exit.mock.calls[0].arguments[0], 1);
        equal(password.mock.calls.length, 0);
        ok(!existsSync(exportFile));
      });
    } finally {
      process.stdin.isTTY = originalStdinTTY;
    }
  });

  it("writes a plain export with --unencrypted after confirming interactively", async (t) => {
    const originalStdinTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    try {
      await withTmpDir(async (dir) => {
        const password = t.mock.method(
          otp.prompt,
          "password",
          async () => "yes",
        );
        const env = makeEnv(dir);
        await otp.main(
          ["--home", dir, "add", "svc", `otpauth://totp/svc?secret=${secret}`],
          env,
        );
        const exportFile = join(dir, "export.txt");
        await otp.main(
          ["--home", dir, "--unencrypted", "export", exportFile],
          env,
        );
        equal(password.mock.calls.length, 1);
        ok(password.mock.calls[0].arguments[0].includes("PLAIN TEXT"));
        const contents = readFileSync(exportFile, "utf8");
        ok(contents.includes("otpauth://totp/svc"));
      });
    } finally {
      process.stdin.isTTY = originalStdinTTY;
    }
  });

  it("cancels --unencrypted export when not confirmed", async (t) => {
    const originalStdinTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    try {
      await withTmpDir(async (dir) => {
        t.mock.method(process, "exit", () => {
          throw new Error("exit");
        });
        t.mock.method(process.stderr, "write", () => true);
        t.mock.method(otp.prompt, "password", async () => "no");
        const env = makeEnv(dir);
        const exportFile = join(dir, "export.txt");
        await rejects(
          () =>
            otp.main(
              ["--home", dir, "--unencrypted", "export", exportFile],
              env,
            ),
          /exit/,
        );
        equal(process.exit.mock.calls[0].arguments[0], 1);
        ok(!existsSync(exportFile));
      });
    } finally {
      process.stdin.isTTY = originalStdinTTY;
    }
  });

  it("writes a plain export when the password prompt is left empty, after confirming", async (t) => {
    const originalStdinTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    try {
      await withTmpDir(async (dir) => {
        let call = 0;
        const password = t.mock.method(otp.prompt, "password", async () => {
          call++;
          return call === 1 ? "" : "yes";
        });
        const env = makeEnv(dir);
        await otp.main(
          ["--home", dir, "add", "svc", `otpauth://totp/svc?secret=${secret}`],
          env,
        );
        const exportFile = join(dir, "export.txt");
        await otp.main(["--home", dir, "export", exportFile], env);
        equal(password.mock.calls.length, 2);
        equal(password.mock.calls[0].arguments[0], "Password: ");
        ok(password.mock.calls[1].arguments[0].includes("PLAIN TEXT"));
        const contents = readFileSync(exportFile, "utf8");
        ok(contents.includes("otpauth://totp/svc"));
      });
    } finally {
      process.stdin.isTTY = originalStdinTTY;
    }
  });

  it("cancels export when the password prompt is left empty and not confirmed", async (t) => {
    const originalStdinTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    try {
      await withTmpDir(async (dir) => {
        t.mock.method(process, "exit", () => {
          throw new Error("exit");
        });
        t.mock.method(process.stderr, "write", () => true);
        let call = 0;
        t.mock.method(otp.prompt, "password", async () => {
          call++;
          return call === 1 ? "" : "no";
        });
        const env = makeEnv(dir);
        const exportFile = join(dir, "export.txt");
        await rejects(
          () => otp.main(["--home", dir, "export", exportFile], env),
          /exit/,
        );
        equal(process.exit.mock.calls[0].arguments[0], 1);
        ok(!existsSync(exportFile));
      });
    } finally {
      process.stdin.isTTY = originalStdinTTY;
    }
  });

  it("prompts interactively even when only stdout is piped", async (t) => {
    const originalStdoutTTY = process.stdout.isTTY;
    const originalStdinTTY = process.stdin.isTTY;
    process.stdout.isTTY = false;
    process.stdin.isTTY = true;
    try {
      await withTmpDir(async (dir) => {
        const password = t.mock.method(
          otp.prompt,
          "password",
          async () => "hunter2",
        );
        const env = makeEnv(dir);
        const exportFile = join(dir, "export.bin");
        await otp.main(["--home", dir, "export", exportFile], env);
        equal(password.mock.calls.length, 2);
        equal(password.mock.calls[0].arguments[0], "Password: ");
        equal(password.mock.calls[1].arguments[0], "Confirm password: ");
      });
    } finally {
      process.stdout.isTTY = originalStdoutTTY;
      process.stdin.isTTY = originalStdinTTY;
    }
  });

  it("imports a plaintext file via main() without prompting", async (t) => {
    const originalStdinTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    try {
      await withTmpDir(async (dir) => {
        const password = t.mock.method(otp.prompt, "password", async () => {
          throw new Error("should not be called");
        });
        const env = makeEnv(dir);
        const file = join(dir, "plain.json");
        writeFileSync(
          file,
          JSON.stringify([
            `otpauth://totp/npm:jane@corp.io?secret=${secret}&issuer=npm`,
          ]),
        );
        await otp.main(["--home", dir, "import", file], env);
        equal(password.mock.calls.length, 0);

        const store = new otp.SecretManager("org.fordi.otp", env, {
          home: dir,
        });
        deepEqual(await store.list(), ["npm"]);
      });
    } finally {
      process.stdin.isTTY = originalStdinTTY;
    }
  });

  it("reports added/updated rows when piped, as plain lines", async (t) => {
    const originalStdoutTTY = process.stdout.isTTY;
    process.stdout.isTTY = false;
    try {
      await withTmpDir(async (dir) => {
        const log = t.mock.method(console, "log", () => {});
        const env = makeEnv(dir);
        await otp.main(
          ["--home", dir, "add", "svc", `otpauth://totp/svc?secret=${secret}`],
          env,
        );
        const file = join(dir, "map.json");
        writeFileSync(
          file,
          JSON.stringify({
            svc: `otpauth://totp/svc?secret=${secret}&digits=8`,
            other: `otpauth://totp/other?secret=${secret}`,
          }),
        );
        log.mock.resetCalls();
        await otp.main(["--home", dir, "import", file], env);
        const output = log.mock.calls.map((c) => c.arguments[0]).join("\n");
        ok(output.includes(`Imported from ${file}`));
        ok(output.includes("added: other"));
        ok(output.includes("updated: svc"));
      });
    } finally {
      process.stdout.isTTY = originalStdoutTTY;
    }
  });

  it("reports added/updated rows when interactive, as a table", async (t) => {
    const originalStdoutTTY = process.stdout.isTTY;
    process.stdout.isTTY = true;
    try {
      await withTmpDir(async (dir) => {
        const log = t.mock.method(console, "log", () => {});
        const env = makeEnv(dir);
        await otp.main(
          ["--home", dir, "add", "svc", `otpauth://totp/svc?secret=${secret}`],
          env,
        );
        const file = join(dir, "map.json");
        writeFileSync(
          file,
          JSON.stringify({
            svc: `otpauth://totp/svc?secret=${secret}&digits=8`,
            other: `otpauth://totp/other?secret=${secret}`,
          }),
        );
        log.mock.resetCalls();
        await otp.main(["--home", dir, "import", file], env);
        const output = log.mock.calls[0].arguments[0];
        ok(output.includes("Name"));
        ok(output.includes("Status"));
        ok(output.includes("other"));
        ok(output.includes("added"));
        ok(output.includes("svc"));
        ok(output.includes("updated"));
      });
    } finally {
      process.stdout.isTTY = originalStdoutTTY;
    }
  });

  it("rejects an export filename that looks like a flag", async (t) => {
    await withTmpDir(async (dir) => {
      const write = t.mock.method(process.stderr, "write", () => true);
      const exit = t.mock.method(process, "exit", () => {});
      const env = makeEnv(dir);
      await otp.main(["--home", dir, "export", "-oops"], env);
      ok(
        write.mock.calls.some((c) =>
          c.arguments[0].includes("filename cannot look like a flag"),
        ),
      );
      equal(exit.mock.calls[0].arguments[0], 1);
    });
  });

  it("exits silently (no usage text) when update completes", async (t) => {
    await withTmpDir(async (dir) => {
      const write = t.mock.method(process.stderr, "write", () => true);
      const exit = t.mock.method(process, "exit", () => {});
      t.mock.method(globalThis, "fetch", async () => ({ body: "" }));
      const originalArgv1 = process.argv[1];
      process.argv[1] = join(dir, "otp-copy.js");
      try {
        const env = makeEnv(dir);
        await otp.main(["-u"], env);
      } finally {
        process.argv[1] = originalArgv1;
      }
      equal(write.mock.calls.length, 0);
      equal(exit.mock.calls[0].arguments[0], 0);
    });
  });

  it("prints the full help text and exits 0 for -h via main()", async (t) => {
    await withTmpDir(async (dir) => {
      const write = t.mock.method(process.stderr, "write", () => true);
      const exit = t.mock.method(process, "exit", () => {});
      const env = makeEnv(dir);
      await otp.main(["-h"], env);
      const output = write.mock.calls.map((c) => c.arguments[0]).join("");
      ok(output.includes("## Storage"));
      ok(output.includes("## Examples"));
      equal(exit.mock.calls[0].arguments[0], 0);
    });
  });
});
