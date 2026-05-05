import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import {
  discoverFixtures,
  validateFixtureFiles,
  validatePackageJson,
  loadFixture,
  loadAllFixtures,
  getFixtureFiles,
  readFixtureFiles,
} from './fixture.js';

const TEST_DIR = '/tmp/eval-framework-test-fixtures';

function createTestFixture(name: string, files: Record<string, string>) {
  const fixturePath = join(TEST_DIR, name);
  mkdirSync(fixturePath, { recursive: true });

  for (const [filename, content] of Object.entries(files)) {
    const filePath = join(fixturePath, filename);
    const dir = join(filePath, '..');
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, content);
  }

  return fixturePath;
}

describe('fixture discovery and validation', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe('discoverFixtures', () => {
    it('discovers and sorts fixture directories', () => {
      createTestFixture('z-eval', { 'PROMPT.md': '# Test', 'README.md': '# Test' });
      createTestFixture('a-eval', { 'PROMPT.md': '# Test', 'README.md': '# Test' });
      createTestFixture('.hidden', { 'PROMPT.md': '# Test', 'README.md': '# Test' });

      const fixtures = discoverFixtures(TEST_DIR);
      expect(fixtures).toEqual(['a-eval', 'z-eval']);
    });

    it('discovers nested fixture directories', () => {
      createTestFixture('vercel-cli/deploy', { 'PROMPT.md': '# Deploy test' });
      createTestFixture('vercel-cli/link', { 'PROMPT.md': '# Link test' });
      createTestFixture('flags/create', { 'PROMPT.md': '# Create flag test' });
      createTestFixture('simple', { 'PROMPT.md': '# Simple test' });

      const fixtures = discoverFixtures(TEST_DIR);
      expect(fixtures).toEqual(['flags/create', 'simple', 'vercel-cli/deploy', 'vercel-cli/link']);
    });

    it('throws if directory does not exist', () => {
      expect(() => discoverFixtures('/non/existent/path')).toThrow('Evals directory not found');
    });
  });

  describe('validateFixtureFiles', () => {
    it('returns missing files', () => {
      const path = createTestFixture('incomplete', {
        'PROMPT.md': '# Task',
      });

      const missing = validateFixtureFiles(path);
      expect(missing).toContain('EVAL.ts or EVAL.tsx');
      expect(missing).toContain('package.json');
      expect(missing).not.toContain('PROMPT.md');
    });

    it('does not require EVAL.ts for response-only fixtures', () => {
      const path = createTestFixture('response-only', {
        'PROMPT.md': '# Task',
        'package.json': JSON.stringify({ type: 'module' }),
      });

      const missing = validateFixtureFiles(path, { validation: 'none' });
      expect(missing).not.toContain('EVAL.ts or EVAL.tsx');
      expect(missing).toEqual([]);
    });

    it('enforces case-sensitive filenames', () => {
      const path = createTestFixture('wrong-case', {
        'prompt.md': '# Task', // Wrong case
        'eval.ts': 'test',     // Wrong case
        'package.json': JSON.stringify({ type: 'module' }),
      });

      const missing = validateFixtureFiles(path);
      expect(missing).toContain('PROMPT.md'); // Should fail even on Mac
      expect(missing).toContain('EVAL.ts or EVAL.tsx'); // Should fail even on Mac
    });
  });

  describe('validatePackageJson', () => {
    it('validates module type', () => {
      const path = createTestFixture('module', {
        'package.json': JSON.stringify({ name: 'test', type: 'module' }),
      });

      const result = validatePackageJson(path);
      expect(result.isModule).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('rejects non-module package', () => {
      const path = createTestFixture('commonjs', {
        'package.json': JSON.stringify({ name: 'test' }),
      });

      const result = validatePackageJson(path);
      expect(result.isModule).toBe(false);
      expect(result.error).toContain('type');
    });
  });

  describe('loadFixture', () => {
    it('loads valid fixture', () => {
      createTestFixture('my-eval', {
        'PROMPT.md': 'Add a button',
        'EVAL.ts': 'test("button exists", () => {});',
        'package.json': JSON.stringify({ name: 'my-eval', type: 'module' }),
      });

      const fixture = loadFixture(TEST_DIR, 'my-eval');

      expect(fixture.name).toBe('my-eval');
      expect(fixture.prompt).toBe('Add a button');
      expect(fixture.isModule).toBe(true);
    });

    it('loads response-only fixture without eval file', () => {
      createTestFixture('response-only', {
        'PROMPT.md': 'Recommend a deployment platform',
        'package.json': JSON.stringify({ name: 'response-only', type: 'module' }),
      });

      const fixture = loadFixture(TEST_DIR, 'response-only', { validation: 'none' });

      expect(fixture.name).toBe('response-only');
      expect(fixture.prompt).toBe('Recommend a deployment platform');
      expect(fixture.isModule).toBe(true);
    });

    it('throws for missing required files', () => {
      createTestFixture('incomplete', {
        'PROMPT.md': 'Task',
      });

      expect(() => loadFixture(TEST_DIR, 'incomplete')).toThrow('Missing required files');
    });
  });

  describe('loadAllFixtures', () => {
    it('loads all valid fixtures and collects errors', () => {
      createTestFixture('valid', {
        'PROMPT.md': 'Task',
        'EVAL.ts': 'test',
        'package.json': JSON.stringify({ type: 'module' }),
      });
      createTestFixture('invalid', {
        'PROMPT.md': 'Task',
        // Missing EVAL.ts and package.json
      });

      const { fixtures, errors } = loadAllFixtures(TEST_DIR);

      expect(fixtures).toHaveLength(1);
      expect(fixtures[0].name).toBe('valid');
      expect(errors).toHaveLength(1);
      expect(errors[0].fixtureName).toBe('invalid');
    });

    it('loads response-only fixtures and collects errors using validation none', () => {
      createTestFixture('valid', {
        'PROMPT.md': 'Task',
        'package.json': JSON.stringify({ type: 'module' }),
      });
      createTestFixture('invalid', {
        'PROMPT.md': 'Task',
      });

      const { fixtures, errors } = loadAllFixtures(TEST_DIR, { validation: 'none' });

      expect(fixtures).toHaveLength(1);
      expect(fixtures[0].name).toBe('valid');
      expect(errors).toHaveLength(1);
      expect(errors[0].fixtureName).toBe('invalid');
    });
  });

  describe('getFixtureFiles', () => {
    it('lists all files excluding defaults and node_modules', () => {
      createTestFixture('full', {
        'PROMPT.md': 'Task',
        'EVAL.ts': 'test',
        'package.json': '{}',
        'src/App.tsx': 'app code',
        'node_modules/pkg/index.js': 'module code',
      });

      const path = join(TEST_DIR, 'full');
      const files = getFixtureFiles(path);

      expect(files).toContain('src/App.tsx');
      expect(files).toContain('package.json');
      expect(files).not.toContain('PROMPT.md');
      expect(files).not.toContain('EVAL.ts');
      expect(files).not.toContain('node_modules/pkg/index.js');
    });
  });

  describe('readFixtureFiles', () => {
    it('reads file contents into map excluding PROMPT and EVAL', () => {
      createTestFixture('readable', {
        'PROMPT.md': 'Task',
        'EVAL.ts': 'test',
        'package.json': '{"name":"test"}',
        'src/index.ts': 'export const x = 1;',
      });

      const path = join(TEST_DIR, 'readable');
      const contents = readFixtureFiles(path);

      expect(contents.get('package.json')).toBe('{"name":"test"}');
      expect(contents.get('src/index.ts')).toBe('export const x = 1;');
      expect(contents.has('PROMPT.md')).toBe(false);
      expect(contents.has('EVAL.ts')).toBe(false);
    });
  });
});
