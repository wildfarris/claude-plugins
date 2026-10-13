import { describe, expect, test } from 'claude-code/testing'

import { ENEMY_TENT, ROAD_WIDTH, SITE_WIDTH, SPRITE_WIDTH, TEXT_TENT, TEXT_WORK, WORK_LEVELS, roadSvg, roadText } from '../hooks/sprites'
import { sitesOf, type RoadSites, type Site } from '../hooks/tally'

const LOOK = { color: '#d4a017', accessory: 'shield' } as const
const work = (level: number): Site => ({ kind: 'work', level })
const ahead: Site = { kind: 'ahead' }
const TENT = '#a8453b'
const TENT_DOOR = '#2b1a17'
const STONE = '#9a9488'
const GREY = '#7a7a7a'

const road = (sites: Site[], stands: number): RoadSites => ({ sites, stands })
const count = (svg: string, fill: string) => svg.split(`fill="${fill}"`).length - 1
// The left edges of the rects of a colour.
const lefts = (svg: string, fill: string) => [...svg.matchAll(new RegExp(`<rect x="([\\d.]+)" y="[\\d.]+" width="[\\d.]+" height="1" fill="${fill}"`, 'g'))].map(match => Number(match[1]))
const spriteLeft = (svg: string) => Number(/<g transform="translate\(([\d.]+) /.exec(svg)![1])
// The tent's door is two one-pixel rects, so two per tent.
const tentsIn = (svg: string) => count(svg, TENT_DOOR) / 2

describe('work art', () => {
  test('six prebuilt states: nothing, then five that grow, the last with a banner', () => {
    expect(WORK_LEVELS).toHaveLength(6)
    expect(WORK_LEVELS[0]).toEqual([])
    const heights = WORK_LEVELS.map(art => art.length)
    expect(heights).toEqual([...heights].sort((a, b) => a - b))
    expect(new Set(heights.slice(1)).size).toBe(5)
    for (const art of WORK_LEVELS.slice(1)) for (const row of art) expect(row).toHaveLength(SITE_WIDTH)
    expect(WORK_LEVELS.slice(1, 5).some(art => art.join('').includes('F'))).toBe(false)
    expect(WORK_LEVELS[5]!.join('')).toContain('F')
    for (const row of ENEMY_TENT) expect(row).toHaveLength(SITE_WIDTH)
  })

  test('each level draws more than the one before; only level 5 adds the banner colour', () => {
    const drawn = [0, 1, 2, 3, 4, 5].map(level => roadSvg(LOOK, 0, 'travelling', 2, road([work(level), ahead], 1)))
    const stones = drawn.map(svg => count(svg, STONE))
    expect(stones[0]).toBe(0)
    expect(stones[1]).toBeGreaterThan(0)
    for (let level = 2; level <= 5; level++) expect(stones[level]).toBeGreaterThanOrEqual(stones[level - 1]!)
    // The sprite is drawn in the same colour, so the banner shows as extra rects of it.
    const flags = drawn.map(svg => count(svg, LOOK.color))
    expect(flags[5]).toBeGreaterThan(flags[4]!)
    expect(flags[4]).toBe(flags[1])
    expect(drawn.map(svg => svg.length)).toEqual([...drawn.map(svg => svg.length)].sort((a, b) => a - b))
  })
})

describe('the road with sites', () => {
  test('3 done, working on the 4th, 2 more to go: 3 work sites behind, the sprite at the 4th, 2 tents ahead', () => {
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
    const tentLefts = lefts(svg, TENT)
    expect(tentLefts.every(left => left >= sprite + SPRITE_WIDTH - 2)).toBe(true)
    // Cairns (levels 1, 3, 5) all behind it.
    const stoneLefts = lefts(svg, STONE)
    expect(stoneLefts.length).toBeGreaterThan(0)
    expect(stoneLefts.every(left => left < sprite)).toBe(true)
    // Three distinct cairns: three separate clusters of stone.
    const clusters = [...new Set(stoneLefts)].sort((a, b) => a - b).filter((left, index, all) => index === 0 || left - all[index - 1]! > 1)
    expect(clusters.length).toBe(3)
  })

  test('0 done: the sprite at the start, tents on every other stop, no work art', () => {
    const svg = roadSvg(LOOK, 0, 'travelling', 2, road([ahead, ahead, ahead, ahead], 0))
    expect(tentsIn(svg)).toBe(3)
    expect(count(svg, STONE)).toBe(0)
    expect(lefts(svg, TENT).every(left => left >= spriteLeft(svg) + SPRITE_WIDTH - 2)).toBe(true)
  })

  test('1 done: one work site behind the sprite, the rest tents', () => {
    const svg = roadSvg(LOOK, 0.25, 'travelling', 2, road([work(2), ahead, ahead, ahead], 1))
    expect(tentsIn(svg)).toBe(2)
    expect(count(svg, STONE)).toBeGreaterThan(0)
    expect(lefts(svg, STONE).every(left => left < spriteLeft(svg))).toBe(true)
  })

  test('a finished order has no tents, its sprite at the house end', () => {
    const svg = roadSvg(LOOK, 1, 'done', 2, road([work(1), work(5)], 2))
    expect(tentsIn(svg)).toBe(0)
    expect(spriteLeft(svg)).toBeGreaterThan(ROAD_WIDTH / 2)
  })

  test('a failed order flies its banner in grey', () => {
    const grey = count(roadSvg(LOOK, 0.5, 'failed'), GREY)
    expect(count(roadSvg(LOOK, 0.5, 'failed', 2, road([work(5), ahead], 1)), GREY)).toBeGreaterThan(grey)
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

  test('with many todos, marks stay clear of each other and of the sprite', () => {
    for (const total of [12, 20, 40]) {
      const sites: Site[] = Array.from({ length: total }, (_, index) => (index < total / 2 ? work(1 + (index % 5)) : ahead))
      const svg = roadSvg(LOOK, 0, 'travelling', 2, road(sites, total / 2))
      const sprite = spriteLeft(svg)
      const tentLefts = [...new Set(lefts(svg, TENT))].sort((a, b) => a - b)
      // A tent's rects span three pixels from its left edge; separate tents are further apart than that.
      const starts = tentLefts.filter((left, index) => index === 0 || left - tentLefts[index - 1]! > 2)
      for (let index = 1; index < starts.length; index++) expect(starts[index]! - starts[index - 1]!).toBeGreaterThanOrEqual(SITE_WIDTH)
      expect(tentLefts.every(left => left >= sprite + SPRITE_WIDTH - 2)).toBe(true)
      expect(lefts(svg, STONE).every(left => left < sprite)).toBe(true)
    }
  })
})

describe('the text road', () => {
  test('stops show as cairn marks behind the agent and tents ahead', () => {
    const text = roadText('♞', 0, 'travelling', 34, road([work(1), work(3), work(5), ahead, ahead, ahead], 3))
    const stand = text.indexOf('♞')
    const behind = text.slice(0, stand)
    expect(behind).toContain(TEXT_WORK[1])
    expect(behind).toContain(TEXT_WORK[3])
    expect(behind).toContain(TEXT_WORK[5])
    expect(behind).not.toContain(TEXT_TENT)
    expect(text.slice(stand + 1).split(TEXT_TENT).length - 1).toBe(2)
  })

  test('0 done has tents only ahead; no sites is the plain road', () => {
    expect(roadText('♞', 0, 'travelling', 34, road([ahead, ahead, ahead], 0)).split(TEXT_TENT).length - 1).toBe(2)
    expect(roadText('♞', 0.5, 'travelling', 34, undefined)).toBe(roadText('♞', 0.5, 'travelling', 34))
  })

  test('level 0 leaves the road as it was', () => {
    expect(roadText('♞', 0.5, 'travelling', 34, road([work(0), ahead], 1))).not.toContain(TEXT_WORK[1])
  })
})
