import { fileURLToPath } from "node:url";
// Where screenshots go and how to launch Chromium. PLAYWRIGHT_CHROMIUM overrides the browser path.
import { mkdirSync } from "node:fs";
export const shots = fileURLToPath(new URL("./shots/", import.meta.url));
mkdirSync(shots, { recursive: true });
export const launch = process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {};
