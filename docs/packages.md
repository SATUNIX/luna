# Your own packages

Luna installs and pins its own companion packages (see [Profiles](profiles.md) and
[Supply chain](supply-chain.md)). `/packages` is for the pi packages you choose yourself. Luna has
not reviewed them: you accept each one, and the kit records exactly what you accepted.

```text
/packages search [words]          npm packages with the keyword pi-package (read-only)
/packages review <name>[@version] what an add would accept (read-only)
/packages add <name>[@version]    show the review and the terminal command that adds it
/packages remove <name>           show the terminal command that removes it
/packages list                    what /packages added
```

An add or a remove happens only in your own terminal, outside pi:

```sh
node <kit>/packages/core/packages.ts add <name>@<version>
node <kit>/packages/core/packages.ts remove <name>
```

Both print what they will do and ask you to type `yes`. They refuse when standard input or output is
not a terminal, so a pipe or a model's shell cannot answer for you. The `/packages` command in pi only
searches, reviews, lists and shows these commands; it never installs or removes anything. The model has
no tool for any of it. Not covered: a process running as you that drives a pseudo-terminal could
still type `yes`.

## What an add does

1. **Review.** It reads the package's registry metadata and shows:
   - the install scripts npm would run (`preinstall`, `install`, `postinstall`, `prepare`);
   - the dependencies, the maintainers, and when that version was published;
   - its sha512 integrity.

   The review starts with an `UNREVIEWED` banner.
2. **Ask.** At your terminal you type `yes` to add that exact version with that integrity from that
   registry, or anything else to stop.
3. **Check the registry again.** The add is refused before pi runs when:
   - the registry now serves a different integrity;
   - the downloaded tarball does not hash to the integrity you accepted;
   - the tarball is on another origin;
   - the package is one of Luna's companions (current or retired) or Luna itself;
   - the package is already added.
4. **Install.** `pi install npm:<name>@<version>` runs at user scope with lifecycle scripts off
   (`npm_config_ignore_scripts=true`). npm gets the reviewed registry explicitly (also as the scoped
   registry for a scoped name), so an `.npmrc` cannot send the install elsewhere. The integrity npm
   recorded must match the pin; otherwise the package is removed again.
5. **Record.** The pin goes into `~/.pi/agent/pi-kit/user-packages.json` (0600) with
   `"review": "user-accepted"` and the time you accepted it. If the ledger cannot be written, the
   package is removed again. Run `/reload` to load the package.

`remove` removes only a package the ledger recorded. It always refuses Luna's companions, even when the
ledger names one (change the profile instead), and anything else installed another way.

The registry comes from `npm_config_registry` (default `https://registry.npmjs.org`). Plain `http` is
refused except to loopback, and so is a registry URL that carries credentials. Every response body is
capped (8 MiB for metadata, 64 MiB for a tarball) and every request times out after 30 seconds.

Review text from the registry has control, bidi and zero-width characters replaced, so it reads as
stored.

`tests/user-packages-smoke.ts` pins each rule against a local fixture registry and a stub `pi`,
including a tampered tarball that is refused.

## Not covered

- Luna does not review these packages. Install scripts are off, but the package's code runs inside
  pi when it loads, with pi's permissions.
- Only the package itself is pinned and verified. Its dependencies resolve by version range when npm
  installs it; Luna neither pins nor verifies them, and the review says so.
- The tools a package adds go through the tool firewall like any other tool. No rule treats a tool
  from a user-added package differently.
- `/update` does not upgrade these packages. Remove one and add the new version.
