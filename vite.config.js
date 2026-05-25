import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" makes the build work from any path, including GitHub Pages
export default defineConfig({
  plugins: [react()],
  base: "./",
});
