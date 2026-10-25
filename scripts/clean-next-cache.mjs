// scripts/clean-next-cache.mjs

import {
  existsSync,
  rmSync,
} from "node:fs";

import {
  resolve,
} from "node:path";

const projectRoot = process.cwd();

const removablePaths = [
  ".next",
  "node_modules/.cache",
  "tsconfig.tsbuildinfo",
];

for (const relativePath of removablePaths) {
  const absolutePath = resolve(
    projectRoot,
    relativePath,
  );

  if (!existsSync(absolutePath)) {
    console.log(
      `[clean] Already absent: ${relativePath}`,
    );

    continue;
  }

  try {
    rmSync(absolutePath, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 250,
    });

    console.log(`[clean] Removed: ${relativePath}`);
  } catch (error) {
    console.error(
      `[clean] Failed to remove: ${relativePath}`,
    );

    console.error(
      error instanceof Error
        ? error.message
        : String(error),
    );

    console.error(
      "[clean] Stop all running Node processes before using npm run dev:clean.",
    );

    process.exit(1);
  }
}

console.log("[clean] Next.js cache cleanup completed.");