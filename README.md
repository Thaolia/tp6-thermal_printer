# TP6-S BLE Thermal Printer Toolkit

Control a **TP6-S Bluetooth thermal printer** from a PC or directly from a browser — no
driver, no proprietary app.

Two interfaces, same protocol:

| Interface | Stack | Entry point |
|-----------|-------|-------------|
| CLI (Python) | `bleak` + `PIL` | `python tp6s_tool.py <cmd>` |
| Web app | Web Bluetooth + Canvas | `web/tp6s.html` in Chrome/Edge |

---

## Features

- **BLE scan** — discover TP6-S printers by device name prefix.
- **Raster printing** — images resized to 576 px wide, 1-bpp Floyd-Steinberg dither (or
  fixed threshold). Supports JPEG, PNG, PBM (CLI) and any format accepted by `<canvas>`
  (web).
- **Text printing** — converts a string to a raster bitmap via a built-in font.
- **Draw canvas** (web only) — freehand drawing on a 576 px canvas, print directly.
- **Paper feed** — advance N dot-lines.
- **Test patterns** — full-black, bar pattern, or white (blank) test pages.
- **Settings** — print density (1–15), print speed (1–5).
- **UART diagnostic terminal** — raw BLE notify/write console for debugging.

---

## Requirements

### CLI

- Python 3.9+
- `pip install bleak pillow`

### Web app

- Chrome or Edge (Web Bluetooth API required — Firefox and Safari are not supported).
- No installation — open `web/tp6s.html` directly from disk.

---

## CLI Usage

```
python tp6s_tool.py <command> [arguments]
```

| Command | Description |
|---------|-------------|
| `scan` | Scan for TP6-S printers and print their BLE addresses. |
| `info <addr>` | Connect and dump BLE services, characteristics and GATT info. |
| `uart <addr>` | Interactive raw BLE terminal (type hex frames, read notifications). |
| `feed <addr> [N]` | Feed N dot-lines (default 64). |
| `test <addr> [black\|bars\|white]` | Print a test pattern page. |
| `print <addr> "text"` | Print a text string as a raster bitmap. |
| `image <addr> <file>` | Print an image (JPEG / PNG / PBM). |

### `image` options

| Flag | Default | Description |
|------|---------|-------------|
| `--nodither` | — | Use fixed threshold instead of Floyd-Steinberg dither. |
| `--threshold N` | 128 | Binarisation threshold (0–255) when `--nodither` is set. |
| `--rotate D` | 0 | Rotate image D degrees before printing (e.g. `90`, `180`, `270`). |

### `test` options

`--px N` print line height in dots · `--before N` feed before · `--after N` feed after ·
`--lines N` number of test lines · `--hdr` include header line · `--cmd 0xNN` raw command byte.

### Examples

```bash
# Discover printers
python tp6s_tool.py scan

# Print an image with dithering
python tp6s_tool.py image AA:BB:CC:DD:EE:FF photo.jpg

# Print an image rotated 90°, no dither, threshold 100
python tp6s_tool.py image AA:BB:CC:DD:EE:FF label.png --nodither --threshold 100 --rotate 90

# Print text
python tp6s_tool.py print AA:BB:CC:DD:EE:FF "Hello, world!"

# Feed 32 lines
python tp6s_tool.py feed AA:BB:CC:DD:EE:FF 32
```

---

## Web App Usage

1. Open `web/tp6s.html` in **Chrome** or **Edge**.
2. Click **Connect** — the browser's BLE picker lists nearby TP6-S printers.
3. Use the tabs:

| Tab | Function |
|-----|----------|
| **Image** | Load an image file, preview the dithered bitmap, print. |
| **Texte** | Type text and print it as a raster bitmap. |
| **Dessin** | Draw freehand on a 576 px canvas and print. |
| **Test / Feed** | Test patterns and paper feed controls. |
| **Diagnostic** | Raw UART terminal over BLE. |

> The web app reimplements the same Floyd-Steinberg dither and CUS framing as the Python
> CLI. BLE chunk size is capped at 20 bytes (Chrome ATT MTU limit).

---

## Protocol Notes

The TP6-S uses a proprietary **CUS** framing over BLE GATT:

```
[0x64] [CMD] [SEQ_6bit] [LEN_LO] [LEN_HI] [PAYLOAD …] [0x00 0x00 0x00 0x00] [0x9B]
```

| Attribute | Value |
|-----------|-------|
| BLE Service | `0xFFF0` (`0000fff0-0000-1000-8000-00805f9b34fb`) |
| Write characteristic | `0xFFF2` |
| Notify characteristic | `0xFFF1` |
| Alternate service | `0xFF00` / write `0xFF02` / notify `0xFF01` |
| Print width | 576 px = 72 bytes/line |
| Print bit convention | bit `1` = print (ink), `0` = blank |

Key opcodes: `0x00` print image · `0x02` feed · `0x04` set density · `0x0A` set speed ·
`0x80` BLE flow-control tokens.

---

## Project Structure

```
tp6-s/
├── tp6s_tool.py      # Python CLI (bleak + PIL)
├── web/
│   ├── tp6s.html     # Web app entry point (open in Chrome/Edge)
│   ├── app.js        # Web Bluetooth logic — port of tp6s_tool.py
│   └── style.css     # Stylesheet
├── LICENSE
└── README.md
```

---

## License

MIT — see [LICENSE](LICENSE).
