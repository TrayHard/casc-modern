/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: { extend: {} },
  corePlugins: { preflight: false }, // antd has its own resets
  plugins: [],
};
