import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

// `next lint` linted a fixed set of source directories. The ESLint CLI walks the whole tree and
// reads neither .gitignore nor .git/info/exclude, so anything not source has to be named here —
// including .claude/worktrees, which holds a checkout of another branch and would otherwise be
// linted as if it were this one.
const config = [
  // `desktop/build` is the assembled payload and `desktop/dist` the installer: compiled output,
  // linted as if it were ours because the CLI reads neither .gitignore nor git's exclude file.
  {
    ignores: [
      '.next/**',
      'out/**',
      'coverage/**',
      '.claude/**',
      'desktop/build/**',
      'desktop/dist/**',
    ],
  },
  ...nextCoreWebVitals,
  {
    rules: {
      // Both arrived with eslint-plugin-react-hooks 7, which eslint-config-next 16 pulls in; the
      // version before it had neither. They fire 25 times, every one on a shape that is deliberate
      // and carries a comment saying why: the portal mount guard, the render-time derivation that
      // keeps the week-slide animation to one render, and the `live.current = options` that stops
      // the drag listeners capturing a stale week. Whether to restructure those is a real question
      // and not one a dependency bump gets to answer.
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
    },
  },
];

export default config;
