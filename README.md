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

| Flag                | Description                                |
| ------------------- | ------------------------------------------ |
| `--clip`/`-c`       | toggle clipboard                           |
| `--help`/`-h`/`-?`  | print this and exit                        |
| `--home`/`-H` {arg} | use a home directory other than `~/.local` |
| `--stdout`/`-s`     | toggle stdout output                       |
| `--unencrypted`     | export in plain text[^1]                   |
| `--update`/`-u`     | update from GitHub                         |
| `--verbose`/`-v`    | say more                                   |

- the default for a tty is clipboard, no stdout
- the default for a pipe is stdout, no clipboard
- to flip both at once, use `-cs`
[^1]: `export` only; requires a tty, prompts to confirm

## Commands

| Command                            | Description                                    |
| ---------------------------------- | ---------------------------------------------- |
| `add`/`+` {name} {url}             | Add a named OTP                                |
| `code`/`` {name}                   | Generate a code                                |
| `delete`/`-`/`rm` {name}           | Delete a named OTP                             |
| `export`/`x` {filename}            | Export the store to an encrypted, gzipped file |
| `import`/`i` {filename}            | Import OTPs from a file made with `export`     |
| `list`/`default`/`ls`              | List the OTPs in your store (the default)      |
| `rename`/`mv`/`r` {name} {newName} | Rename a stored OTP                            |

- `import` and `export` prompt for a password unless one is piped in.


## Storage

OTP URLs are stored in `${HOME}/.local/org.fordi.otp.store`, as an SQLite3 database, and are encrypted with a secret key; the key is in your DBUS secret service, stored as a Windows Secure String (in `%USERPROFILE%/.local/org.fordi.otp.key`), your OS-X Keyring or, failing all of those, the file `${HOME}/.local/org.fordi.otp`, itself encrypted with a hash of `$USER:$UID:{APP_SECRET}`.

## Examples

```sh
$ # None of these are real secrets
$ otp add npm otpauth://totp/npm:coolfellow?secret=ABCDEFGHIJKLMNOPQRSTUVWXYZ234567&issuer=npm
$ otp code npm # code for npm is now on your clipboard
$ otp code -cs npm # or just `otp -cs npm`
465832
$ otp list # or just `otp`
| Name   | Type | Issuer | Account    |
| ------ | ---- | ------ | ---------- |
| npm    | totp | npm    | coolfellow |
| github | totp | GitHub | jiveguy    |
$ otp -cs code 234567ABCDEFGHIJ # or otp -cs 234567ABCDEFGHIJ
219835
$ npm publish --access=public --otp=$(otp npm) # command-line publish without the fuss
```
