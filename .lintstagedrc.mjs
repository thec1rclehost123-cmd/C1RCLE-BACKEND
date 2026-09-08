/**
 * Staged-file checks. Deliberately narrow: anything whole-project (typecheck,
 * boundaries, tests) belongs in `.husky/pre-push`, not here — a pre-commit hook
 * that takes 40 seconds is a pre-commit hook people bypass.
 */
export default {
  // `--ignore-unknown` so a staged file Prettier does not handle (or that
  // .prettierignore excludes, e.g. *.md) is skipped rather than failing.
  '*': ['prettier --write --ignore-unknown'],
  '*.ts': ['eslint --fix --max-warnings=0'],
};
