/**
 * Isolation rail — enforced from the first commit, before any module exists to break it.
 *
 *  - A file under src/usecases/<module>/ may import ONLY src/platform/* or its own folder.
 *    Never a sibling module, never a shared THROWAWAY helper (src/synthdata, etc.).
 *  - Nothing under src/platform/* may import src/usecases/* — EXCEPT the composition root
 *    (registry.ts / workflows.bundle.ts), the two files whitelisted to wire modules in.
 *
 * Passes vacuously today (no usecases/* yet); it fires on a co-worker's first bad commit.
 */
module.exports = {
  forbidden: [
    {
      name: "usecase-imports-platform-or-own-only",
      severity: "error",
      comment:
        "A usecases/<module> file may import only platform/* or its own folder — never a sibling or a shared helper.",
      from: { path: "^src/usecases/([^/]+)/" },
      to: {
        path: "^src/",
        pathNot: ["^src/platform/", "^src/usecases/$1/"],
      },
    },
    {
      name: "platform-no-usecase-import-except-root",
      severity: "error",
      comment:
        "Only the composition root (registry.ts / workflows.bundle.ts) may import usecases/* from platform.",
      from: {
        path: "^src/platform/",
        pathNot: "^src/platform/(registry|workflows\\.bundle)\\.ts$",
      },
      to: { path: "^src/usecases/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
    },
  },
};
