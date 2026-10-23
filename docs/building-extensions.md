# Building Extensions

Use the source catalogue when you want to add or change an extension.

## Scaffold

```powershell
npm run new -- my-extension
```

```sh
npm run new -- my-extension
```

This creates `packages/extensions/src/my-extension/` from `_template`, regenerates the
catalogue (`npm run catalog`) and prints the checklist below. The untouched scaffold passes
`npm run verify` (`tests/new-extension-smoke.ts`).

## Implement

Edit:

- `packages/extensions/src/my-extension/index.ts`
- `packages/extensions/src/my-extension/extension.json`

Keep the extension self-contained. Runtime code may import Node built-ins and declared package peers, but it must not import from sibling extensions or `packages/core/lib`.

## Add to a Profile

The template declares `"profiles": []`, so a new extension ships in no profile. To include it in
a profile (for example `lite`), add its stable extension name to the profile's `include` list in
`packages/kit/profiles/<profile>.json` and to the `profiles` field of its `extension.json`; the
two must match or `npm run verify` fails. Then check:

```sh
npm run profile:check -- --profile lite
npm run smoke:package
```

## Classify the New Files

A checkout that contains `internal/public-release/manifest.json` classifies every file: add each
new file to its sorted `public` list (the scaffolder prints the paths when the manifest exists).
The public repository has no manifest, so there is nothing to classify there.

## Update the Catalogue

After editing `extension.json`, regenerate the catalogue:

```powershell
npm run catalog
```

```sh
npm run catalog
```

The generated catalogue appears in [Extension Catalogue](EXTENSIONS.md).

## Verify

```powershell
npm run verify
```

```sh
npm run verify
```

For the full extension-writing reference, see [Writing Extensions](WRITING_EXTENSIONS.md).
