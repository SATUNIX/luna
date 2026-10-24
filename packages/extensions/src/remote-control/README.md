# remote-control

`/remote` — drive this pi from **pi remote**, the Android app in [`apps/android`](../../../../apps/android),
directly over the LAN or a VPN such as Tailscale. No cloud service is involved.

The user guide, the security design and the settings are in
[`docs/remote-control.md`](../../../../docs/remote-control.md). This file covers how the extension
is put together.

## Usage

```
/remote                          start the host if needed and share this session
/remote pair                     link a phone (QR code, then approve the device ID here)
/remote status                   addresses, certificate fingerprint, phones, shared sessions
/remote devices                  list linked phones
/remote revoke <id or name>      unlink a phone at once
/remote rename <id or name> <n>  rename a linked phone
/remote detach                   stop sharing this session (the host keeps running)
/remote stop                     stop the host
/remote reset                    new certificate and identity; every phone must link again
```

## How it works

- `host.ts` finds `packages/web-ui` (as `/console` does: `PI_KIT_WEBUI_ROOT`, then relative to
  this extension, then the checkout in the install marker), starts
  `packages/web-ui/server/remote-host.ts` detached when it is not already running, and speaks the
  host's loopback control channel with the secret from `control.json`.
- `index.ts` registers `/remote`, draws the pairing QR code as a widget, asks the operator to
  approve each link request, and re-shares the session after `/new`, `/resume`, `/fork` and
  `/reload` once `/remote` has been used in this pi process.
- `bridge.ts` shares the session with the host: the branch history, slimmed live events, prompts
  and steering from the phone (`pi.sendUserMessage`), abort, model and thinking changes, and the
  dialogs other extensions open, which it mirrors to the phone (the first answer wins).

The extension opens no socket and starts no timer until `/remote` is used, or, with
`PI_REMOTE_AUTO_ATTACH=1`, until a session starts while a host is already running. Commands that
link phones or share sessions work only in an interactive terminal, so a session driven from a
phone (rpc mode) cannot link another phone.

Self-containment: it imports only `node:*` builtins and pi peers.

## Tests

`npm run smoke:remote-control` (`tests/remote-control-extension-smoke.ts`) loads the extension
against the real host; `npm run smoke:remote-host` (`tests/remote-host-smoke.ts`) covers the host.
