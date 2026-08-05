# TP6-S CUS Protocol Reference

Complete reference for the binary protocol the TP6-S thermal printer speaks over BLE GATT.
This absorbs and supersedes the short protocol summary in the top-level `README.md`.

## 1. Scope & sources

This document is organized **by verification tier**, not by topic. Every claim below is
tagged with where it comes from, because the sources behind this reference disagree with
each other on several points:

- Static analysis of the vendor Android app's native printing library, obtained by
  disassembling the official app (YK SDK 1.0.104). Never validated against real hardware.
  Several of its claims are demonstrably wrong (see §5, Tier C).
- This repository's own code (`tp6s_tool.py`, `web/app.js`) and its commit history — the
  **highest-authority source**, since it runs against a real printer.
- Direct hardware observations reported by a user of this tool, not present in any prior
  source (§5 density note, §6 ACK telemetry, §8 line-count ceiling, §9 buffer flush).

Authority order used throughout: **running code + git history > direct hardware observation
> static analysis alone**.

Three tiers appear throughout the command and fact tables:

| Tier | Meaning |
|---|---|
| **A — Verified** | Exercised by this repo's CLI and/or web implementation, or confirmed by direct hardware observation. |
| **B — Static analysis only** | Extracted from disassembly, never exercised here. Treat as a lead, not a fact. |
| **C — Superseded / known-wrong** | Claimed by the static-analysis document, disproved by evidence. Kept here so it's not rediscovered the hard way. |

## 2. Device overview

- TP6-S: 2", 300 DPI thermal printer, 576 px print width, roll paper.
- Two transports exist on the physical device: BT Classic SPP (Android only,
  `00001101-0000-1000-8000-00805F9B34FB`) and BLE GATT (iOS, and the only option for
  Web Bluetooth). The BLE address is the SPP address + 1 in the last octet.
- This repo talks BLE GATT exclusively.

## 3. BLE transport

### GATT service and characteristics

| Role | Primary UUID | Fallback UUID |
|---|---|---|
| Service | `0000fff0-0000-1000-8000-00805f9b34fb` (`0xFFF0`) | `0000ff00-…` (`0xFF00`) |
| Write (host → printer) | `0000fff2-…` (`0xFFF2`) | `0000ff02-…` (`0xFF02`) |
| Notify (printer → host) | `0000fff1-…` (`0xFFF1`) | `0000ff01-…` (`0xFF01`) |

*Tier A.* Both the CLI (`_find_uuids`, `tp6s_tool.py`) and the web app (`web/app.js`) probe
`FFF0` first and fall back to `FF00`. The static-analysis document claims `FF00` is
*the* primary service — that's Tier C, superseded (see §5).

### Discovery — the two implementations differ

- **CLI**: `BleakScanner.discover()` lists every nearby BLE device and flags any that
  advertise the `FFF0`/`FF00` service UUID. No name filtering.
- **Web app**: filters on `namePrefix: "TP6"` at the `requestDevice()` level (Web Bluetooth
  requires a filter). Matches `TP6-S` and other `TP6*` devices.

The top-level README currently says BLE scan works "by device name prefix" — that's only
true for the web app. Corrected in the README update alongside this document (see repo
`README.md`).

### Chunking

| | CLI (`tp6s_tool.py`) | Web (`web/app.js`) |
|---|---|---|
| Chunk size | `MTU - 3` (typ. 244 with negotiated MTU) | hard-capped at 20 bytes |
| Inter-chunk delay | 20 ms | 4 ms |
| MTU negotiation | via `bleak` | none — Chrome/Web Bluetooth doesn't expose MTU negotiation, so the cap assumes the default ATT MTU of 23 |
| Error handling | none special | adaptive halving: on a GATT write error, halves the chunk size (floor 20 B) and retries the same chunk |

The 20-byte web cap is safe because **the firmware reassembles a CUS frame using the LEN
field in the frame header**, not the BLE chunk boundaries — chunk size is a transport-layer
detail only, unrelated to the protocol framing.

## 4. CUS frame format

```
Offset  Size  Field
0       1     Magic — 0x64
1       1     CMD
2       1     SEQ — 6-bit counter, wraps at 0x3F
3-4     2     Payload length N, uint16 little-endian
5..     N     Payload
N+5..   4     TX checksum — always 0x00000000 (not verified by the printer)
last    1     Footer — 0x9B
────────────────────────────────────────────────
Total = N + 10 bytes
```

**SEQ**: the CLI and web implementations post-increment (`_seq = (_seq + 1) & 0x3F` after
use), so the first frame carries `SEQ=0`. Nothing in the evidence available here shows the
firmware validating or rejecting a particular SEQ value.

### RX checksum (printer → host)

*Tier B — documented from static analysis, verified by neither implementation in this
repo* (both simply check `raw[0] == 0x64`). Included here for reference if strict
validation is ever needed:

```python
def verify_rx_checksum(frame):
    chk = 0x12345678
    for i in range(len(frame) - 5):
        chk += frame[i]
    chk = (chk + frame[-1]) & 0xFFFFFFFF
    stored = int.from_bytes(frame[-5:-1], "little")
    return chk == stored
```

## 5. Command reference

### Tier A — Verified

| CMD | Name | Payload | Notes |
|---|---|---|---|
| `0x00` | Print image data | raw 1bpp, MSB-first, **no header** | see §7 |
| `0x02` | Feed paper | `[N, 0x00]` (2 bytes) | N = dot-lines to advance |
| `0x09` | Set print density | `[D]`, D ∈ [1, 15] | see density note below |
| `0x0A` | Set print speed | `[S]`, S ∈ [1, 5] | |
| `0x80` | Get BLE token bytes (flow control) | none | see §6 — largely redundant given ACK pacing |

> **Density is `0x09`, not `0x04`.**
> `0x04` is ACKed by the firmware but ignored — density never moves off the factory
> default when you send it.
>
> *How this was confirmed:* byte 4 of the 8-byte image-frame ACK payload echoes the
> printer's current density (see §6). It stays pinned at `9` no matter how many `0x04`
> frames are sent, and tracks the requested value immediately after a `0x09` frame.
>
> The UART help text in `tp6s_tool.py` already documented `cus 09 08` as "set density to
> 8" before this was formally confirmed — `0x04` looks like a transcription slip somewhere
> upstream rather than a different firmware revision.

### Tier B — Static analysis only, untested

Extracted from `libykDataPacket.so` disassembly. Never exercised against real hardware by
this repo or its documentation sources. Confirm with a BLE capture before relying on these.

| CMD | Assumed function | Payload |
|---|---|---|
| `0x08` | Set auto-off time | `[minutes]` |
| `0x10` | Get printer status | none |
| `0x11` | Get firmware version | none |
| `0x12` | Get serial number | none |
| `0x18` | Get paper type | none |
| `0x31` | Power off | none |
| `0x52` | Cancel task | none |

### Tier C — Superseded / known-wrong

The single highest-value table in this document — these are claims from static analysis
that have since been disproved, kept here so they aren't rediscovered the hard way.

| Static-analysis claim | Reality | Evidence |
|---|---|---|
| Image CMD = `0x03` | `0x00`; `0x03` is `cusSearchHeaderForLabelPaper` (label paper search), not image data | `CMD_PRINT_IMAGE = 0x00` in `tp6s_tool.py`, confirmed against real hardware |
| `0x04` = FeedBackPaper | ACKed but ignored; historically the wrong density opcode | commit `fe48dae` "Fix density opcode: 0x09, not 0x04"; density-echo observation above |
| Service `FF00` is primary | `FFF0` is primary, `FF00` is a fallback | `_find_uuids()` in `tp6s_tool.py`; `web/app.js` service probing |
| Feed payload is `[lines]` (1 byte) | `[N, 0x00]` (2 bytes) | `tp6s_tool.py`, `web/app.js` |
| Density values are 7/12/15 only | Range is `1–15`, clamped | `tp6s_tool.py` |
| Whole image fits in one CUS frame | Sliced into 8-line frames (586 B); firmware accepts up to 24 (§8) | `MAX_CHUNK_LINES = 8` |
| Scan matches exact name `== "TP6-S"` | Web matches `namePrefix "TP6"`; CLI matches by advertised service UUID | commit `dc445d3` |

## 6. Printer → host ACK: a telemetry channel

The printer replies on the Notify characteristic (`0xFFF1`/`0xFF01`) after each frame. Frame
layout:

```
raw[0]           = 0x64  (magic)
raw[1]           = cmd   (echo of the command)
raw[3]|raw[4]<<8 = n     (ACK payload length)
raw[5..5+n-1]    = payload
```

*Tier A, from direct hardware observation.* The 8-byte payload of an **image-frame** ACK
decodes to more than just a temperature reading — it's a full telemetry frame:

| Payload byte | Frame offset | Meaning |
|---|---|---|
| `0–1` | `raw[5..6]` | Battery voltage in **mV**, little-endian |
| `2` | `raw[7]` | Flags |
| `3` | `raw[8]` | Always `0x10` in observed captures |
| `4` | `raw[9]` | **Current density (echo)** — the field that proves the `0x09` vs `0x04` finding above |
| `5` | `raw[10]` | Unknown |
| `6` | `raw[11]` | Temperature — reads `70` cold, `90` hot → **likely °F**, not °C (no reference measurement available to confirm) |
| `7` | `raw[12]` | Battery percentage |

`tp6s_tool.py`'s `_ack_temp()` and this repo's temperature displays label this field `°C`
(`T={t}°C`) — that unit label is probably wrong given the observed range. Not changed in
code as part of this documentation update; flagged here for a future fix.

### The ACK as a verification channel

The density echo is what makes the ACK payload useful beyond telemetry display: it lets any
setting opcode be validated by observing whether it actually changed printer state, instead
of trusting that a frame being ACKed means it took effect. That's the method that settled
`0x09` vs `0x04`.

### Two consequences for flow control and diagnostics

1. **ACKs are paced by consumption, not reception.** One ACK arrives per frame the printer
   actually *prints*, not per frame *received*. That makes the ACK stream usable directly as
   flow control: keeping N frames in flight and letting the ACK stream throttle you would
   beat the stop-and-wait pattern both implementations currently use. This makes `0x80`
   (`GetBleTokenBytes`) largely redundant as a separate flow-control mechanism in the
   nominal case.
2. **Mid-print pauses on dense artwork are thermal/power throttling, not a driver bug.**
   The battery voltage visibly sags in the ACK stream during large solid-black areas — this
   is directly observable rather than a hypothesis. Worth stating explicitly: it is easy to
   spend real time chasing this as a bug in client code before reading the telemetry.

Stale ACKs from the preceding speed/density frames are drained before the image loop starts
(`tp6s_tool.py`); the RX checksum (§4) is documented but verified by neither implementation
in this repo.

## 7. Image encoding

- 576 px wide, 72 bytes/line, MSB-first bit order.
- `bit = 1` → ink (black pixel); `bit = 0` → blank.
- Payload for `CMD=0x00` is **raw 1bpp with no header** — no width/height fields, just
  pixels.
- Luminance threshold for RGB565 → 1bpp conversion: `0xAB` (171).

### PIL polarity — the #1 cause of inverted prints

PIL's mode `'1'` uses bit `0` = black, the opposite of the printer's convention (bit `1` =
ink). `cmd_print_raster()` XORs the raw bytes with `0xFF` after conversion
(`tp6s_tool.py`) to correct this. Any custom conversion path that skips this step prints
inverted.

Other encoding details from the CLI's image pipeline:
- Alpha channels are composited onto a white background *before* grayscale conversion
  (commit `a2d4740`) — converting straight to `'L'` ignores alpha and can blacken
  transparent regions.
- Floyd-Steinberg dithering is the default; `--nodither --threshold N` selects fixed
  thresholding instead.
- **Minimum-height padding**: prints shorter than `min_height=64` lines are zero-padded up
  to 64 lines (`tp6s_tool.py`) — an empirical requirement to reliably engage the thermal
  head, not documented anywhere else. Undocumented before this reference; worth knowing
  before treating short prints as a bug.

## 8. Lines per image frame — the 24-line ceiling

`MAX_CHUNK_LINES = 8` is this repo's safe default (586-byte frames). *Tier A, from direct
hardware observation*: the firmware actually accepts image frames up to **24 lines**
(≤ 1738 bytes) — a real speedup, since fewer CUS frames are needed for the same image.

| Lines/frame | Frame size | Behavior |
|---|---|---|
| 8 | 586 B | This repo's default — safe |
| ≤ 24 | ≤ 1738 B | Accepted by the firmware — real speedup |
| 32 | 2314 B | ⚠️ **Silent failure**: every frame is ACKed normally, then nothing prints — the printer feeds blank paper. No error, no NAK. |

The ACK is **not** proof of printing beyond the ceiling — that's exactly what makes this
failure mode expensive to diagnose: everything *looks* successful. This repo's code is not
changed by this update; `MAX_CHUNK_LINES` stays at `8`. Raising it to exploit the available
margin is a separate, deliberate code change.

## 9. Canonical print sequence

```
1. CMD=0x0A  SetSpeed(S)
2. CMD=0x09  SetDensity(D)
3. CMD=0x00  × N frames of ≤8 lines each — raw 1bpp payload
4. CMD=0x02  FeedPaper([lines, 0x00])
```

**Step 4 is not cosmetic paper advance** (*Tier A, direct observation*): after the last
image frame, the printer holds any remaining buffered lines for several seconds of idle
before printing them on its own. Sending `CMD_FEED` immediately after the final image frame
forces an immediate flush. Skip it, and the tail of a print job can look "lost" when it will
in fact print later, delayed — a diagnostic trap worth flagging explicitly.

Observed timings: ~0.15 s settle after speed/density frames; per-frame ACK wait up to 5 s
before treating a frame as timed out.

## 10. Protocol constraints

Two hardware-derived constraints, stated here as protocol rules:

1. **Never interleave another CUS frame inside a multi-chunk CUS frame in flight.** Doing so
   (e.g. calling the `0x80` flow-control probe mid-frame) injects a foreign
   `[0x64][0x80]...` sequence into the middle of an image frame's BLE chunks, resetting the
   firmware's CUS parser. Only call another command between two *complete* CUS frames.
2. **Arm the ACK wait before writing, not after.** If the ACK-wait event is cleared after
   the frame is sent, an ACK that arrives during transmission (common for short frames) sets
   the event, which then gets immediately cleared — producing a full timeout (multiplied
   across every frame in a print job) for no reason. Clear/arm the wait state before the
   write.

## 11. Experimental probes — not part of the working protocol

`tp6s_tool.py` exposes `--cmd` (override the image opcode) and `--hdr` (`_build_hdr_fn`,
`NN`/`WW` header tokens) as **exploration tools for probing unconfirmed frame layouts**, not
as documentation of the actual format. The payload that works in production is raw 1bpp
with no header (§7). Treating these flags as protocol truth would reintroduce exactly the
kind of unverified claim this document tries to avoid.

## 12. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Density never changes | Using opcode `0x04` instead of `0x09` | Check the density echo at `payload[4]` of the ACK |
| Every frame ACKed, paper comes out blank | Image frames longer than 24 lines | Drop back to ≤ 24 lines/frame |
| Mid-print pauses on dense artwork | Thermal/power throttling | Not a bug — watch battery voltage in the ACK stream |
| Tail of the document doesn't print (or prints late) | Firmware holds the end-of-buffer | Send `CMD_FEED` right after the last image frame |
| Print comes out inverted | PIL mode `'1'` polarity | XOR the bytes with `0xFF` |
| Can't connect | Wrong UUID assumed | Check for `FFF0` first, fall back to `FF00` |
| `OSError` / write failure | MTU too small or uninitialized | Negotiate MTU before writing (CLI only — not available in Web Bluetooth) |
| Data loss during printing | BLE buffer overrun | ACK stream is already paced by consumption (§6); `0x80` remains available as a fallback |

## 13. Implementation matrix

| Aspect | CLI (`tp6s_tool.py`) | Web (`web/app.js`) |
|---|---|---|
| BLE stack | `bleak` (asyncio) | Web Bluetooth |
| Chunk size | negotiated MTU − 3 (typ. 244) | fixed 20 B |
| Inter-chunk delay | 20 ms | 4 ms |
| Adaptive chunk shrink on error | no | yes (halves to floor 20 B) |
| JPEG/PNG input | yes (PIL, Floyd-Steinberg or threshold) | yes (`<canvas>`) |
| PBM P4 input | yes | — |
| Freehand drawing | — | yes (`Dessin` tab) |
| Flow control (`0x80`) | implemented (`_check_tokens`) | not used |
| ACK-paced pipelining (§6) | **not implemented** — stop-and-wait per frame | **not implemented** — stop-and-wait per frame |
| Scan filter | advertised service UUID | `namePrefix "TP6"` |

## 14. Provenance & re-verification

Static-analysis facts (Tier B and the historical Tier C claims) originate from a
disassembly of the vendor's native printing library (ARMv7, YK SDK 1.0.104), extracted
from the official Android app. Tier A facts come from this repo's shipping code, its git
history, and direct hardware observation reported against a real TP6-S unit — none of the
telemetry decoding in §6, the 24-line ceiling in §8, or the buffer-flush behavior in §9
come from static analysis; they were not previously documented anywhere.

To re-verify or extend any Tier B claim:

- **Android + Wireshark**: enable Bluetooth HCI snoop logging in Android developer options,
  print from the official app, pull `btsnoop_hci.log`, open in Wireshark.
- **nRF Sniffer**: flash an nRF52840 dongle with the nRF Sniffer firmware, capture live BLE
  traffic in Wireshark with the nRF Sniffer plugin.
- **Frida**: hook the official app's print-command method on Android to log the exact bytes
  it sends.
