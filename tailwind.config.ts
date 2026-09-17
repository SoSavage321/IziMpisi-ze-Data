import type { Config } from 'tailwindcss';

/**
 * Industrial theme. Status colours are paired with an icon and a word
 * everywhere they are used — colour alone never carries meaning, because
 * roughly 1 in 12 men has some form of colour vision deficiency and this
 * dashboard is read on a phone in daylight.
 */
export default {
  darkMode: ['class', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg:      'rgb(var(--bg) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        raised:  'rgb(var(--raised) / <alpha-value>)',
        line:    'rgb(var(--line) / <alpha-value>)',
        ink:     'rgb(var(--ink) / <alpha-value>)',
        'ink-2':  'rgb(var(--ink-2) / <alpha-value>)',
        muted:   'rgb(var(--muted) / <alpha-value>)',
        accent:  'rgb(var(--accent) / <alpha-value>)',
        good:    'rgb(var(--good) / <alpha-value>)',
        warn:    'rgb(var(--warn) / <alpha-value>)',
        serious: 'rgb(var(--serious) / <alpha-value>)',
        crit:    'rgb(var(--crit) / <alpha-value>)',
        info:    'rgb(var(--info) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'Consolas', 'monospace'],
        display: ['"Archivo"', '"IBM Plex Sans"', 'system-ui', 'sans-serif'],
      },
      borderRadius: { xl: '12px' },
      keyframes: {
        pulseDot: { '0%,100%': { opacity: '1' }, '50%': { opacity: '.3' } },
        flow: { to: { strokeDashoffset: '-22' } },
      },
      animation: {
        pulseDot: 'pulseDot 2.2s ease-in-out infinite',
        flow: 'flow 1.1s linear infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
