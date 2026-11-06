// Lint baseline: the rules that catch real bugs in this code base (unawaited promises, promises where a value is
// expected, unused variables, accidental fallthrough). Style is left to the code's own dense one-line convention.
import tseslint from 'typescript-eslint';

export default tseslint.config(
 {ignores:['**/dist/**','**/node_modules/**','adapters/**','packages/*/test/**','packages/*/device-test/**','packages/cli/templates/**','deploy/**','scripts/**','.github/**','eslint.config.mjs']},
 {
  files:['packages/*/src/**/*.ts'],
  languageOptions:{parser:tseslint.parser,parserOptions:{projectService:true,tsconfigRootDir:import.meta.dirname}},
  plugins:{'@typescript-eslint':tseslint.plugin},
  rules:{
   '@typescript-eslint/no-floating-promises':'error',
   '@typescript-eslint/no-misused-promises':'error',
   '@typescript-eslint/await-thenable':'error',
   '@typescript-eslint/no-unused-vars':['error',{argsIgnorePattern:'^_',varsIgnorePattern:'^_',caughtErrors:'none'}],
   'no-fallthrough':'error',
   'no-unused-labels':'error',
   'no-dupe-keys':'error',
   'no-self-compare':'error'
  }
 }
);
