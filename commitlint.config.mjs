/**
 * Conventional Commits, matching the history this repo already writes
 * (`feat(gateway):`, `fix(cover-wallet):`, `docs(api-contracts):`).
 *
 * Enforced locally by `.husky/commit-msg` and again in CI on the pull-request
 * title, because a squash merge takes its message from the title, not from the
 * commits.
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // `recover` is in this repo's history (the 2026-08-28 restore) and is a
    // meaningful category here; the rest is the conventional set.
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'perf',
        'refactor',
        'revert',
        'recover',
        'docs',
        'test',
        'build',
        'ci',
        'chore',
      ],
    ],
    'scope-case': [2, 'always', 'kebab-case'],
    'subject-case': [2, 'never', ['upper-case', 'pascal-case', 'start-case']],
    'header-max-length': [2, 'always', 100],
    'body-max-line-length': [0],
  },
};
