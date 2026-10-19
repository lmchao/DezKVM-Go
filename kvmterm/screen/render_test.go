package screen

import "testing"

// Bitmaps from a real 8x16 console font (learned from a calibration frame).
var testGlyphs = map[byte][]uint64{
	'1': {0, 0, 24, 28, 30, 24, 24, 24, 24, 24, 24, 126, 0, 0, 0, 0},
	']': {0, 0, 60, 48, 48, 48, 48, 48, 48, 48, 48, 60, 0, 0, 0, 0},
	'I': {0, 0, 60, 24, 24, 24, 24, 24, 24, 24, 24, 60, 0, 0, 0, 0},
	'l': {0, 0, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 0, 0, 0, 0},
}

func glyphFrom(rows []uint64) glyph {
	return glyph{w: 8, h: 16, rows: rows}
}

func templates() []glyphTpl {
	var out []glyphTpl
	for code, rows := range testGlyphs {
		out = append(out, newGlyphTpl(code, glyphFrom(rows)))
	}
	return out
}

// A cell one pixel to the right of the learned phase used to match ']' (a
// wrong character, distance 7 under the ink/3 limit) instead of the drifted
// '1'. Thin glyphs are the ones this hits first in a long line.
func TestMatchGlyphToleratesOnePixelDrift(t *testing.T) {
	tpls := templates()
	one := glyphFrom(testGlyphs['1'])
	cell := one.shiftH(1)

	if got := matchGlyph(one, tpls); got != '1' {
		t.Fatalf("aligned cell: got %q, want '1'", got)
	}
	if got := matchGlyph(cell, tpls); got != '1' {
		t.Fatalf("drifted cell: got %q, want '1'", got)
	}
}

func TestMatchGlyphRejectsNoise(t *testing.T) {
	tpls := templates()
	// A single speck is not a character.
	speck := glyph{w: 8, h: 16, rows: make([]uint64, 16)}
	speck.rows[4] = 1 << 3
	if got := matchGlyph(speck, tpls); got != '?' {
		t.Fatalf("speck: got %q, want '?'", got)
	}
}
