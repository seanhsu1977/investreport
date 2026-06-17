/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        navy:  "#0B1E3D",
        navy2: "#122548",
        navy3: "#1a3261",
        gold:  "#C9A84C",
      },
    },
  },
  plugins: [],
};
