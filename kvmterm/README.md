# kvmterm

A text virtual terminal for the [DezKVM-Go](https://github.com/tobychui/DezKVM-Go) USB KVM. It turns the KVM's HDMI video + CH9329 keyboard into an interactive text terminal, so you can control a headless machine's console from your own terminal — no browser, no Web Serial API.

It works by reading the video feed, **reconstructing the remote terminal's text via glyph template matching** (far more accurate than OCR), and forwarding your keystrokes to the remote machine through the CH9329 HID chip.

## How it works

The DezKVM-Go exposes two things: the MS2109 HDMI capture card (video) and a CH9329 UART→USB-HID chip (keyboard/mouse). `kvmterm` drives both directly:

1. **Video → text**: capture a frame (ffmpeg), binarize it, then slice it into the terminal's monospace grid. Each cell bitmap is matched against a learned glyph set to recover the character. Because a terminal uses a fixed font, this is exact — no OCR confusion between `l`/`1` or garbled columns.
2. **Text → keystrokes**: local key presses are converted to CH9329 HID keyboard packets and sent over the serial port to the remote machine.

```
┌─────────────┐  USB video   ┌──────────────┐   ffmpeg   ┌────────────┐
│  remote PC  │ ───────────► │  MS2109 card │ ─────────► │  framegrab │
└─────────────┘              └──────────────┘            └────────────┘
       ▲                                                       │
       │ USB HID keyboard                                      ▼
       │                       ┌──────────────┐            ┌────────────┐
       └────────────────────── │  CH9329 chip │ ◄───────── │    hid     │
              serial           └──────────────┘  packets   └────────────┘
                                                               │
                                                     ┌─────────▼─────────┐
                                                     │  screen (render)  │
                                                     └─────────┬─────────┘
                                                               │ text grid
                                                     ┌─────────▼─────────┐
                                                     │  tui (interactive)│
                                                     └───────────────────┘
```

## Build

```bash
cd kvmterm
go build ./cmd/kvmterm
```

Requires Go 1.25+ and `ffmpeg` on the PATH. Cross-compiles to macOS, Linux, and Windows; the only external binary dependency is `ffmpeg`.

## Usage

```bash
./kvmterm
```

On first run it **calibrates**: it prints a lattice to measure the terminal's cell grid, then prints a reference grid of the 95 printable ASCII characters to learn the font. The result is cached in `~/.kvmterm-cal.json`, so later runs skip calibration.

Key flags:

| Flag | Default | Purpose |
|------|---------|---------|
| `--serial` | `auto` | Serial device (CH9329 bridge). `auto` scans common ports. |
| `--baud` | `115200` | Serial baud rate. |
| `--video` | OS-specific | Video device specifier (`0` for AVFoundation index on macOS, `/dev/video0` on Linux). |
| `--width` / `--height` | `1920` / `1080` | Capture resolution. |
| `--interval` | `300ms` | Frame poll period. |
| `--cal` | `~/.kvmterm-cal.json` | Calibration cache file (empty disables). |
| `--recalibrate` | — | Force re-calibration. |
| `--print` | — | Non-interactive: calibrate, grab one frame, print text, exit. |
| `--list-video` | — | List ffmpeg video devices and exit. |

### Controls

Inside the TUI, keystrokes are forwarded to the remote machine. The bottom status bar shows the remote grid size, the viewport, and the keyboard state.

- **F2** — connect/disconnect the keyboard. Disconnecting **closes the CH9329 serial port**, releasing it so another process (e.g. the browser control panel) can take over; reconnecting reopens and re-warms it. The status bar shows `kb connected` / `kb DISCONNECTED` (reconnect shows `kb connecting…`). While disconnected, keystrokes are **not** forwarded.
- **PageUp / PageDown** — scroll the local viewport.
- **Ctrl+Q** — quit `kvmterm`.
- Everything else (printable chars, Enter, Backspace, arrows, Tab, Delete, Home/End, Escape, and Ctrl+letter combos) is forwarded to the remote terminal.

The remote grid is rendered 1:1 into your terminal from the top-left. If the remote is larger than your terminal (e.g. a 240×67 console vs. an 80×24 window), enlarge your terminal or reduce its font to see more.

## Notes & limitations

- **Prerequisites**: the remote machine must be at a text terminal (e.g. a Linux getty / Proxmox console) for calibration to work. The serial port must not be held by another process (e.g. the DezKVM-Go web UI in a browser).
- **Font**: calibration learns whatever monospace font the remote uses, so it adapts to different consoles. Glyphs outside printable ASCII (box-drawing, the block cursor, etc.) render as `?`.
- **Colored text is flattened to ink/no-ink; color is not reconstructed.** The
  matcher binarizes each cell with an adaptive threshold (the midpoint of that
  cell's own brightness range) instead of a single fixed threshold, so dim
  colored text — e.g. the dark-blue addresses `ip` prints — decodes like plain
  white text. Very faint or heavily smeared glyphs (deep chroma ringing on the
  MS2109) can still decode wrong. Plain/white text (the common case — shell
  output, `ls`, `cat`, …) is reconstructed exactly.
- **One pixel of grid drift is tolerated.** Sub-pixel cell widths and video scaling slide the text grid sideways across a long line; the matcher retries cells against left/right shifted templates, so a long address no longer collapses into `???????.?/8`. More than a pixel of drift still needs a re-calibration.
- The remote is a *video* terminal, so this is fundamentally a screen reader + keyboard writer — it is not a serial console or SSH. For machines with working SSH, that is still the better tool; `kvmterm` is for when only the KVM path is available (BIOS, boot, no network, broken SSH).

## Packages

| Package | Purpose |
|---------|---------|
| `hid` | CH9329 keyboard protocol + serial port auto-detection |
| `framegrab` | ffmpeg-based frame capture (AVFoundation / V4L2 / DirectShow) |
| `screen` | grid calibration, glyph learning, template matching, text grid |
| `tui` | interactive tcell terminal |
| `cmd/kvmterm` | CLI entry point |
