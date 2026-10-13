import { describe, expect, test } from 'claude-code/testing'

import { FALLEN_MARK, TALLY_GLYPH, tallyGlyphs, tallyLabel } from '../hooks/tally'

const KNIGHT = TALLY_GLYPH.knight
const SCOUT = TALLY_GLYPH.scout

describe('tally', () => {
  test('one glyph per ten calls, rounded down', () => {
    expect(tallyGlyphs(0, 'knight', 'dispatched')).toBe('')
    expect(tallyGlyphs(9, 'knight', 'dispatched')).toBe('')
    expect(tallyGlyphs(10, 'knight', 'dispatched')).toBe(KNIGHT)
    expect(tallyGlyphs(19, 'knight', 'dispatched')).toBe(KNIGHT)
    expect(tallyGlyphs(20, 'knight', 'dispatched')).toBe(KNIGHT.repeat(2))
  })

  test('caps at ten glyphs and shows the rest as +N', () => {
    expect(tallyGlyphs(100, 'knight', 'dispatched')).toBe(KNIGHT.repeat(10))
    expect(tallyGlyphs(101, 'knight', 'dispatched')).toBe(KNIGHT.repeat(10))
    expect(tallyGlyphs(109, 'knight', 'dispatched')).toBe(KNIGHT.repeat(10))
    expect(tallyGlyphs(110, 'knight', 'dispatched')).toBe(`${KNIGHT.repeat(10)}+1`)
    expect(tallyGlyphs(120, 'knight', 'dispatched')).toBe(`${KNIGHT.repeat(10)}+2`)
  })

  test('knights and scouts have their own glyph', () => {
    expect(tallyGlyphs(30, 'scout', 'dispatched')).toBe(SCOUT.repeat(3))
    expect(SCOUT).not.toBe(KNIGHT)
  })

  test('a failed order ends with a dagger, even before the first glyph; a finished one does not', () => {
    expect(tallyGlyphs(25, 'knight', 'failed')).toBe(`${KNIGHT.repeat(2)}${FALLEN_MARK}`)
    expect(tallyGlyphs(5, 'scout', 'failed')).toBe(FALLEN_MARK)
    expect(tallyGlyphs(120, 'knight', 'failed')).toBe(`${KNIGHT.repeat(10)}+2${FALLEN_MARK}`)
    expect(tallyGlyphs(25, 'knight', 'done')).toBe(KNIGHT.repeat(2))
    expect(tallyGlyphs(25, 'knight', 'approved')).toBe(KNIGHT.repeat(2))
  })

  test('bad counts show nothing', () => {
    expect(tallyGlyphs(-40, 'knight', 'dispatched')).toBe('')
    expect(tallyGlyphs(Number.NaN, 'knight', 'dispatched')).toBe('')
  })

  test('the label keeps the number beside the glyphs, and is empty when the tally is', () => {
    expect(tallyLabel(34, 'knight', 'dispatched')).toBe(`${KNIGHT.repeat(3)} 34 calls`)
    expect(tallyLabel(10, 'scout', 'done')).toBe(`${SCOUT} 10 calls`)
    expect(tallyLabel(1, 'knight', 'failed')).toBe(`${FALLEN_MARK} 1 call`)
    expect(tallyLabel(9, 'knight', 'dispatched')).toBe('')
  })
})
