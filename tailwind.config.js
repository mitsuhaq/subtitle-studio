/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          950: "#0a0a0a",
          900: "#0f0f10",
          800: "#15151a",
          700: "#1a1a20",
        },
        gold: {
          50: "#fdf6dd",
          100: "#f8e89a",
          200: "#f4d975",
          300: "#f4d03f",
          400: "#e6c136",
          500: "#d4af37",
          600: "#a98a2b",
          700: "#7e6720",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "-apple-system",
          "BlinkMacSystemFont",
          "SF Pro Text",
          "Segoe UI",
          "Helvetica Neue",
          "sans-serif",
        ],
      },
      backdropBlur: { xs: "2px" },
      boxShadow: {
        gold: "0 0 24px -4px rgba(212,175,55,0.45)",
        goldStrong: "0 0 36px 0 rgba(244,208,63,0.6)",
      },
      animation: {
        "gold-pulse": "goldPulse 2.4s ease-in-out infinite",
        "fade-in": "fadeIn 220ms ease-out",
        "gold-flash": "goldFlash 1500ms ease-out",
        "tab-pulse": "tabPulse 1800ms ease-in-out infinite",
      },
      keyframes: {
        goldPulse: {
          "0%, 100%": { opacity: "0.35" },
          "50%": { opacity: "0.85" },
        },
        fadeIn: {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        goldFlash: {
          "0%": {
            boxShadow:
              "0 0 0 0 rgba(244,208,63,0.85), 0 0 0 0 rgba(244,208,63,0.55)",
            transform: "scale(0.985)",
          },
          "30%": {
            boxShadow:
              "0 0 30px 8px rgba(244,208,63,0.45), 0 0 60px 12px rgba(244,208,63,0.25)",
            transform: "scale(1.005)",
          },
          "100%": {
            boxShadow: "0 0 0 0 rgba(244,208,63,0), 0 0 0 0 rgba(244,208,63,0)",
            transform: "scale(1)",
          },
        },
        tabPulse: {
          "0%, 100%": {
            boxShadow: "0 0 0 0 rgba(244,208,63,0.55)",
          },
          "50%": {
            boxShadow: "0 0 0 6px rgba(244,208,63,0)",
          },
        },
      },
    },
  },
  plugins: [],
};
