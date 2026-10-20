import { describe, expect, test } from 'claude-code/testing'

import { analyzePowerShell, parsePowerShell, powerShellPathOps, psCommandName } from '../hooks/powershell'

const ROOT = 'C:\\work'
const WEB = `${ROOT}\\web`
const IN_WEB = { root: ROOT, cwd: WEB, folders: [WEB], home: 'C:\\Users\\me' }
const kindOf = (command: string, context = IN_WEB) => analyzePowerShell(command, context).kind

describe('reading PowerShell', () => {
  test('statements, pipes, strings, comments and inner code', () => {
    const segments = parsePowerShell("Get-ChildItem 'a b' | Select-String \"x$(Get-Date)\"; # note\nSet-Location src && dir")
    expect(segments.map(segment => psCommandName(segment))).toEqual(['get-childitem', 'select-string', 'set-location', 'get-childitem'])
    expect(segments[0]!.tokens[1]).toEqual({ text: 'a b', isQuoted: true })
    expect(segments[1]!.isPiped).toBe(true)
    expect(segments[1]!.inner).toEqual(['Get-Date'])
    expect(parsePowerShell("Write-Output 'it''s'")[0]!.tokens[1]!.text).toBe("it's")
    expect(parsePowerShell('Write-Output a`;b')[0]!.tokens[1]!.text).toBe('a;b')
    expect(parsePowerShell("$x = @'\nline; rm -rf /\n'@").length).toBe(1)
    expect(parsePowerShell('Get-ChildItem | ForEach-Object { Remove-Item $_ }')[1]!.inner).toEqual([' Remove-Item $_ '])
    expect(parsePowerShell('Remove-Item a.txt, b.txt')[0]!.tokens.map(token => token.text)).toEqual(['Remove-Item', 'a.txt', 'b.txt'])
    expect(parsePowerShell("'x' > out.txt 2>&1")[0]!.tokens.filter(token => token.isRedirect).map(token => token.text)).toEqual(['out.txt'])
  })
})

describe('the scope of PowerShell writes', () => {
  test('writes inside the folder are allowed, outside are blocked', () => {
    expect(kindOf("Set-Content -Path notes.md -Value 'x'")).toBe('allow')
    expect(kindOf("Set-Content ..\\api\\notes.md 'x'")).toBe('block')
    expect(kindOf("Add-Content -LiteralPath 'C:\\work\\api\\log.txt' -Value x")).toBe('block')
    expect(kindOf("'x' | Out-File -FilePath ..\\api\\a.txt")).toBe('block')
    expect(kindOf("'x' > ..\\api\\a.txt")).toBe('block')
    expect(kindOf("'x' > a.txt")).toBe('allow')
    expect(kindOf('Remove-Item -Recurse -Force dist')).toBe('allow')
    expect(kindOf('rm ..\\api\\dist -Recurse')).toBe('block')
    expect(kindOf('del a.txt, ..\\api\\b.txt')).toBe('block')
    expect(kindOf('Move-Item a.txt ..\\api\\')).toBe('block')
    expect(kindOf('Move-Item ..\\api\\a.txt .')).toBe('block')
    expect(kindOf('Copy-Item ..\\api\\a.txt .')).toBe('allow')
    expect(kindOf('Copy-Item a.txt -Dest ..\\api')).toBe('block')
    expect(kindOf('New-Item -ItemType Directory -Path src\\x')).toBe('allow')
    expect(kindOf('New-Item -Path .. -Name api2 -ItemType Directory')).toBe('block')
    expect(kindOf('mkdir ..\\api\\x')).toBe('block')
    expect(kindOf('Rename-Item a.txt b.txt')).toBe('allow')
    expect(kindOf('Clear-Content C:\\work\\api\\a.txt')).toBe('block')
    // Outside the session root is never policed.
    expect(kindOf('Remove-Item C:\\Temp\\scratch.txt')).toBe('allow')
  })

  test('locations are followed; what cannot be resolved is unclear', () => {
    expect(kindOf('Set-Location ..\\api; Remove-Item a.txt')).toBe('block')
    expect(kindOf('cd ..\\api; Get-ChildItem')).toBe('allow')
    expect(kindOf('Push-Location src; Remove-Item a.txt; Pop-Location')).toBe('allow')
    expect(kindOf('Remove-Item $env:TEMP\\x')).toBe('unclear')
    expect(kindOf('Remove-Item (Join-Path $root x)')).toBe('unclear')
    expect(kindOf('Get-ChildItem | ForEach-Object { Remove-Item ..\\api\\x }')).toBe('block')
  })

  test('native commands are read as the Bash reader reads them', () => {
    expect(kindOf('git status')).toBe('allow')
    expect(kindOf('git -C ..\\api commit -m x')).toBe('block')
    expect(kindOf("bash -c 'rm -rf ../api/x'")).toBe('block')
    expect(kindOf('npm install')).toBe('allow')
    expect(kindOf('npm install', { ...IN_WEB, cwd: ROOT })).toBe('block')
  })

  test('the path rules see what the cmdlets change', () => {
    const ops = powerShellPathOps("Remove-Item src\\a.spec.ts; Move-Item b.ts c.spec.ts; Set-Content d.css 'x'", IN_WEB)
    expect(ops).toEqual([
      { path: 'c:/work/web/src/a.spec.ts', op: 'delete', into: [] },
      { path: 'c:/work/web/b.ts', op: 'delete', into: [] },
      { path: 'c:/work/web/c.spec.ts', op: 'write', into: ['b.ts'] },
      { path: 'c:/work/web/d.css', op: 'write', into: [] },
    ])
  })
})
