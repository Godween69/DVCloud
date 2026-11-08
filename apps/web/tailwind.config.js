/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      // Спокойные серые оттенки светлой темы, те же, что на сайте-визитке автора.
      colors: {
        paper: {
          50: '#f5f6f8',
          100: '#e7e9ed',
          200: '#dde0e6',
          300: '#c9cdd6',
          400: '#b4bac6',
          500: '#8d94a3',
        },
      },
    },
  },
  plugins: [],
};
