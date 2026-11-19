# Your own packages

Luna installs and pins its own companion packages (see [Profiles](profiles.md) and
[Supply chain](supply-chain.md)). `/packages` is for the pi packages you choose yourself. Luna has
not reviewed them: you accept each one, and the kit records exactly what you accepted.

```text
/packages search [words]          npm packages with the keyword pi-package (read-only)
/packages review <name>[@version] what an add would accept (read-only)
/packages add <name>[@version]    show the review, ask, then pin and install
/packages remove <name>           remove a package /packages added
/packages list                    what /packages added
```

`/packages` is an operator command. The model has no tool for it, and an add or a remove needs a
choice at the terminal of an interactive root session. Headless, RPC and delegated or child sessions
are refused. The default answer is "no".

## What an add does

1. **Review.** It reads the package's registry metadata and shows:
   - the install scripts npm would run (`preinstall`, `install`, `postinstall`, `prepare`);
   - the dependencies, the maintainers, and when that version was published;
   - its sha512 integrity.

   The review starts with an `UNREVIEWED` banner.
2. **Ask.** You choose to add that exact version with that integrity, or not.
3. **Check the registry again.** The add is refused before pi runs when:
   - the registry now serves a different integrity;
   - the downloaded tarball does not hash to the integrity you accepted;
   - the tarball is on another origin;
   - the package is one of Luna's companions (current or retired) or Luna itself;
   - the package is already added.
4. **Install.** `pi install npm:<name>@<version>` runs at user scope with lifecycle scripts off
   (`npm_config_ignore_scripts=true`). The integrity npm recorded must match the pin; otherwise the
   package is removed again.
5. **Record.** The pin goes into `~/.pi/agent/pi-kit/user-packages.json` (0600) with
   `"review": "user-accepted"` and the time you accepted it. Run `/reload` to load the package.

`/packages remove` removes only a package the ledger recorded. It refuses Luna's companions (change the
profile instead) and anything else installed another way.

The registry comes from `npm_config_registry` (default `https://registry.npmjs.org`). Plain `http` is
refused except to loopback, and so is a registry URL that carries credentials. Every response body is
capped (8 MiB for metadata, 64 MiB for a tarball) and every request times out after 30 seconds.

From a shell, the same commands run as `node packages/core/packages.ts <verb> ...`. There an add needs
`--accept <sha512>`, the integrity `review` printed, so an add is never unattended.

`tests/user-packages-smoke.ts` pins each rule against a local fixture registry and a stub `pi`,
including a tampered tarball that is refused.

## Not covered

- Luna does not review these packages. Install scripts are off, but the package's code runs inside
  pi when it loads, with pi's permissions.
- The tools a package adds go through the tool firewall like any other tool. No rule treats a tool
  from a user-added package differently.
- `/update` does not upgrade these packages. Remove one and add the new version.
