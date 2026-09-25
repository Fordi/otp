# `otp`

`otp` is a tiny command-line app to store and evaluate OTP codes.

## Installation

```sh
. <(wget -qO- https://fordi.github.io/otp/install | bash)
```

or

```sh
. <(curl -sSL https://fordi.github.io/otp/install | bash)
```

## Usage

```text
usage: otp [([flags] command|{name|url|secret})]...
  flags:
    --clip/-c    toggle clipboard
    --stdout/-s  toggle stdout output
    --help/-h    print this and exit
    --update/-u  update from GitHub
    the default for tty is clipboard, no stdout
    the default for a pipe is stdout, no clipboard
    to flip both at once, use -cs
  commands:
    list                     List the OTPs in your store (the default)
    add {name} {url|secret}  Add a named OTP
    code {name|url|secret}   Generate a code
  OTP URLs are stored in ${HOME}/.local/org.fordi.otp.store, as an SQLite3 database,
  and are encrypted with a secret key; the key is in your Gnome secret service, or 
  Windows credentials manager or, failing those, the file ${HOME}/.local/org.fordi.otp,
  itself encrypted with a hash of `$USER:$UID:{APP_SECRET}`
  it ain't much, really - someone with local root could probably figure it out,
  but makes damn certain it's not in cleartext.
  Examples:
    $ otp add npm otpauth://totp/npm:user?secret=Y52TLDU3HF4QVNOBY7443DVPOWHL2YVO&issuer=npm
    $ otp code npm # code for npm is now on your clipboard
    $ otp code -cs npm # or just `otp -cs npm`
    196898
    $ otp list # or just `otp`
    npm
    github
    $ otp -cs code FHPOM7WEUIIXNCP5 # or otp -cs FHPOM7WEUIIXNCP5
    936297
    $ npm publish --access=public --otp=$(otp npm) # command-line publish without the fuss
```
