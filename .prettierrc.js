module.exports = {
  semi: true,
  // 'all' matches the code that is actually committed: trailing commas in
  // call arguments are used throughout the backend. Prettier 3 defaults to
  // 'all' as well, so this keeps `pnpm format` from rewriting every file.
  trailingComma: 'all',
  singleQuote: true,
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  arrowParens: 'always',
  endOfLine: 'lf',
};
