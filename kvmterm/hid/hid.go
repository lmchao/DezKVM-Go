// Package hid drives the CH9329 UART-to-USB-HID chip used by the DezKVM-Go.
//
// The chip receives framed packets over a serial port and emits standard USB
// keyboard reports to the remote machine. This package implements the
// Protocol Transmission mode frame format (see the CH9329 datasheet):
//
//	57 AB [ADDR] [CMD] [LEN] [DATA...] [SUM]
//
// Only the keyboard command (CMD 0x02) and the soft-reset command (CMD 0x0F)
// are used here, since a text terminal only needs keyboard input.
package hid

import (
	"errors"
	"fmt"
	"sync"
	"time"

	"go.bug.st/serial"
)

// ErrDisconnected is returned by keyboard commands while the serial port is
// closed (see Close / Reconnect).
var ErrDisconnected = errors.New("keyboard disconnected")

// HID usage IDs for the keys a text terminal commonly needs.
const (
	KeyA = 0x04
	KeyB = 0x05
	KeyC = 0x06
	KeyD = 0x07
	KeyE = 0x08
	KeyF = 0x09
	KeyG = 0x0A
	KeyH = 0x0B
	KeyI = 0x0C
	KeyJ = 0x0D
	KeyK = 0x0E
	KeyL = 0x0F
	KeyM = 0x10
	KeyN = 0x11
	KeyO = 0x12
	KeyP = 0x13
	KeyQ = 0x14
	KeyR = 0x15
	KeyS = 0x16
	KeyT = 0x17
	KeyU = 0x18
	KeyV = 0x19
	KeyW = 0x1A
	KeyX = 0x1B
	KeyY = 0x1C
	KeyZ = 0x1D

	Key1 = 0x1E
	Key2 = 0x1F
	Key3 = 0x20
	Key4 = 0x21
	Key5 = 0x22
	Key6 = 0x23
	Key7 = 0x24
	Key8 = 0x25
	Key9 = 0x26
	Key0 = 0x27

	KeyEnter      = 0x28
	KeyEscape     = 0x29
	KeyBackspace  = 0x2A
	KeyTab        = 0x2B
	KeySpace      = 0x2C
	KeyMinus      = 0x2D
	KeyEqual      = 0x2E
	KeyLBracket   = 0x2F
	KeyRBracket   = 0x30
	KeyBackslash  = 0x31
	KeySemicolon  = 0x33
	KeyApostrophe = 0x34
	KeyGrave      = 0x35
	KeyComma      = 0x36
	KeyPeriod     = 0x37
	KeySlash      = 0x38

	KeyArrowRight = 0x4F
	KeyArrowLeft  = 0x50
	KeyArrowDown  = 0x51
	KeyArrowUp    = 0x52
	KeyHome       = 0x4A
	KeyEnd        = 0x4D
	KeyPageUp     = 0x4B
	KeyPageDown   = 0x4E
	KeyDelete     = 0x4C
	KeyInsert     = 0x49
)

// Modifier bits for the keyboard report modifier byte.
const (
	ModLCtrl  = 0x01
	ModLShift = 0x02
	ModLAlt   = 0x04
	ModLGui   = 0x08
	ModRCtrl  = 0x10
	ModRShift = 0x20
	ModRAlt   = 0x40
	ModRGui   = 0x80
)

// keyDef maps a printable rune to a HID usage ID plus a shift flag.
type keyDef struct {
	hid   byte
	shift bool
}

var keymap = map[rune]keyDef{}

func init() {
	for i, c := range "abcdefghijklmnopqrstuvwxyz" {
		keymap[c] = keyDef{KeyA + byte(i), false}
		keymap[c-'a'+'A'] = keyDef{KeyA + byte(i), true}
	}
	for i, c := range "1234567890" {
		keymap[c] = keyDef{Key1 + byte(i), false}
	}
	unshifted := map[rune]byte{
		' ': KeySpace, '-': KeyMinus, '=': KeyEqual, '[': KeyLBracket,
		']': KeyRBracket, '\\': KeyBackslash, ';': KeySemicolon, '\'': KeyApostrophe,
		'`': KeyGrave, ',': KeyComma, '.': KeyPeriod, '/': KeySlash, '\t': KeyTab,
		'\n': KeyEnter, '\r': KeyEnter,
	}
	shifted := map[rune]byte{
		'!': Key1, '@': Key2, '#': Key3, '$': Key4, '%': Key5, '^': Key6,
		'&': Key7, '*': Key8, '(': Key9, ')': Key0, '_': KeyMinus, '+': KeyEqual,
		'{': KeyLBracket, '}': KeyRBracket, '|': KeyBackslash, ':': KeySemicolon,
		'"': KeyApostrophe, '~': KeyGrave, '<': KeyComma, '>': KeyPeriod, '?': KeySlash,
	}
	for r, h := range unshifted {
		keymap[r] = keyDef{h, false}
	}
	for r, h := range shifted {
		keymap[r] = keyDef{h, true}
	}
}

// Keyboard is a CH9329 keyboard endpoint over a serial port. The port can be
// opened and closed at runtime (Close/Reconnect) so another process — e.g. the
// browser control panel — can take over the device.
type Keyboard struct {
	device string
	baud   int

	// hold and gap are the default pacing for typed characters.
	hold time.Duration
	gap  time.Duration

	mu   sync.Mutex
	port serial.Port
}

// Open opens the serial port and returns a Keyboard. It does not touch the
// chip; call Warmup (or Reset) to put the CH9329 into a known state.
func Open(device string, baud int) (*Keyboard, error) {
	k := &Keyboard{
		device: device,
		baud:   baud,
		hold:   80 * time.Millisecond,
		gap:    40 * time.Millisecond,
	}
	if err := k.openLocked(); err != nil {
		return nil, err
	}
	return k, nil
}

// openLocked opens the serial port. The caller must hold k.mu.
func (k *Keyboard) openLocked() error {
	mode := &serial.Mode{
		BaudRate: k.baud,
		DataBits: 8,
		Parity:   serial.NoParity,
		StopBits: serial.OneStopBit,
	}
	port, err := serial.Open(k.device, mode)
	if err != nil {
		return fmt.Errorf("open serial %s: %w", k.device, err)
	}
	if err := port.SetReadTimeout(time.Millisecond * 200); err != nil {
		port.Close()
		return err
	}
	k.port = port
	return nil
}

// closeLocked closes the serial port if open. The caller must hold k.mu.
func (k *Keyboard) closeLocked() error {
	if k.port == nil {
		return nil
	}
	err := k.port.Close()
	k.port = nil
	return err
}

// Close releases the serial port so another process can claim it. It is safe
// to call when already disconnected.
func (k *Keyboard) Close() error {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.closeLocked()
}

// Connected reports whether the serial port is currently open.
func (k *Keyboard) Connected() bool {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.port != nil
}

// Reconnect closes and reopens the port and re-warms the chip, undoing a Close.
func (k *Keyboard) Reconnect() error {
	k.mu.Lock()
	defer k.mu.Unlock()
	if err := k.closeLocked(); err != nil {
		return err
	}
	if err := k.openLocked(); err != nil {
		return err
	}
	return k.warmupLocked()
}

// SetPacing overrides the default key hold and inter-key gap durations.
func (k *Keyboard) SetPacing(hold, gap time.Duration) {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.hold, k.gap = hold, gap
}

func checksum(b []byte) byte {
	var s int
	for _, x := range b {
		s += int(x)
	}
	return byte(s & 0xFF)
}

// write sends a raw packet, guarding against a closed port.
func (k *Keyboard) write(pkt []byte) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.writeLocked(pkt)
}

func (k *Keyboard) writeLocked(pkt []byte) error {
	if k.port == nil {
		return ErrDisconnected
	}
	_, err := k.port.Write(pkt)
	return err
}

// report sends a full 8-byte keyboard report (modifier + 6 keys) as CMD 0x02.
func (k *Keyboard) report(mod byte, keys [6]byte) error {
	pkt := []byte{
		0x57, 0xAB, 0x00, 0x02, 0x08,
		mod, 0x00,
		keys[0], keys[1], keys[2], keys[3], keys[4], keys[5],
		0x00,
	}
	pkt[13] = checksum(pkt[:13])
	return k.write(pkt)
}

// Reset sends the CH9329 soft-reset command (CMD 0x0F).
func (k *Keyboard) Reset() error {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.resetLocked()
}

func (k *Keyboard) resetLocked() error {
	pkt := []byte{0x57, 0xAB, 0x00, 0x0F, 0x00, 0x00}
	pkt[5] = checksum(pkt[:5])
	return k.writeLocked(pkt)
}

// Warmup resets the chip and waits for its USB HID interface to re-initialize.
// The CH9329 drops the first few keystrokes sent after a fresh connection or
// reset, so call this once before typing anything important.
func (k *Keyboard) Warmup() error {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.warmupLocked()
}

func (k *Keyboard) warmupLocked() error {
	if err := k.resetLocked(); err != nil {
		return err
	}
	time.Sleep(1500 * time.Millisecond)
	return nil
}

// Combo presses a modifier + key together, holds, then releases all.
func (k *Keyboard) Combo(mod, key byte, hold time.Duration) error {
	if err := k.report(mod, [6]byte{key}); err != nil {
		return err
	}
	time.Sleep(hold)
	return k.report(0x00, [6]byte{})
}

// Key taps a single key (no modifier).
func (k *Keyboard) Key(key byte, hold time.Duration) error {
	return k.Combo(0x00, key, hold)
}

// CtrlC sends Ctrl+C (interrupt / clear line at a shell prompt).
func (k *Keyboard) CtrlC() error { return k.Combo(ModLCtrl, KeyC, k.hold) }

// SysRQReboot issues the magic SysRq "safe reboot" sequence
// (unraw, terminate, kill, sync, unmount, reboot). This is handled by the
// kernel's input layer, so it can work even when userspace is hung, provided
// kernel.sysrq is enabled.
func (k *Keyboard) SysRQReboot() error {
	const sysrq = 0x46 // Print Screen / SysRq
	// HID keycodes: r, e, i, s, u, b
	for _, key := range []byte{0x15, 0x08, 0x0C, 0x16, 0x18, 0x05} {
		if err := k.report(ModLAlt, [6]byte{sysrq, key}); err != nil {
			return err
		}
		time.Sleep(150 * time.Millisecond)
		if err := k.report(0x00, [6]byte{}); err != nil {
			return err
		}
		time.Sleep(400 * time.Millisecond)
	}
	return nil
}

// CtrlL sends Ctrl+L (clear screen).
func (k *Keyboard) CtrlL() error { return k.Combo(ModLCtrl, KeyL, k.hold) }

// CtrlU sends Ctrl+U (kill to start of line).
func (k *Keyboard) CtrlU() error { return k.Combo(ModLCtrl, KeyU, k.hold) }

// Enter presses the Enter key.
func (k *Keyboard) Enter() error { return k.Key(KeyEnter, k.hold) }

// TypeString types a string one character at a time, handling the shift
// modifier for uppercase and symbol characters. Unsupported runes are skipped.
func (k *Keyboard) TypeString(s string) error {
	for _, r := range s {
		def, ok := keymap[r]
		if !ok {
			return fmt.Errorf("unsupported character %q", r)
		}
		mod := byte(0x00)
		if def.shift {
			mod = ModLShift
		}
		if err := k.report(mod, [6]byte{def.hid}); err != nil {
			return err
		}
		time.Sleep(k.hold)
		if err := k.report(0x00, [6]byte{}); err != nil {
			return err
		}
		time.Sleep(k.gap)
	}
	return nil
}

// Command types a command string followed by Enter.
func (k *Keyboard) Command(s string) error {
	if err := k.TypeString(s); err != nil {
		return err
	}
	return k.Enter()
}
