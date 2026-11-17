import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { experimental_scanPublicSdkOnly } from '@get-bb/plugin-sdk/testing';

test('production code and tests use only the public SDK and declared libraries', () => {
  const result = experimental_scanPublicSdkOnly(fileURLToPath(new URL('../', import.meta.url)), {
    allow: [/^react(?:-dom)?(?:\/.*)?$/, /^yaml$/, /^jsdom$/, /^@testing-library\/react$/, /^@radix-ui\//, /^class-variance-authority$/, /^clsx$/, /^tailwind-merge$/, /^sonner$/, /^@\//],
  });
  // The scanner walks the whole checkout; agent tooling (AI Factory skills in .claude/, .ai-factory/) is not plugin code.
  assert.deepEqual(result.violations.filter((v) => !/^\.(claude|ai-factory)\//.test(v.file)), []);
  assert.deepEqual(result.privateDependencies, []);
});
