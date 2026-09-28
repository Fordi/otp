# `otp`

`otp` is a tiny command-line app to store and evaluate OTP codes.

Test coverage is available at https://fordi.github.io/otp/coverage/index.html

## Installation

```sh
. <(wget -qO- https://fordi.github.io/otp/install | bash)
```

or

```sh
. <(curl -sSL https://fordi.github.io/otp/install | bash)
```

## System dependencies

`otp` uses your OS's native secret storage and clipboard when it can, and
falls back to an encrypted file (`${HOME}/.local/org.fordi.otp`) otherwise.
For better security, install the tools below for your platform:

- **Linux (GNOME, KDE, or any Secret Service provider)**: `libsecret-tools`
  (provides `secret-tool`) for secret storage. For clipboard support,
  `xclip` on X11 sessions, or `wl-clipboard` (provides `wl-copy`) on
  Wayland sessions (detected via `$WAYLAND_DISPLAY`). Without
  `libsecret-tools`, or outside a D-Bus session, `otp` falls back to the
  encrypted file automatically.
- **macOS**: none required — uses the built-in `security` (Keychain) and
  `pbcopy` commands.
- **Windows**: none required — uses PowerShell's `SecureString` cmdlets and
  the built-in `clip` command.

If `otp` was previously using the encrypted-file fallback and a proper
secret store becomes available (e.g. you install `libsecret-tools`), it
automatically migrates the existing secret into the new store the next
time it runs, and renames the old key file to `org.fordi.otp.key.migrated`.

## Usage

```
otp [([flags] command|{name|url|secret})]...
```

## Flags

| Flag                   | Description                                |
| ---------------------- | ------------------------------------------ |
| `--clip` / `-c`        | toggle clipboard                           |
| `--stdout` / `-s`      | toggle stdout output                       |
| `--help` / `-h`        | print this and exit                        |
| `--home` / `-H {home}` | use a home directory other than `~/.local` |
| `--update` / `-u`      | update from GitHub                         |
| `--verbose` / `-v`     | say more                                   |

- the default for a tty is clipboard, no stdout
- the default for a pipe is stdout, no clipboard
- to flip both at once, use `-cs`

## Commands

| Command                    | Description                                                             |
| -------------------------- | ----------------------------------------------------------------------- |
| `list`                     | List the OTPs in your store (the default)                               |
| `add {name} {url\|secret}` | Add a named OTP                                                         |
| `code {name\|url\|secret}` | Generate a code                                                         |
| `export {filename}`        | Export the store to an encrypted, gzipped file (prompts for a password) |
| `import {filename}`        | Import OTPs from a file made with `export` (prompts for a password)     |

## Storage

OTP URLs are stored in `${HOME}/.local/org.fordi.otp.store`, as an SQLite3 database,
and are encrypted with a secret key; the key is in your Gnome secret service, or
Windows credentials manager or, failing those, the file `${HOME}/.local/org.fordi.otp`,
itself encrypted with a hash of `$USER:$UID:{APP_SECRET}`.
It ain't much, really - someone with local root could probably figure it out,
but makes damn certain it's not in cleartext.

## Examples

```sh
$ # None of these are real secrets
$ otp add npm otpauth://totp/npm:fordi?secret=U2AN7MKZ5U6ZQVCBLOQYRPKI6D6MRT5A&issuer=npm
$ otp code npm # code for npm is now on your clipboard
$ otp code -cs npm # or just `otp -cs npm`
647876
$ otp list # or just `otp`
npm
github
$ otp -cs code US2UG2XG7HSPPEWM # or otp -cs US2UG2XG7HSPPEWM
189115
$ npm publish --access=public --otp=$(otp npm) # command-line publish without the fuss
$ otp export otp-backup.bin # export your whole store; you'll be prompted for a password
Password: 
Confirm password: 
Exported to otp-backup.bin
$ otp import otp-backup.bin # import it into another machine's store
Password: 
Imported from otp-backup.bin
```
