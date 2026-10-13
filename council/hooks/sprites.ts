// The council's pixel portraits: 16×18 little legionaries, one frame per animation tick,
// drawn as terminal half-blocks (Raster) or as animated SVG. Pure.
//
// Mood comes from the advisor's own verdict (its 1–5 concern), so the
// animation reflects the output with no extra model call.

import type { Accessory, AdvisorReport, CouncilPhase } from '../types'
import type { RoadSites, Site } from './tally'

export const SPRITE_WIDTH = 16
export const SPRITE_HEIGHT = 18
export const RASTER_COLUMNS = SPRITE_WIDTH
export const RASTER_ROWS = SPRITE_HEIGHT / 2
export const TICK_MS = 160
// Every animation below repeats within this many ticks, so the SVG loops it.
export const CYCLE_TICKS = 24

export type SpriteMood = 'waiting' | 'deliberating' | 'content' | 'uneasy' | 'alarmed' | 'failed'

type Color = string | null
export type Grid = Color[][]

// Shared by every advisor: the visor, its eyes, and the dark details (feet,
// poles, antennae), lifted enough to read on the dark plaque.
const SHARED_COLORS: Record<string, string> = {
  V: '#12303f', // visor
  E: '#ffffff', // eyes
  D: '#3e6380', // feet and details
}
const ALARMED_EYES = '#ff5a4f'
const EFFECT_COLORS = { thought: '#d0d0d0', alarm: '#ff3b30', flash: '#ff3b30' }

// Each advisor is the same little legionary in its own body color (B),
// carrying one accessory (drawn by its prop, so the accessory can move).
export type Appearance = { color: string; accessory: Accessory }

// The accessories' own colors, the same on every advisor.
const ACCESSORY_COLORS: Record<Accessory, Record<string, string>> = {
  shield: { P: '#d9dee5', p: '#2c5282' },
  crown: { C: '#f2c230', k: '#8a6a10', w: '#ffffff' },
  none: {},
  standard: { f: '#f2c230' },
  antenna: { b: '#f2c230' },
}

export const ACCESSORIES = Object.keys(ACCESSORY_COLORS) as Accessory[]

// A body color from a member file: #rgb or #rrggbb, else the fallback.
export const isHexColor = (value: string) => /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)

// The visor row; the eyes glance inside it and close to blink.
const EYES = {
  open: '..BBBVEVVEVBBB..',
  closed: '..BBBVVVVVVBBB..',
  right: '..BBBVVEVVEBBB..',
  left: '..BBBEVVEVVBBB..',
}

const BODY = [
  '......BBBB......',
  '....BBBBBBBB....',
  '...BBBBBBBBBB...',
  '..BBBVVVVVVBBB..',
  '', // eyes, filled per frame
  '...BBVVVVVVBB...',
  '...BBBBBBBBBB...',
  '...BBBBBBBBBB...',
  '....DD....DD....',
  '...DDD....DDD...',
]

// The body's rows start here; rows above are for accessories, thought
// bubbles and "!".
const CHARACTER_TOP = 7

export function bodyRows(eyes: keyof typeof EYES = 'open'): string[] {
  return BODY.map(row => (row === '' ? EYES[eyes] : row))
}

const blankGrid = (): Grid => Array.from({ length: SPRITE_HEIGHT }, () => new Array<Color>(SPRITE_WIDTH).fill(null))

function put(grid: Grid, x: number, y: number, color: string | undefined) {
  if (color === undefined || y < 0 || y >= SPRITE_HEIGHT || x < 0 || x >= SPRITE_WIDTH) return
  grid[y]![x] = color
}

// Draws a small pattern with its top-left corner at (left, top); '.' is clear.
function stamp(grid: Grid, pattern: readonly string[], left: number, top: number, colorOf: (key: string) => string | undefined) {
  pattern.forEach((row, dy) => [...row].forEach((key, dx) => key !== '.' && put(grid, left + dx, top + dy, colorOf(key))))
}

// ── Props: each advisor's accessory and how it moves, by phase ─────────────

type PropDraw = (layer: Grid, phase: number, mood: SpriteMood, colorOf: (key: string) => string | undefined) => void

const SHIELD = ['PPP', 'PpP', 'PpP', 'PpP', '.P.']
const CROWN = ['C.CC.C', 'CCCCCC', '.kkkk.']
const CROWN_POINTS = [0, 2, 3, 5]
const FLAG_WAVES = [
  ['fff', 'fff', 'ff.'],
  ['ff.', 'fff', 'fff'],
]
const ANTENNA_BOBS = [
  ['....b', '..DD.', 'DD...', 'D....'],
  ['.....', '..DDb', 'DD...', 'D....'],
]
const ANTENNA_UPRIGHT = ['b', 'D', 'D', 'D', 'D']

const PROPS: Record<Accessory, { phases: number; draw: PropDraw }> = {
  shield: {
    // Lifts the shield; alarmed, it stays up. (Phases divide CYCLE_TICKS / 4.)
    phases: 6,
    draw: (layer, phase, mood, colorOf) => stamp(layer, SHIELD, 1, mood === 'alarmed' || phase >= 3 ? 8 : 11, colorOf),
  },
  crown: {
    // The crown glints point by point; alarmed, it jumps.
    phases: 6,
    draw: (layer, phase, mood, colorOf) => {
      const top = mood === 'alarmed' && phase % 2 === 1 ? 3 : 4
      stamp(layer, CROWN, 5, top, colorOf)
      const glint = CROWN_POINTS[phase]
      if (mood !== 'failed' && glint !== undefined) put(layer, 5 + glint, top, colorOf('w'))
    },
  },
  none: {
    // Carries nothing.
    phases: 1,
    draw: () => undefined,
  },
  standard: {
    // The standard waves; alarmed, it drops to half-mast.
    phases: 2,
    draw: (layer, phase, mood, colorOf) => {
      for (let y = 2; y <= 16; y++) put(layer, 12, y, colorOf('D'))
      stamp(layer, FLAG_WAVES[phase % 2]!, 13, mood === 'alarmed' ? 7 : 2, colorOf)
    },
  },
  antenna: {
    // The antenna bobs its bell; alarmed, it stands straight up.
    phases: 2,
    draw: (layer, phase, mood, colorOf) =>
      mood === 'alarmed' ? stamp(layer, ANTENNA_UPRIGHT, 8, 2, colorOf) : stamp(layer, ANTENNA_BOBS[phase % 2]!, 8, 3, colorOf),
  },
}

// ── Moods ──────────────────────────────────────────────────────────────────

export function moodFor(report: AdvisorReport, phase: CouncilPhase): SpriteMood {
  if (report.status === 'failed') return 'failed'
  // Abstained: nothing to weigh in on; just there, blinking.
  if (report.status === 'abstained') return 'waiting'
  if (report.status === 'done') return report.concern >= 4 ? 'alarmed' : report.concern === 3 ? 'uneasy' : 'content'
  if (report.status === 'deliberating') return 'deliberating'
  return phase === 'failed' ? 'failed' : 'waiting'
}

type Motion = { dx: number; dy: number; eyes: keyof typeof EYES; propPhase: number; thoughtDots: number; isAlarmed: boolean; isFlashing: boolean }

function motionFor(mood: SpriteMood, tick: number, propPhases: number): Motion {
  const still: Motion = { dx: 0, dy: 0, eyes: 'open', propPhase: 0, thoughtDots: 0, isAlarmed: false, isFlashing: false }
  const isBlinking = tick % 12 === 0
  switch (mood) {
    case 'failed':
      return { ...still, eyes: 'closed' }
    case 'waiting':
      return { ...still, eyes: isBlinking ? 'closed' : 'open' }
    case 'deliberating': {
      // Eyes wander inside the visor while thinking.
      const glance = (['open', 'left', 'open', 'right'] as const)[Math.floor(tick / 6) % 4]!
      return { ...still, dy: Math.floor(tick / 6) % 2, eyes: isBlinking ? 'closed' : glance, thoughtDots: Math.floor(tick / 3) % 4 }
    }
    case 'content':
      return { ...still, dy: Math.floor(tick / 4) % 2, eyes: isBlinking ? 'closed' : 'open', propPhase: Math.floor(tick / 4) % propPhases }
    case 'uneasy': {
      const dx = [0, 1, 0, -1][Math.floor(tick / 3) % 4]!
      // Props step every 4 ticks, as when content, so every loop divides CYCLE_TICKS.
      return { ...still, dx, eyes: dx > 0 ? 'right' : dx < 0 ? 'left' : isBlinking ? 'closed' : 'open', propPhase: Math.floor(tick / 4) % propPhases }
    }
    case 'alarmed':
      return { ...still, dx: tick % 2 === 0 ? 1 : -1, propPhase: tick % propPhases, isAlarmed: true, isFlashing: tick % 4 < 2 }
  }
}

// A failed advisor goes gray.
function grayscale(hex: string): string {
  const digits = hex.length === 4 ? hex.slice(1).replace(/./g, digit => digit + digit) : hex.slice(1)
  const value = parseInt(digits, 16)
  const luma = 0.3 * (value >> 16) + 0.59 * ((value >> 8) & 255) + 0.11 * (value & 255)
  // Squeezed toward a mid gray so the details still separate from the body.
  const level = Math.round(56 + luma * 0.45).toString(16).padStart(2, '0')
  return `#${level}${level}${level}`
}

// Thought dots rise up and to the left, clear of every accessory.
const THOUGHT_DOTS: Array<[number, number]> = [[4, 5], [2, 3], [1, 1]]

export function spriteFrame(appearance: Appearance, mood: SpriteMood, tick: number): Grid {
  const prop = PROPS[appearance.accessory]
  const motion = motionFor(mood, tick, prop.phases)
  const palette: Record<string, string> = { B: appearance.color, ...ACCESSORY_COLORS[appearance.accessory] }
  const baseColorOf = (key: string) => (key === 'E' && motion.isAlarmed ? ALARMED_EYES : (palette[key] ?? SHARED_COLORS[key]))
  const colorOf = (key: string) => {
    const color = baseColorOf(key)
    return color !== undefined && mood === 'failed' ? grayscale(color) : color
  }

  // The character and its prop move together.
  const layer = blankGrid()
  stamp(layer, bodyRows(motion.eyes), 0, CHARACTER_TOP, colorOf)
  prop.draw(layer, motion.propPhase, mood, colorOf)

  const grid = blankGrid()
  layer.forEach((row, y) => row.forEach((color, x) => color && put(grid, x + motion.dx, y + motion.dy, color)))

  THOUGHT_DOTS.slice(0, motion.thoughtDots).forEach(([x, y]) => put(grid, x, y, EFFECT_COLORS.thought))
  if (motion.isAlarmed) for (const y of [0, 1, 2, 4]) put(grid, 3, y, EFFECT_COLORS.alarm)
  if (motion.isFlashing) {
    for (let x = 0; x < SPRITE_WIDTH; x++) {
      put(grid, x, 0, grid[0]![x] ?? EFFECT_COLORS.flash)
      put(grid, x, SPRITE_HEIGHT - 1, grid[SPRITE_HEIGHT - 1]![x] ?? EFFECT_COLORS.flash)
    }
    for (let y = 0; y < SPRITE_HEIGHT; y++) {
      put(grid, 0, y, grid[y]![0] ?? EFFECT_COLORS.flash)
      put(grid, SPRITE_WIDTH - 1, y, grid[y]![SPRITE_WIDTH - 1] ?? EFFECT_COLORS.flash)
    }
  }
  return grid
}

// ── Terminal: half-block Raster cells ──────────────────────────────────────

const DEFAULT_COLOR = 0x01000000
const UPPER_HALF = 0x2580 // ▀
const LOWER_HALF = 0x2584 // ▄
const SPACE = 0x20

const rgb = (hex: string) => parseInt(hex.slice(1), 16)

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function toBase64(bytes: Uint8Array): string {
  let output = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    const chunk = (first << 16) | ((second ?? 0) << 8) | (third ?? 0)
    output += BASE64_ALPHABET[(chunk >> 18) & 63]! + BASE64_ALPHABET[(chunk >> 12) & 63]!
    output += second === undefined ? '=' : BASE64_ALPHABET[(chunk >> 6) & 63]!
    output += third === undefined ? '=' : BASE64_ALPHABET[chunk & 63]!
  }
  return output
}

// Two pixels per cell: the upper as foreground of ▀, the lower as background.
export function rasterCells(grid: Grid): string {
  const words = new Uint32Array(RASTER_COLUMNS * RASTER_ROWS * 3)
  for (let row = 0; row < RASTER_ROWS; row++) {
    for (let column = 0; column < RASTER_COLUMNS; column++) {
      const top = grid[row * 2]![column]
      const bottom = grid[row * 2 + 1]![column]
      const offset = (row * RASTER_COLUMNS + column) * 3
      if (top && bottom) words.set([UPPER_HALF, rgb(top), rgb(bottom)], offset)
      else if (top) words.set([UPPER_HALF, rgb(top), DEFAULT_COLOR], offset)
      else if (bottom) words.set([LOWER_HALF, rgb(bottom), DEFAULT_COLOR], offset)
      else words.set([SPACE, DEFAULT_COLOR, DEFAULT_COLOR], offset)
    }
  }
  // Uint32Array is little-endian on every platform the engine runs on.
  return toBase64(new Uint8Array(words.buffer))
}

// ── Desktop: one animated SVG per persona and mood ─────────────────────────

// A grid as SVG rects, one per run of a colour in a row, offset to (left, top).
function gridRects(grid: Grid, left = 0, top = 0): string {
  let rects = ''
  grid.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const color = row[x]
      if (!color) {
        x++
        continue
      }
      let run = 1
      while (x + run < row.length && row[x + run] === color) run++
      rects += `<rect x="${left + x}" y="${top + y}" width="${run}" height="1" fill="${color}"/>`
      x += run
    }
  })
  return rects
}

const frameRects = (grid: Grid) => gridRects(grid)

const svgCache = new Map<string, string>()

// The dark plaque behind each portrait, framed in a color that follows the
// mood, so the drawing never sits on the frame's default white.
const PLAQUE_FILL = '#1c1a17'
// A faint floor line the figure stands on, so it reads as placed, not floating.
const PLAQUE_FLOOR = '#2b2823'
const PLAQUE_FRAME: Record<SpriteMood, string> = {
  waiting: '#4a4640',
  deliberating: '#6b665e',
  content: '#3f8f5a',
  uneasy: '#c99a2e',
  alarmed: '#d0453b',
  failed: '#34322e',
}

// Each distinct frame is written once (in <defs>); every run of ticks that
// shows it is a <use> whose visibility SMIL toggles on one shared loop. The
// shaking moods repeat a few frames many times, so this keeps them small.
export function animatedSvg(appearance: Appearance, mood: SpriteMood, pixelSize = 4): string {
  const cacheKey = `${appearance.color}|${appearance.accessory}|${mood}|${pixelSize}`
  const cached = svgCache.get(cacheKey)
  if (cached) return cached

  const frames: string[] = []
  const spans: Array<{ frame: number; start: number; end: number }> = []
  for (let tick = 0; tick < CYCLE_TICKS; tick++) {
    const rects = frameRects(spriteFrame(appearance, mood, tick))
    let frame = frames.indexOf(rects)
    if (frame === -1) frame = frames.push(rects) - 1
    const last = spans[spans.length - 1]
    if (last && last.frame === frame) last.end = tick + 1
    else spans.push({ frame, start: tick, end: tick + 1 })
  }
  const duration = `${((CYCLE_TICKS * TICK_MS) / 1000).toFixed(2)}s`
  const defs = frames.length > 1 ? `<defs>${frames.map((rects, index) => `<g id="f${index}">${rects}</g>`).join('')}</defs>` : ''
  const body =
    frames.length === 1
      ? `<g>${frames[0]}</g>`
      : spans
          .map(span => {
            const from = (span.start / CYCLE_TICKS).toFixed(4)
            const to = (span.end / CYCLE_TICKS).toFixed(4)
            const timing =
              span.start === 0
                ? { values: 'visible;hidden', keyTimes: `0;${to}` }
                : span.end === CYCLE_TICKS
                  ? { values: 'hidden;visible', keyTimes: `0;${from}` }
                  : { values: 'hidden;visible;hidden', keyTimes: `0;${from};${to}` }
            const initial = span.start === 0 ? 'visible' : 'hidden'
            return `<use href="#f${span.frame}" visibility="${initial}"><animate attributeName="visibility" calcMode="discrete" dur="${duration}" repeatCount="indefinite" values="${timing.values}" keyTimes="${timing.keyTimes}"/></use>`
          })
          .join('')
  const plaque = `<rect x="-1.5" y="-1.5" width="${SPRITE_WIDTH + 3}" height="${SPRITE_HEIGHT + 3}" rx="1.5" fill="${PLAQUE_FILL}" stroke="${PLAQUE_FRAME[mood]}" stroke-width="0.75"/><rect x="1" y="${SPRITE_HEIGHT - 1}" width="${SPRITE_WIDTH - 2}" height="1" fill="${PLAQUE_FLOOR}"/>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${SPRITE_WIDTH + 4} ${SPRITE_HEIGHT + 4}" width="${(SPRITE_WIDTH + 4) * pixelSize}" height="${(SPRITE_HEIGHT + 4) * pixelSize}" shape-rendering="crispEdges" style="background:${PLAQUE_FILL};display:block">${defs}${plaque}${body}</svg>`
  svgCache.set(cacheKey, svg)
  return svg
}

// ── Roads: one dispatch's progress, castle to house ───────────────────────

export const ROAD_COLUMNS = 34

// The road strip's own size, in sprite pixels; the Svg scales to its slot.
export const ROAD_WIDTH = 160
export const ROAD_HEIGHT = SPRITE_HEIGHT + 4

// The landmarks, drawn as the sprites are: a pattern and a palette.
const CASTLE = ['....W.W...', 'W.W.WWW.W.W', 'WWWWWWWWWWW', 'WW.WW.WW.WW', 'WWWWWWWWWWW', 'WWWWWWWWWWW', 'WWWW...WWWW', 'WWWW...WWWW', 'WWWW...WWWW']
const CASTLE_COLORS: Record<string, string> = { W: '#7d7870' }
const HOUSE = ['....RR....', '...RRRR...', '..RRRRRR..', '.RRRRRRRR.', 'RRRRRRRRRR', '.HHHHHHHH.', '.HooH.ooH.', '.HooH.ooH.', '.HHHHHHHH.', '.HHHH.ddH.', '.HHHH.ddH.']
const HOUSE_COLORS = { R: '#8a5a3c', H: '#b8a27a', d: '#3e2a1e', dark: '#4a4038', lit: '#f2c230' }
const ROAD_COLORS = { toGo: '#4a4741', failed: '#7a7a7a', pennant: '#d9dee5' }

// The work sites along a road, one per todo, all drawn on one 5-wide footing
// that stands on the ground line. A finished todo shows a cairn that grows
// with the tool calls made on it (levels 1-5, one per ten calls; level 0 draws
// nothing): a low heap, a small cairn, a taller one, one with a pole, and at
// level 5 the pole flies a banner in the agent's colour, a landmark that
// reads from afar. A todo not started yet shows an enemy tent, the same one
// every time.
export const SITE_WIDTH = 5
export const WORK_LEVELS: readonly (readonly string[])[] = [
  [],
  ['.SSS.', 'SSSSS'],
  ['..S..', '.SSS.', 'SSSSS'],
  ['..S..', '.SSS.', '.SSS.', 'SSSSS'],
  ['..P..', '..P..', '..P..', '..S..', '.SSS.', '.SSS.', 'SSSSS'],
  ['..PFF', '..PFF', '..PF.', '..P..', '..S..', '.SSS.', '.SSS.', 'SSSSS'],
]
export const ENEMY_TENT = ['..T..', '.TTT.', 'TTDTT', 'TTDTT']
const SITE_COLORS = { S: '#9a9488', P: '#b8a27a', T: '#a8453b', D: '#2b1a17' }
// A mark is drawn only where it clears its neighbour and the standing agent,
// whose body reaches about six pixels either side of its middle.
const SITE_GAP = SITE_WIDTH + 1
const AGENT_REACH = 6 + Math.ceil(SITE_WIDTH / 2)

const siteRects = (site: Site, left: number, ground: number, flag: string): string => {
  if (site.kind === 'ahead') return patternRects(ENEMY_TENT, left, ground - ENEMY_TENT.length + 1, key => SITE_COLORS[key as keyof typeof SITE_COLORS])
  const art = WORK_LEVELS[site.level] ?? []
  return patternRects(art, left, ground - art.length + 1, key => (key === 'F' ? flag : SITE_COLORS[key as keyof typeof SITE_COLORS]))
}

// A landmark's pattern as SVG rects at (left, top); '.' is clear.
const patternRects = (pattern: readonly string[], left: number, top: number, colorOf: (key: string) => string | undefined): string =>
  gridRects(
    pattern.map(row => [...row].map(key => (key === '.' ? null : (colorOf(key) ?? null)))),
    left,
    top,
  )

// A dispatch's road for the desktop and other SVG surfaces: a plaque framed
// like the portraits (by state), the castle at one end and the house at the
// other, the road paved in the agent's colour as far as its todos have
// brought it, and the agent standing there; home, the house lights up and
// flies the agent's pennant.
//
// With `road` (an order's todos as sites, see tally.ts) each todo is a stop on
// the road, evenly spaced: the agent stands at the first unfinished one,
// finished ones behind it show their work level, and the ones ahead each show
// a tent. Where stops come closer than a mark is wide, only every few are
// drawn, and none is drawn under the agent. Without `road`, just the road.
export function roadSvg(appearance: Appearance, fraction: number, state: 'travelling' | 'done' | 'failed', pixelSize = 2, road?: RoadSites): string {
  const width = ROAD_WIDTH
  const height = ROAD_HEIGHT
  const ground = height - 3
  const castleLeft = 3
  const castleRight = castleLeft + CASTLE[0]!.length
  const houseLeft = width - 3 - HOUSE[0]!.length
  // Clear of the castle and of a shield carried on the agent's left.
  const roadStart = castleRight + 3
  const roadEnd = houseLeft - 1
  const clamped = Math.max(0, Math.min(1, fraction))
  const reach = roadEnd - roadStart - SPRITE_WIDTH + 2
  const stops = road?.sites.length ?? 0
  const at = stops > 0 ? roadStart + (reach * Math.min(stops, Math.max(0, road!.stands))) / stops : roadStart + reach * clamped
  const marks =
    road === undefined || stops === 0
      ? ''
      : thinned(road.sites.length, reach / road.sites.length)
          .map(index => ({ index, centre: roadStart + (reach * index) / stops + SPRITE_WIDTH / 2 }))
          .filter(({ centre }) => Math.abs(centre - (at + SPRITE_WIDTH / 2)) >= AGENT_REACH)
          .map(({ index, centre }) => siteRects(road.sites[index]!, Math.round(centre - SITE_WIDTH / 2), ground, state === 'failed' ? ROAD_COLORS.failed : appearance.color))
          .join('')
  const mood: SpriteMood = state === 'failed' ? 'failed' : state === 'done' ? 'content' : 'deliberating'
  // A fallen dispatch is framed as an alarm, even though its agent went gray.
  const frame = PLAQUE_FRAME[state === 'failed' ? 'alarmed' : mood]
  const sprite = frameRects(spriteFrame(appearance, mood, 0))
  const paved = state === 'failed' ? ROAD_COLORS.failed : appearance.color
  const pavedTo = Math.round(at + SPRITE_WIDTH / 2) - roadStart
  const castle = patternRects(CASTLE, castleLeft, ground - CASTLE.length, () => CASTLE_COLORS.W)
  const house = patternRects(HOUSE, houseLeft, ground - HOUSE.length, key => (key === 'o' ? (state === 'done' ? HOUSE_COLORS.lit : HOUSE_COLORS.dark) : HOUSE_COLORS[key as 'R' | 'H' | 'd']))
  const pennant =
    state === 'done'
      ? `<rect x="${houseLeft + 5}" y="${ground - HOUSE.length - 5}" width="1" height="5" fill="${ROAD_COLORS.pennant}"/><rect x="${houseLeft + 6}" y="${ground - HOUSE.length - 5}" width="4" height="2" fill="${appearance.color}"/>`
      : ''
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width * pixelSize}" height="${height * pixelSize}" shape-rendering="crispEdges" style="display:block">`,
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="2" fill="${PLAQUE_FILL}" stroke="${frame}" stroke-width="0.75"/>`,
    `<rect x="${castleLeft}" y="${ground}" width="${width - castleLeft * 2}" height="1" fill="${PLAQUE_FLOOR}"/>`,
    castle,
    house,
    pennant,
    `<rect x="${roadStart}" y="${ground - 1}" width="${roadEnd - roadStart}" height="1" fill="${ROAD_COLORS.toGo}"/>`,
    `<rect x="${roadStart}" y="${ground - 1}" width="${Math.max(0, Math.min(roadEnd - roadStart, pavedTo))}" height="1" fill="${paved}"/>`,
    marks,
    `<g transform="translate(${at.toFixed(1)} ${ground - SPRITE_HEIGHT})">${sprite}</g>`,
    '</svg>',
  ].join('')
}

// The stops that get a mark when `count` stops are `apart` pixels (or cells)
// apart: all of them, or every few when they would crowd each other.
const thinned = (count: number, apart: number, wanted = SITE_GAP): number[] => {
  const every = apart > 0 ? Math.max(1, Math.ceil(wanted / apart)) : count
  return Array.from({ length: count }, (_, index) => index).filter(index => index % every === 0)
}

// The text marks of the same sites: a cairn growing ▁ ▂ ▃ ▅ and a banner (⚐) at
// level 5, and ▲ for a tent.
export const TEXT_WORK = ['', '▁', '▂', '▃', '▅', '⚐'] as const
export const TEXT_TENT = '▲'

// The same road as text, for the terminal: ▰ done, ▱ to go, the agent's
// glyph where it stands, and the house (⌂) or flag (⚑) at the end.
export function roadText(glyph: string, fraction: number, state: 'travelling' | 'done' | 'failed', columns = ROAD_COLUMNS, road?: RoadSites): string {
  const span = Math.max(4, columns - 3)
  const stops = road?.sites.length ?? 0
  const cellOf = (index: number) => Math.round((index / stops) * (span - 1))
  const at = stops > 0 ? cellOf(Math.min(stops, Math.max(0, road!.stands))) : Math.round(Math.max(0, Math.min(1, fraction)) * (span - 1))
  const cells: string[] = Array.from({ length: span }, (_, index) => (index < at ? '━' : '┄'))
  if (road !== undefined && stops > 0) {
    // One cell each; stops that share a cell show the last, and none under the agent.
    road.sites.forEach((site, index) => {
      const cell = cellOf(index)
      if (cell !== at && cell < span) cells[cell] = site.kind === 'ahead' ? TEXT_TENT : TEXT_WORK[site.level] || cells[cell]!
    })
  }
  cells[at] = state === 'failed' ? '✕' : glyph
  return `▙${cells.join('')}${state === 'done' ? '⚑' : '⌂'}`
}
