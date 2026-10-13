import { describe, expect, test } from 'claude-code/testing'

import { BANNER_COLOR, ENEMY_TENT, ROAD_WIDTH, SITE_WIDTH, SPRITE_WIDTH, TEXT_TENT, TEXT_WORK, WORK_LEVELS, roadSvg, roadText } from '../hooks/sprites'
import { sitesOf, type RoadSites, type Site } from '../hooks/tally'

const LOOK = { color: '#12ab34', accessory: 'shield' } as const
const work = (level: number): Site => ({ kind: 'work', level })
const ahead: Site = { kind: 'ahead' }
const TENT = '#e0483c'
const TENT_DOOR = '#2b1a17'
const GREY = '#7a7a7a'

const road = (sites: Site[], stands: number): RoadSites => ({ sites, stands })

type Rect = { x: number; y: number; width: number }
// The rects of one colour in the part of the road drawn before the sprite and
// no wider than a mark (so not the paved road).
const rects = (svg: string, fill: string): Rect[] =>
  [...svg.split('<g transform')[0]!.matchAll(new RegExp(`<rect x="([\\d.]+)" y="([\\d.]+)" width="([\\d.]+)" height="1" fill="${fill}"`, 'g'))]
    .map(match => ({ x: Number(match[1]), y: Number(match[2]), width: Number(match[3]) }))
    .filter(rect => rect.width < SITE_WIDTH)
const bricks = (svg: string) => rects(svg, LOOK.color)
const spriteLeft = (svg: string) => Number(/<g transform="translate\(([\d.]+) /.exec(svg)![1])
// A tent's door is one rect on each of three rows.
const tentsIn = (svg: string) => rects(svg, TENT_DOOR).length / 3
const tentRects = (svg: string) => rects(svg, TENT)
// The separate stacks: groups of rects whose left edges are close.
const stacks = (found: Rect[]) => [...new Set(found.map(rect => rect.x))].sort((a, b) => a - b).filter((x, index, all) => index === 0 || x - all[index - 1]! > 2).length
// How many bricks tall a stack is: runs of rows, each run two rows high.
const brickCount = (found: Rect[]) => {
  const rows = [...new Set(found.map(rect => rect.y))].sort((a, b) => a - b)
  return rows.filter((y, index) => index === 0 || y - rows[index - 1]! > 1).length
}

describe('work art', () => {
  test('six prebuilt states: nothing, then 1 to 4 bricks, then five bricks with a banner', () => {
    expect(WORK_LEVELS).toHaveLength(6)
    expect(WORK_LEVELS[0]).toEqual([])
    for (let level = 1; level <= 5; level++) {
      const art = WORK_LEVELS[level]!
      for (const row of art) expect(row).toHaveLength(SITE_WIDTH)
      // Each brick is two full rows of six, with a blank row between bricks.
      expect(art.filter(row => row === '.BBBBBB.')).toHaveLength(level * 2)
    }
    expect(WORK_LEVELS.slice(1, 5).some(art => art.join('').includes('F'))).toBe(false)
    expect(WORK_LEVELS[5]!.join('')).toContain('F')
    expect(WORK_LEVELS[5]!.length).toBeGreaterThan(WORK_LEVELS[4]!.length)
  })

  test('the enemy tent is a red triangle, widening from a peak, with a dark door', () => {
    for (const row of ENEMY_TENT) expect(row).toHaveLength(SITE_WIDTH)
    const widths = ENEMY_TENT.map(row => [...row].filter(key => key !== '.').length)
    expect(widths).toEqual([...widths].sort((a, b) => a - b))
    expect(widths[0]).toBeLessThanOrEqual(2)
    expect(widths[widths.length - 1]).toBe(SITE_WIDTH)
    expect(ENEMY_TENT.length).toBeGreaterThanOrEqual(7)
    expect(ENEMY_TENT.join('')).toContain('D')
  })

  test('at the real size a level can be counted: level N draws N separate bricks in the agent colour', () => {
    for (const level of [1, 2, 3, 4, 5]) {
      const svg = roadSvg(LOOK, 0, 'travelling', 2, road([work(level), ahead], 1))
      expect(brickCount(bricks(svg))).toBe(level)
      expect(bricks(svg)).toHaveLength(level * 2)
      expect(stacks(bricks(svg))).toBe(1)
    }
    expect(bricks(roadSvg(LOOK, 0, 'travelling', 2, road([work(0), ahead], 1)))).toHaveLength(0)
  })

  test('only level 5 flies the banner, in its own colour', () => {
    const banner = (level: number) => rects(roadSvg(LOOK, 0, 'travelling', 2, road([work(level), ahead], 1)), BANNER_COLOR).length
    expect([0, 1, 2, 3, 4].map(banner)).toEqual([0, 0, 0, 0, 0])
    expect(banner(5)).toBeGreaterThan(0)
  })

  test('each level is taller than the one before', () => {
    const tops = [1, 2, 3, 4, 5].map(level => Math.min(...bricks(roadSvg(LOOK, 0, 'travelling', 2, road([work(level), ahead], 1))).map(rect => rect.y)))
    for (let level = 1; level < 5; level++) expect(tops[level]!).toBeLessThan(tops[level - 1]!)
  })

  test('the pixelSize only scales the drawing', () => {
    const one = roadSvg(LOOK, 0, 'travelling', 1, road([work(3), ahead], 1))
    const two = roadSvg(LOOK, 0, 'travelling', 2, road([work(3), ahead], 1))
    expect(two).toContain('width="320"')
    expect(one).toContain('width="160"')
    expect(bricks(one)).toEqual(bricks(two))
  })
})

describe('the road with sites', () => {
  test('3 done (levels 1, 3, 5), working on the 4th, 2 more to go: 3 work sites behind, the sprite at the 4th, 2 tents ahead', () => {
    const order = {
      status: 'dispatched' as const,
      todos: [12, 31, 55, 3, 0, 0].map((calls, index) => ({
        content: `t${index}`,
        activeForm: `t${index}`,
        status: index < 3 ? ('completed' as const) : index === 3 ? ('in_progress' as const) : ('pending' as const),
        calls,
      })),
    }
    const planned = sitesOf(order)
    expect(planned.stands).toBe(3)
    expect(planned.sites.map(site => site.kind)).toEqual(['work', 'work', 'work', 'ahead', 'ahead', 'ahead'])
    const svg = roadSvg(LOOK, 0.5, 'travelling', 2, planned)
    const sprite = spriteLeft(svg)
    // Two tents ahead (the third "ahead" stop is the one the sprite stands on), all right of the sprite.
    expect(tentsIn(svg)).toBe(2)
    expect(tentRects(svg).every(rect => rect.x >= sprite + SPRITE_WIDTH - 3)).toBe(true)
    // Three stacks behind it, one, three and five bricks tall.
    const found = bricks(svg)
    expect(found.every(rect => rect.x + rect.width <= sprite + 2)).toBe(true)
    expect(stacks(found)).toBe(3)
    const heights = [...new Set(found.map(rect => rect.x))].sort((a, b) => a - b).map(x => brickCount(found.filter(rect => rect.x === x)))
    expect(heights).toEqual([1, 3, 5])
    expect(rects(svg, BANNER_COLOR).length).toBeGreaterThan(0)
  })

  test('0 done: the sprite at the start, tents on every other stop, no work art', () => {
    const svg = roadSvg(LOOK, 0, 'travelling', 2, road([ahead, ahead, ahead, ahead], 0))
    expect(tentsIn(svg)).toBe(3)
    expect(bricks(svg)).toHaveLength(0)
    expect(tentRects(svg).every(rect => rect.x >= spriteLeft(svg) + SPRITE_WIDTH - 3)).toBe(true)
  })

  test('1 done: one work site behind the sprite, the rest tents', () => {
    const svg = roadSvg(LOOK, 0.25, 'travelling', 2, road([work(2), ahead, ahead, ahead], 1))
    expect(tentsIn(svg)).toBe(2)
    expect(brickCount(bricks(svg))).toBe(2)
    expect(bricks(svg).every(rect => rect.x < spriteLeft(svg))).toBe(true)
  })

  test('a finished order has no tents, its sprite at the house end', () => {
    const svg = roadSvg(LOOK, 1, 'done', 2, road([work(1), work(5)], 2))
    expect(tentsIn(svg)).toBe(0)
    expect(spriteLeft(svg)).toBeGreaterThan(ROAD_WIDTH / 2)
    expect(stacks(bricks(svg))).toBe(2)
  })

  test('a failed order draws its bricks and banner in grey; its tents stay red', () => {
    const svg = roadSvg(LOOK, 0.5, 'failed', 2, road([work(5), ahead, ahead], 1))
    expect(bricks(svg)).toHaveLength(0)
    expect(rects(svg, GREY).length).toBeGreaterThan(10)
    expect(rects(svg, BANNER_COLOR)).toHaveLength(0)
    expect(tentsIn(svg)).toBe(1)
  })

  test('the sprite stands where the fraction put it before when todos finish in order', () => {
    const plain = roadSvg(LOOK, 0.5, 'travelling')
    const sited = roadSvg(LOOK, 0.5, 'travelling', 2, road([work(0), work(0), ahead, ahead], 2))
    expect(spriteLeft(sited)).toBe(spriteLeft(plain))
  })

  test('without sites (the setting off) the road is exactly as before', () => {
    expect(roadSvg(LOOK, 0.5, 'travelling', 2, undefined)).toBe(roadSvg(LOOK, 0.5, 'travelling'))
    expect(roadSvg(LOOK, 0.5, 'travelling')).not.toContain(TENT)
    expect(roadSvg(LOOK, 0.5, 'travelling', 2, road([], 0))).toBe(roadSvg(LOOK, 0.5, 'travelling'))
  })

  test('a 12-task order keeps every stop: no tent or stack is dropped or touches the next', () => {
    const sites: Site[] = [work(1), work(2), work(3), work(4), work(5), ahead, ahead, ahead, ahead, ahead, ahead, ahead]
    const svg = roadSvg(LOOK, 0, 'travelling', 2, road(sites, 5))
    // The sprite stands on the 6th stop; the other seven are drawn (five behind it, six tents ahead).
    expect(stacks(bricks(svg))).toBe(5)
    expect(tentsIn(svg)).toBe(6)
    const marks = [...bricks(svg), ...tentRects(svg)]
    const lefts = [...new Set(marks.map(rect => rect.x))].sort((a, b) => a - b)
    const starts = lefts.filter((x, index) => index === 0 || x - lefts[index - 1]! > 2)
    for (let index = 1; index < starts.length; index++) expect(starts[index]! - starts[index - 1]!).toBeGreaterThanOrEqual(SITE_WIDTH)
  })

  test('with more todos than fit, stops are dropped, never the art shrunk or overlapped', () => {
    for (const total of [20, 40]) {
      const sites: Site[] = Array.from({ length: total }, (_, index) => (index < total / 2 ? work(1 + (index % 5)) : ahead))
      const svg = roadSvg(LOOK, 0, 'travelling', 2, road(sites, total / 2))
      const sprite = spriteLeft(svg)
      const tentLefts = [...new Set(tentRects(svg).map(rect => rect.x))].sort((a, b) => a - b)
      const starts = tentLefts.filter((left, index) => index === 0 || left - tentLefts[index - 1]! > 3)
      expect(starts.length).toBeLessThan(total / 2)
      for (let index = 1; index < starts.length; index++) expect(starts[index]! - starts[index - 1]!).toBeGreaterThanOrEqual(SITE_WIDTH)
      expect(tentRects(svg).every(rect => rect.x >= sprite + SPRITE_WIDTH - 3)).toBe(true)
      expect(bricks(svg).every(rect => rect.x + rect.width <= sprite + 2)).toBe(true)
    }
  })
})

describe('the text road', () => {
  test('levels are plain digits 1 to 5 behind the agent, tents are triangles ahead', () => {
    expect(TEXT_WORK).toEqual(['', '1', '2', '3', '4', '5'])
    const text = roadText('♞', 0, 'travelling', 34, road([work(1), work(3), work(5), ahead, ahead, ahead], 3))
    const stand = text.indexOf('♞')
    const behind = text.slice(0, stand)
    expect(behind.match(/[1-5]/g)).toEqual(['1', '3', '5'])
    expect(behind).not.toContain(TEXT_TENT)
    expect(text.slice(stand + 1).split(TEXT_TENT).length - 1).toBe(2)
  })

  test('every level reads as its own digit', () => {
    const text = roadText('♞', 0, 'travelling', 34, road([work(1), work(2), work(3), work(4), work(5), ahead], 5))
    expect(text.match(/[1-5]/g)).toEqual(['1', '2', '3', '4', '5'])
  })

  test('0 done has tents only ahead; no sites is the plain road', () => {
    expect(roadText('♞', 0, 'travelling', 34, road([ahead, ahead, ahead], 0)).split(TEXT_TENT).length - 1).toBe(2)
    expect(roadText('♞', 0.5, 'travelling', 34, undefined)).toBe(roadText('♞', 0.5, 'travelling', 34))
  })

  test('level 0 leaves the road as it was', () => {
    expect(roadText('♞', 0.5, 'travelling', 34, road([work(0), ahead], 1))).not.toMatch(/[1-5]/)
  })
})
