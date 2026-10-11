// The bar above the prompt: one line of buttons, one panel open under it.
// Every feature is an item (a button, maybe a dot or "…") and, when open, a
// panel (lines, an optional text box, actions). A new feature adds an item.
// Pure: drawn from the surface's element table, plain data and callbacks.

import type { ElementTable, RenderNode, UiPressArgument } from 'claude-code'

// A press's argument names the surface it came from (a copy needs it).
export type Handler = (press: UiPressArgument) => unknown

export type BarItem = {
  id: string
  label: string
  // Something new behind it (a heads-up, an unanswered warning).
  hasDot?: boolean
  // Working: a model call is running.
  isBusy?: boolean
  onPress: Handler
}

export type BarAction = { key: string; label: string; onPress: Handler; isPrimary?: boolean }

export type BarLine = { text: string; isBold?: boolean; isDim?: boolean; isItalic?: boolean }

export type BarPanel = {
  // Theme key for the panel's bar.
  accent: string
  title: string
  lines: BarLine[]
  input?: { key: string; placeholder: string; submitLabel: string; onSubmit: (value: string) => unknown }
  actions: BarAction[]
}

export type BarModel = {
  items: BarItem[]
  openId: string | null
  panel?: BarPanel
}

const itemLabel = (item: BarItem) => `${item.label}${item.isBusy ? ' …' : ''}${item.hasDot ? ' •' : ''}`

export function barView(el: ElementTable, model: BarModel) {
  const { Box, Text, Button } = el
  // Input exists on the terminal and desktop tables, not mobile's.
  const Input = (el as unknown as Record<string, ((props: Record<string, unknown>) => RenderNode) | undefined>).Input
  const { panel } = model
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} paddingLeft={1}>
        <Text color="claude">✦</Text>
        {model.items.map((item, index) => (
          <Box key={`item-${item.id}`} flexDirection="row" columnGap={1}>
            {index > 0 && <Text dimColor>·</Text>}
            <Button
              key={`bar-${item.id}`}
              label={itemLabel(item)}
              plain
              variant={model.openId === item.id ? 'primary' : undefined}
              dimColor={model.openId !== item.id && !item.hasDot}
              onPress={item.onPress}
            />
          </Box>
        ))}
      </Box>
      {panel && (
        // One quote bar in the feature's colour, as the council's and the
        // commons' secondary blocks are drawn; its title in the same colour.
        <Box flexDirection="column" borderStyle="quote" borderColor={panel.accent} paddingLeft={1} marginLeft={1}>
          <Text bold color={panel.accent}>
            {panel.title}
          </Text>
          {panel.lines.map((line, index) => (
            <Text key={`line-${index}`} bold={line.isBold} dimColor={line.isDim} italic={line.isItalic} wrap="wrap">
              {line.text}
            </Text>
          ))}
          {panel.input && Input ? (
            // The field sizes to its container: stretch it across the panel.
            <Box flexDirection="row" width="100%">
              <Box flexGrow={1} flexShrink={1}>
                {Input({ key: panel.input.key, placeholder: panel.input.placeholder, submitLabel: panel.input.submitLabel, autoFocus: true, onSubmit: (value: string) => panel.input!.onSubmit(value) })}
              </Box>
            </Box>
          ) : null}
          {panel.actions.length > 0 && (
            // The main action at full strength, the rest dim; wraps at narrow widths.
            <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
              {panel.actions.map(action => (
                <Button key={action.key} label={action.label} plain dimColor={!action.isPrimary} onPress={action.onPress} />
              ))}
            </Box>
          )}
        </Box>
      )}
    </Box>
  )
}
