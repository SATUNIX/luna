# Tool I/O Capture

`tool-capture` keeps a lossless record of every tool call the agent makes and every output it
gets back, for audit, incident review and SIEM ingestion. It ships in every profile.

The firewall audit (`.pi/tool-firewall-audit.jsonl`) records *decisions*, and trace-ledger
(`.pi/trace.jsonl`) records *facts* (tool, target, hashes). Both are redacted and short.
trace-ledger redacts only the first 1 KiB of a target and stores 200 characters of it, so a
200 KB command is logged in well under 200 ms and still reports its full length in
`targetOriginalLength` (`tests/trace-ledger-bound-smoke.ts`).
Capture records the *content*: the exact arguments and the exact result, including output
the firewall blocked or the tool truncated.

## What is recorded

One JSON object per line. Every record carries `v`, `ts`, `seq` (per process, increasing),
`host`, `pid`, `kind`, and for tool records `session`, `rootSession`, `child`, `agent`,
`cwd`, `toolCallId` and `tool`.

| kind | When | Payload |
|---|---|---|
| `session` | session start / shutdown | reason, argv, whether redacted mode is on |
| `call` | `tool_execution_start`, before the firewall decides | `args` exactly as the model sent them; `actionHash`, `argsHash` |
| `result` | `tool_execution_end`, for every call | `result` (content + details) exactly as the model saw it, `isError`, `durationMs` |
| `attachment` | a bash result pi truncated | `content`: pi's full-output file, stored whole |
| `gap` | after records were dropped under disk pressure | how many, and why |

Blocked calls get a `call` and a `result` (with `isError: true` and the firewall's reason), so
the record shows what the agent *tried*, not only what ran.

### Joining with the other logs

- `toolCallId` is on capture records, trace-ledger entries and firewall audit records.
- `actionHash` is the firewall's action hash: sha256 of the key-sorted JSON of
  `{toolName, input}`. It matches `actionHash` in the firewall audit, grants and feedback.
- `argsHash` is trace-ledger's `argsHash`.
- `rootSession` is the firewall's root session, so a subagent's records join its parent's.

## Lossless encoding

Nothing is truncated or replaced by a placeholder:
- Strings larger than `PI_KIT_CAPTURE_INLINE_BYTES` (32 KiB) are stored as gzip
  **blobs** named by the sha256 of their exact bytes, in `blobs/<aa>/<sha256>.gz`. The record
  holds `{"$blob":"sha256:…","bytes":n,"encoding":"utf8"}`. Strings containing lone surrogates
  (which UTF-8 cannot carry) use `"encoding":"utf16le"`.
- Bytes (`Buffer`, `Uint8Array`) become blobs with `"encoding":"bytes"`.
- Binary and garbage output (`cat /dev/urandom`), NULs, control characters and lone
  surrogates are escaped by JSON, so every line stays valid JSON and parses back to the same
  string.
- Values JSON cannot express are tagged: `{"$bigint":"…"}`, `{"$number":"Infinity"}`,
  `{"$date":"…"}`, `{"$undefined":true}`, `{"$circular":true}`, `{"$function":"name"}`,
  `{"$error":…}`, `{"$map":[…]}`, `{"$set":[…]}`.
- When pi truncates a bash result, it keeps the full output in a temp file
  (`details.fullOutputPath`). Capture streams that file into a blob in the background and
  links it with an `attachment` record.

A blob is skipped only for a stated reason, and the record says so:
`{"$blob_skipped":"exceeds_max_blob_bytes"|"disk_pressure"|"write_error: …","bytes":n,"sha256":"…"}`.

## Storage layout

```text
~/.pi/agent/pi-kit/capture/            0700
  segments/<host>-<pid>-<start>-<n>.jsonl      the process's active segment (0600)
  segments/<host>-<pid>-<start>-<n>.jsonl.gz   rotated and compressed
  blobs/<aa>/<sha256>.gz                       content-addressed large values
  retention.jsonl                              every file the pruner deleted, and why
```

- **Concurrency.** Each process writes only its own segment, so concurrent sessions and
  subagents never interleave or tear lines, and the hot path takes no locks. Blobs are written
  to a temp file and renamed, so concurrent writers of the same blob are safe.
- **Rotation.** A segment rotates at `PI_KIT_CAPTURE_SEGMENT_BYTES` (32 MiB) and at session
  shutdown, and is gzip-compressed in the background. At start, segments left uncompressed by
  dead processes (crash, `kill -9`) are compressed.
- **Budget.** Compressed segments and blobs are kept under `PI_KIT_CAPTURE_MAX_BYTES`
  (2 GiB). The filesystem must keep `PI_KIT_CAPTURE_MIN_FREE_BYTES` (1 GiB) free. When
  either limit is crossed, the oldest compressed segments and least recently used blobs are
  deleted down to 90% of the budget, and each deletion is logged in `retention.jsonl`. Active
  segments are never pruned. If space is still short, new blobs are skipped; if it is
  critically short, records are dropped and a `gap` record says how many.

## Secrets

Values are stored **byte-exact, secrets included**. That makes the log useful for incident
review, and it makes the log itself sensitive:
- the directory is `0700` and every file `0600`;
- `protected-paths` blocks agent writes into it, in every policy;
- the firewall classifies reading it as a **credential read**. That is high tier, and it
  feeds secret → egress detection;
- setting `PI_KIT_CAPTURE*` from the agent's shell counts as a safety-env override;
- every record lists the secret kinds it contains in `secrets`, e.g.
  `["github_token","private_key"]`, so a SIEM can alert on them without reading values.

`PI_KIT_CAPTURE_REDACT=1` stores redacted values instead (`[REDACTED:<kind>]`, and
`redacted: true` on the record). In that mode, full-output attachments are skipped, because
they cannot be scanned in place.

The scan reads at most 4 MiB of string data per record, and every pattern runs in linear time:
200 KB of adversarial text such as a repeated `x_token` scans in well under 200 ms
(`tests/tool-capture-smoke.ts`). A `password_assignment` key may carry a prefix or suffix
(`DB_PASSWORD=`, `MY_SECRET_KEY =`), and an unclosed quoted value is redacted to the end of
the line (`tests/tool-capture-smoke.ts`). A record with string data past the 4 MiB budget
carries `unscanned: true`, so a SIEM knows its `secrets` list covers only the first 4 MiB. In
redact mode the text past the budget is not stored: it is replaced with `[REDACTED:unscanned]`
and the record is marked `redacted: true` (`tests/tool-capture-smoke.ts`).

## Failure behaviour

Capture never breaks the agent. Every hook is wrapped. A failure (unwritable directory, full
disk) is counted, reported once, and shown by `/capture`, and the tool call proceeds.
Capture retries opening the store on later calls.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PI_KIT_CAPTURE` | on | `0` disables capture |
| `PI_KIT_CAPTURE_DIR` | `<agent dir>/pi-kit/capture` | where the log lives |
| `PI_KIT_CAPTURE_REDACT` | off | `1` stores redacted values |
| `PI_KIT_CAPTURE_MAX_BYTES` | 2 GiB | budget for compressed segments + blobs |
| `PI_KIT_CAPTURE_MIN_FREE_BYTES` | 1 GiB | free space to leave on the filesystem |
| `PI_KIT_CAPTURE_SEGMENT_BYTES` | 32 MiB | rotate a segment after this size |
| `PI_KIT_CAPTURE_INLINE_BYTES` | 32 KiB | larger strings become blobs |
| `PI_KIT_CAPTURE_MAX_BLOB_BYTES` | budget / 4 | larger single values are recorded as skipped |

`/capture` shows the directory, active segment, usage against the budget, free space, and this
process's counts (records, blobs, pruned, dropped, errors). `/capture prune` applies the
budget now.

## Shipping to a SIEM

Point a file collector (Vector, Fluent Bit, Filebeat, Splunk UF) at `segments/*.jsonl` for
live tailing, or at `segments/*.jsonl.gz` for batch ingestion. Each line is independent JSON.
Resolve `$blob` references by reading `blobs/<first two hex>/<sha256>.gz` and gunzipping it;
the sha256 of the result equals the name. Useful alert fields are `secrets`, `isError`,
`tool`, `actionHash` (to join the firewall's decision) and `rootSession`.

```sh
# every call and result of one tool call, across all segments
zcat -f ~/.pi/agent/pi-kit/capture/segments/* | jq -c 'select(.toolCallId=="<id>")'
```
