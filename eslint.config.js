// The ONE flat config in this repository. ESLint 10 resolves config by walking
// up from each linted file, so an eslint.config.* dropped inside a package would
// silently detach these rules with no error — scripts/no-platform-vocab.sh
// asserts that this file is the only one.
export { default } from '@ghalla/eslint-config';
