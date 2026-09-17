import type { Config } from 'tailwindcss';

/**
 * Deep Blue + Teal.
 *
 * Status colours are always paired with an icon and a word — colour alone
 * never carries meaning, because roughly one man in twelve has some form of
 * colour vision deficiency and this is read on a phone in daylight. Each
 * status also has an `-ink` step for use as text, since the bright one is not
 * legible as a label on white.
 */
export default {
  darkMode: ['class', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg:        'rgb(var(--bg) / <alpha-value>)',
        surface:   'rgb(var(--surface) / <alpha-value>)',
        raised:    'rgb(var(--raised) / <alpha-value>)',
        line:      'rgb(var(--line) / <alpha-value>)',
        'line-soft': 'rgb(var(--line-soft) / <alpha-value>)',

        ink:       'rgb(var(--ink) / <alpha-value>)',
        'ink-2':   'rgb(var(--ink-2) / <alpha-value>)',
        muted:     'rgb(var(--muted) / <alpha-value>)',

        primary:   'rgb(var(--primary) / <alpha-value>)',
        secondary: 'rgb(var(--secondary) / <alpha-value>)',
        accent:    'rgb(var(--accent) / <alpha-value>)',
        'accent-ink': 'rgb(var(--accent-ink) / <alpha-value>)',

        good:      'rgb(var(--good) / <alpha-value>)',
        'good-ink': 'rgb(var(--good-ink) / <alpha-value>)',
        warn:      'rgb(var(--warn) / <alpha-value>)',
        'warn-ink': 'rgb(var(--warn-ink) / <alpha-value>)',
        crit:      'rgb(var(--crit) / <alpha-value>)',
        'crit-ink': 'rgb(var(--crit-ink) / <alpha-value>)',
        info:      'rgb(var(--info) / <alpha-value>)',
        'info-ink': 'rgb(var(--info-ink) / <alpha-value>)',

        nav:       'rgb(var(--nav) / <alpha-value>)',
        'nav-2':   'rgb(var(--nav-2) / <alpha-value>)',
        'nav-ink': 'rgb(var(--nav-ink) / <alpha-value>)',
        'nav-muted': 'rgb(var(--nav-muted) / <alpha-value>)',
        'nav-line': 'rgb(var(--nav-line) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        display: ['"IBM Plex Sans"', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'Consolas', 'monospace'],
      },
      boxShadow: {
        xs: 'var(--shadow-sm)',
        card: 'var(--shadow)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
      },
      borderRadius: { xl: '12px', '2xl': '16px' },
      keyframes: {
        pulseDot: { '0%,100%': { opacity: '1' }, '50%': { opacity: '.35' } },
        flow: { to: { strokeDashoffset: '-22' } },
        fadeUp: {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'none' },
        },
      },
      animation: {
        pulseDot: 'pulseDot 2.2s ease-in-out infinite',
        flow: 'flow 1.1s linear infinite',
        fadeUp: 'fadeUp .18s ease-out',
      },
    },
  },
  plugins: [],
} satisfies Config;
