import type { Config } from 'tailwindcss'
import tailwindcssAnimate from 'tailwindcss-animate'

export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  prefix: '',
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: {
        '2xl': '1400px',
      },
    },
    extend: {
      colors: {
        border: 'hsl(var(--border) / <alpha-value>)',
        input: 'hsl(var(--input) / <alpha-value>)',
        ring: 'hsl(var(--ring) / <alpha-value>)',
        background: 'hsl(var(--background) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        brand: {
          DEFAULT: 'hsl(var(--brand) / <alpha-value>)',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary) / <alpha-value>)',
          foreground: 'hsl(var(--primary-foreground) / <alpha-value>)',
        },
        'primary-container': 'hsl(var(--primary-container) / <alpha-value>)',
        'on-primary-container': 'hsl(var(--on-primary-container) / <alpha-value>)',
        secondary: {
          DEFAULT: 'hsl(var(--secondary) / <alpha-value>)',
          foreground: 'hsl(var(--secondary-foreground) / <alpha-value>)',
        },
        'secondary-container': 'hsl(var(--secondary-container) / <alpha-value>)',
        'on-secondary-container': 'hsl(var(--on-secondary-container) / <alpha-value>)',
        destructive: {
          DEFAULT: 'hsl(var(--destructive) / <alpha-value>)',
          foreground: 'hsl(var(--destructive-foreground) / <alpha-value>)',
        },
        'error-container': 'hsl(var(--error-container) / <alpha-value>)',
        'on-error-container': 'hsl(var(--on-error-container) / <alpha-value>)',
        muted: {
          DEFAULT: 'hsl(var(--muted) / <alpha-value>)',
          foreground: 'hsl(var(--muted-foreground) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent) / <alpha-value>)',
          foreground: 'hsl(var(--accent-foreground) / <alpha-value>)',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover) / <alpha-value>)',
          foreground: 'hsl(var(--popover-foreground) / <alpha-value>)',
        },
        card: {
          DEFAULT: 'hsl(var(--card) / <alpha-value>)',
          foreground: 'hsl(var(--card-foreground) / <alpha-value>)',
        },
        /* MD3 surface ladder — bg-surface, bg-surface-container-{lowest,low,high,highest}, bg-surface-variant */
        surface: {
          DEFAULT: 'hsl(var(--surface) / <alpha-value>)',
          container: {
            lowest: 'hsl(var(--surface-container-lowest) / <alpha-value>)',
            low: 'hsl(var(--surface-container-low) / <alpha-value>)',
            DEFAULT: 'hsl(var(--surface-container) / <alpha-value>)',
            high: 'hsl(var(--surface-container-high) / <alpha-value>)',
            highest: 'hsl(var(--surface-container-highest) / <alpha-value>)',
          },
          /* MD3 surface-variant is the same tone as surface-container-highest */
          variant: 'hsl(var(--surface-container-highest) / <alpha-value>)',
        },
        /* MD3 outline roles — text-outline (chevrons), border-outline-variant/30 (dividers) */
        outline: {
          DEFAULT: 'hsl(var(--outline) / <alpha-value>)',
          variant: 'hsl(var(--outline-variant) / <alpha-value>)',
        },
        success: 'hsl(var(--success) / <alpha-value>)',
        warning: 'hsl(var(--warning) / <alpha-value>)',
        income: 'hsl(var(--income) / <alpha-value>)',
        expense: 'hsl(var(--expense) / <alpha-value>)',
        money: {
          income: 'hsl(var(--money-income) / <alpha-value>)',
          expense: 'hsl(var(--money-expense) / <alpha-value>)',
        },
      },
      borderRadius: {
        /* rounded-xl (cards/dialogs) wired to --radius so one token retunes
           every corner in the app; keep xl >= lg. */
        xl: 'var(--radius)',
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        serif: ["'Playfair Display'", 'Georgia', 'serif'],
        mono: ["'JetBrains Mono'", 'monospace'],
      },
      /* MD3 type scale  — each token carries its line-height +
         weight + tracking, so `text-display-lg` etc. sets all three. Additive:
         the default Tailwind sizes (text-xs … text-5xl) stay available. */
      fontSize: {
        'display-lg': ['48px', { lineHeight: '56px', letterSpacing: '-0.02em', fontWeight: '700' }],
        'headline-lg': ['32px', { lineHeight: '40px', letterSpacing: '-0.01em', fontWeight: '600' }],
        'headline-lg-mobile': ['28px', { lineHeight: '36px', fontWeight: '600' }],
        'headline-md': ['24px', { lineHeight: '32px', fontWeight: '600' }],
        'title-lg': ['20px', { lineHeight: '28px', fontWeight: '500' }],
        'body-lg': ['18px', { lineHeight: '28px', fontWeight: '400' }],
        'body-md': ['16px', { lineHeight: '24px', fontWeight: '400' }],
        'label-md': ['14px', { lineHeight: '20px', letterSpacing: '0.01em', fontWeight: '500' }],
        'label-sm': ['12px', { lineHeight: '16px', letterSpacing: '0.05em', fontWeight: '600' }],
      },
      boxShadow: {
        /* Elevation ladder — values live as CSS vars in index.css (light + .dark
           overrides) so a card's shadow adapts to theme. shadow-card = resting,
           shadow-card-hover = hover-lift, shadow-overlay = popovers/dialogs. */
        card: 'var(--shadow-card)',
        'card-hover': 'var(--shadow-card-hover)',
        overlay: 'var(--shadow-overlay)',
        /* Alias kept for existing callers; same tone as the overlay layer. */
        elevated: 'var(--shadow-overlay)',
        /* Bottom nav shadow-up */
        nav: '0 -4px 20px rgba(0, 0, 0, 0.06)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        'fade-in': {
          from: { opacity: '0', filter: 'blur(4px)' },
          to: { opacity: '1', filter: 'blur(0px)' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(16px)', filter: 'blur(4px)' },
          to: { opacity: '1', transform: 'translateY(0)', filter: 'blur(0px)' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'fade-in': 'fade-in 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'slide-up': 'slide-up 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards',
      },
    },
  },
  plugins: [tailwindcssAnimate],
} satisfies Config
