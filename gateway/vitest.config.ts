import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // Tests check the gateway against the rest of the repo (the connection
  // catalog, Console's copy of the brand logos), so they may read past it.
  server: { fs: { allow: [".."] } },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
