# Terminal view

A text terminal for the DezKVM-Go local viewer. It shows the remote machine's
console as **text** — reconstructed from the HDMI capture feed — and forwards
your keystrokes to the remote over the existing CH9329 / Web Serial link.

It complements the normal video view: use the **video** tab for a pixel-exact
picture (BIOS, graphical tools, mouse), and the **terminal** tab for a fast,
selectable, copy/paste-friendly text session on a text console (shell, getty,
Proxmox console, recovery shell).

Everything runs in the browser. There is **no backend** — it works from the
`usbkvm` server and from a plain static host (e.g. GitHub Pages).

## Features

- **Text view** of the remote console rendered with xterm.js (vendored locally,
  works offline).
- **Keyboard forwarding** through the same CH9329 / Web Serial path the rest of
  the viewer uses. Printable ASCII, Enter, Backspace, Tab, Esc, arrows/F-keys
  (as their escape sequences) and Ctrl+letter combinations are supported.
- **Copy / paste** via xterm.js: select text and copy; paste types the clipboard
  into the remote. `Ctrl+C` with no selection sends an interrupt to the remote,
  as a terminal should.
- **One-time calibration** that learns the remote console's font, then cached in
  `localStorage` (`dezkvm_terminal_cal_v1`).
- **Auto-fit** font: the font shrinks to fit the terminal in both width and
  height, so the full 240×67 remote grid is visible without scrolling.
- **Off-main-thread** reconstruction in a Web Worker (binarize → grid → glyph
  match), so the UI stays responsive.
- **Static / offline**: no network calls, no CDN, no server-side device access.

## How it works

```
HDMI capture ──► <video> ──createImageBitmap──► Web Worker
                                                   │ binarize
                                                   │ detect monospace grid
                                                   │ match cells to glyphs
                                                   ▼
                                             text grid (240×67)
                                                   │
                                                   ▼
                                               xterm.js
                                                   │ onData
                                                   ▼
                                     char → HID → CH9329 packet
                                                   │
                                        Web Serial (existing)
                                                   ▼
                                             remote machine
```

Source files (all in this directory):

| File | Purpose |
|------|---------|
| `terminal-core.js` | Pure reconstruction: binarize, grid detection, phase, glyph learning, template matching |
| `terminal-worker.js` | Web Worker wrapper (OffscreenCanvas + `getImageData`, ImageBitmap transfer) |
| `terminal.js` | xterm.js setup, tab switch, frame loop, calibration flow, input forwarding, persistence |
| `vendor/xterm/` | Vendored xterm.js + CSS |

## Using it

1. Open the viewer as usual and connect the **serial port** (the keyboard button
   in the top bar). The terminal needs it for input.
2. Click the **code icon** in the top bar to switch to the Terminal tab.
   - First run: the status bar says `Not calibrated`.
3. Put the remote machine at a **shell prompt** (a login prompt or a running
   program will not calibrate).
4. Click **Calibrate**. This takes ~30 s and types into the remote (see below).
5. When it finishes the status bar shows the grid size (e.g.
   `Terminal ready — 240x67, cell 8x16`) and the console text appears.
6. Type normally. Click the **video icon** in the terminal toolbar (or the code
   icon again) to switch back to the video view.

## Calibration

The KVM only provides video, so the terminal must learn what the remote font
looks like. Calibration does this once:

1. Waits 1.5 s after a CH9329 reset (the chip drops early keystrokes).
2. Sends `Ctrl+L` to clear the screen.
3. Types a lattice of `X` characters and captures a frame — this measures the
   monospace cell size (width/height) and the grid origin.
4. Sends `Ctrl+L` again.
5. Types the 95 printable ASCII characters in a reference grid and captures a
   frame — this learns one glyph bitmap per character.
6. Stores the result in `localStorage['dezkvm_terminal_cal_v1']`.

The commands it types are:

```sh
awk 'BEGIN{for(i=0;i<80;i++){for(j=0;j<200;j++)printf "X";printf "\n"}}'
awk 'BEGIN{for(r=0;r<50;r++){for(c=32;c<=126;c++)printf "%c",c;printf "\n"}}'
```

**Re-calibrate when** the remote's console font or OS changes. The usual symptom
is that the terminal renders but every visible character is `?` (the learned
glyphs no longer match). Calibrate again from a shell prompt.

The calibration is disruptive: it clears the remote screen and prints grids.
Do not start it while a program is running, and do not run it on a machine where
you cannot tolerate that.

## Limits

- **Plain/white text is exact; colored text is lossy.** Reconstruction is
  brightness-based. Colored text — especially dim colors like dark-blue IPv6
  addresses from `ip -c` — can render as `?`. This is a limitation of the cheap
  MJPEG capture card (chroma "ringing" around colored glyphs), not something the
  terminal can fully fix. Prefer commands that output plain text.
- **The grid is fixed to the remote console.** Calibration reports the actual
  size (typically 240×67 at 1920×1080, cell 8×16). A font change means
  re-calibration, not a resize.
- **The font is height-limited on wide windows.** The terminal fits both
  dimensions, so on a wide/short browser window the effective font can be small.
  Enlarge the window or use a larger display.
- **No scrollback.** It shows the current remote screen (the video feed), not the
  remote's scrollback history. `scrollback` is disabled in xterm.js.
- **Non-ASCII input is skipped.** The CH9329 sends HID key codes, not Unicode;
  accented/CJK characters cannot be typed.
- **Keyboard only.** The terminal does not emulate the mouse (use the video tab
  for mouse interaction).
- **Requires a Chromium browser with Web Serial** and a connected serial port.
- **Reconstruction rate is ~4 fps** (250 ms poll). It is meant for shell use, not
  for reading rapidly scrolling output.
- **The remote's font must be monospace** with a regular grid (all terminal
  consoles are).

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Every character is `?` | Stale calibration (font/OS changed). Put the remote at a shell prompt, click **Calibrate**. |
| `Serial not connected` | Connect the serial port with the top-bar keyboard button, then retry. |
| `Calibration failed` / garbled glyphs | The remote was not at a shell prompt, or typing was interrupted. Ensure a clean prompt and retry. |
| Terminal is blank | No calibration yet, or no video stream. Check the video tab first. |
| Text is small | Wide/short window — the font is height-limited. Enlarge the window. |
| `worker: no calibration` | The cache was cleared mid-session. Re-calibrate. |

## Notes

- `localStorage` key: `dezkvm_terminal_cal_v1`. Delete it to force a fresh
  calibration.
- The terminal reuses the viewer's existing serial connection; calibration runs
  its own CH9329 reset + 1.5 s warm-up before typing.
- When the terminal tab is active, the viewer's page-level keyboard forwarding is
  suppressed (the terminal forwards its own input), so keys are never sent twice.
