import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  // Downloaded, hash-verified Chrome artifacts have their own integrity gate.
  globalIgnores(['.cache/security-chrome/**', '.next/**', 'apps/playground/.next/**', 'out/**', 'build/**', 'next-env.d.ts', 'apps/playground/next-env.d.ts']),
]);
