// One Mantine theme: true-black flat in dark (the default), a quiet neutral in light.
// Elevation is lightness alone; colour goes on data (the brand hue), never on buttons, tabs or nav.
// The primary action is inverted: white on black in dark, near-black in light. Corners stay small (8px default).
import {
  Button,
  Card,
  Modal,
  Paper,
  SegmentedControl,
  Skeleton,
  Switch,
  Tabs,
  Tooltip,
  createTheme,
  type CSSVariablesResolver,
  type MantineColorsTuple,
} from '@mantine/core'
import { contextMeta } from '../../src/generated/context'

/** A 10-shade Mantine palette from the brand's primary colour (context/brand.json). */
function palette(hex: string): MantineColorsTuple {
  const n = parseInt(hex.replace('#', ''), 16)
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const
  const mix = (t: number, to: number) => rgb.map((c) => Math.round(c + (to - c) * t))
  const toHex = (c: number[]) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
  const steps = [0.9, 0.75, 0.6, 0.4, 0.2, 0, -0.15, -0.3, -0.45, -0.6]
  return steps.map((s) => toHex(s >= 0 ? mix(s, 255) : mix(-s, 0))) as unknown as MantineColorsTuple
}

// Mantine reads dark[0] as text, dark[2] as dimmed, dark[4] as borders, dark[6] as fields and
// dark[7] as the body. A black page with grey cards (#1c1c1c) and raised steps (#2a2a2a); fields are a darker well
// with a visible border, so every control reads against its card.
const dark: MantineColorsTuple = [
  '#ffffff',
  '#b4b4b4',
  '#949494',
  '#5e5e5e',
  '#424242',
  '#2a2a2a',
  '#121212',
  '#000000',
  '#000000',
  '#000000',
]

export const theme = createTheme({
  primaryColor: 'brand',
  colors: { brand: palette(contextMeta.primaryColor), dark },
  primaryShade: { light: 7, dark: 4 },
  fontFamily: '"IBM Plex Sans", system-ui, sans-serif',
  fontFamilyMonospace: '"IBM Plex Mono", ui-monospace, monospace', // code samples only (taste-skill-ignore)
  headings: {
    fontFamily: '"IBM Plex Sans", system-ui, sans-serif',
    fontWeight: '600',
    sizes: {
      h1: { fontSize: '24px', lineHeight: '32px' },
      h2: { fontSize: '18px', lineHeight: '24px' },
      h3: { fontSize: '16px', lineHeight: '24px' },
    },
  },
  fontSizes: { xs: '12px', sm: '14px', md: '14px', lg: '16px', xl: '18px' },
  lineHeights: { xs: '1.4', sm: '1.43', md: '1.5', lg: '1.5', xl: '1.4' },
  radius: { xs: '2px', sm: '4px', md: '6px', lg: '8px', xl: '12px' },
  defaultRadius: 'lg',
  spacing: { xs: '8px', sm: '12px', md: '16px', lg: '24px', xl: '32px' },
  cursorType: 'pointer',
  focusRing: 'auto',
  other: { column: 1152 },
  components: {
    Button: Button.extend({
      defaultProps: { radius: 'md', size: 'sm' },
      classNames: { root: 'va-button' },
      // The one primary is inverted; the brand hue never fills a button.
      vars: (_theme, props) =>
        (props.variant ?? 'filled') === 'filled' && !props.color
          ? {
              root: {
                '--button-bg': 'var(--va-primary-bg)',
                '--button-hover': 'var(--va-primary-bg)',
                '--button-color': 'var(--va-primary-ink)',
              },
            }
          : { root: {} },
    }),
    Card: Card.extend({
      defaultProps: { radius: 'lg', padding: 'lg', withBorder: false },
      classNames: { root: 'va-surface' },
    }),
    // A darker, blurred backdrop, so a dialog reads as a layer above the page.
    Modal: Modal.extend({ defaultProps: { overlayProps: { backgroundOpacity: 0.72, blur: 3 } } }),
    Paper: Paper.extend({
      defaultProps: { radius: 'lg', withBorder: false },
      classNames: { root: 'va-surface' },
    }),
    SegmentedControl: SegmentedControl.extend({ defaultProps: { radius: 'md', size: 'sm' } }),
    Skeleton: Skeleton.extend({ defaultProps: { animate: false, radius: 'sm' } }),
    Tabs: Tabs.extend({ vars: () => ({ root: { '--tabs-color': 'var(--va-text)' } }) }),
    Switch: Switch.extend({ vars: () => ({ root: { '--switch-color': 'var(--va-muted)' } }) }),
    Tooltip: Tooltip.extend({ defaultProps: { openDelay: 300 } }),
  },
})

/** Role tokens (`--va-*`) for both schemes; components and the CSS module use only these. */
export const resolver: CSSVariablesResolver = () => ({
  variables: {
    '--va-column': '1152px',
    '--va-accent': contextMeta.primaryColor,
    '--va-bar': '48px',
  },
  light: {
    '--va-ground': '#f9fafb',
    '--va-surface': '#ffffff',
    '--va-raised': '#f2f3f5',
    '--va-dialog': '#ffffff',
    '--va-dialog-raised': '#f2f3f5',
    '--va-dialog-edge': '#dfe2e6',
    '--va-rule': '#ebedf0',
    '--va-text': '#111111',
    '--va-muted': '#5f6368',
    '--va-faint': '#6b6b6b',
    '--va-primary-bg': '#1d1f20',
    '--va-primary-ink': '#ffffff',
    '--va-negative': '#c4242a',
    '--va-negative-bg': '#ffedea',
    '--va-warning-bg': '#fffbeb',
    '--va-warning-ink': '#92400e',
    '--va-accent-tint': 'color-mix(in srgb, var(--va-accent) 14%, white)',
    '--mantine-color-body': '#f9fafb',
  },
  dark: {
    '--va-ground': '#000000',
    '--va-surface': '#1c1c1c',
    '--va-raised': '#2a2a2a',
    // Dialogs sit a clear step above the black page, with their own raised step and edge.
    '--va-dialog': '#242424',
    '--va-dialog-raised': '#303030',
    '--va-dialog-edge': '#454545',
    '--va-rule': '#2a2a2a',
    '--va-text': '#ffffff',
    '--va-muted': '#b4b4b4',
    '--va-faint': '#949494',
    '--va-primary-bg': '#ffffff',
    '--va-primary-ink': '#000000',
    '--va-negative': '#e5566f',
    '--va-negative-bg': '#2c1a20',
    '--va-warning-bg': '#2a2310',
    '--va-warning-ink': '#f2c94c',
    '--va-accent-tint': 'color-mix(in srgb, var(--va-accent) 18%, black)',
    '--mantine-color-body': '#000000',
    '--mantine-color-text': '#ffffff',
    '--mantine-color-dimmed': '#b4b4b4',
  },
})

export const brand = contextMeta
