# @qmxme/pi-rottweiler

Command guard extension for [pi](https://github.com/badlogic/pi) that blocks destructive or dangerous shell commands before they run.

## Features

Blocks the following before execution:

- **Pushes to protected branches**: `git push` targeting `master` or `main` (including `git push` / `git push <remote>` while on `master` or `main`). Pushes to any other branch are allowed.
- **Other destructive git operations**: `git push --tags`, `git update-ref`, `git tag -d`, `git reset --hard`
- **Release / version bumps**: `npm version`
- **System / environment switches**: `nixos-rebuild switch`, `home-manager switch`
- **The ssh family**: `ssh`, `ssh-add`, `ssh-agent`, `ssh-copy-id`, `sshd`, `sftp`, `scp`, `slogin`
- **Whole-filesystem scans**: `find /` (find on the entire filesystem)

## How it works

Rather than regex-matching raw text (which both over-blocks words inside commit messages/strings and under-blocks wrapped invocations), rottweiler **tokenizes** the shell command and inspects the actual command words (argv[0]) — after shell separators and common wrapper commands (`sudo`, `timeout`, `xargs`, `env`, `nohup`, ...). Quoted text is treated as data, not commands, so words like `ssh` in a commit message or echoed string don't trigger a block.

It also recurses into `shell -c '<command>'` forms to catch commands nested inside a shell invocation.

## Installation

```bash
pi install npm:@qmxme/pi-rottweiler
```

With a pinned version:

```bash
pi install npm:@qmxme/pi-rottweiler@0.1.0
```

Project-local installation:

```bash
pi install npm:@qmxme/pi-rottweiler -l
```

Try without installing:

```bash
pi -e npm:@qmxme/pi-rottweiler
```

## Development

```bash
npm install      # install type-checking dependencies
npm run typecheck  # type-check the extension
npm test         # run the regression test suite
npm run dev      # watch mode
```

## License

MIT
