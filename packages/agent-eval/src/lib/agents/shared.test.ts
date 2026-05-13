import { describe, expect, it, vi } from 'vitest';
import { prepareNeutralWorkspace } from './shared.js';

describe('prepareNeutralWorkspace', () => {
  it('copies Vercel sandboxes into /workspace and switches the working directory', async () => {
    const sandbox = {
      getWorkingDirectory: vi.fn(() => '/vercel/sandbox'),
      setWorkingDirectory: vi.fn(),
      runShell: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    };

    const result = await prepareNeutralWorkspace(sandbox as never);

    expect(sandbox.runShell).toHaveBeenCalledWith('git remote remove origin 2>/dev/null || true; rm -rf .git/logs');
    expect(sandbox.runShell).toHaveBeenCalledWith(expect.stringContaining('sudo cp -a . /workspace/'));
    expect(sandbox.setWorkingDirectory).toHaveBeenCalledWith('/workspace');
    expect(result).toEqual({
      cwd: '/workspace',
      env: { USER: 'user', LOGNAME: 'user' },
    });
  });

  it('keeps non-Vercel sandbox working directories in place', async () => {
    const sandbox = {
      getWorkingDirectory: vi.fn(() => '/home/sandbox/workspace'),
      setWorkingDirectory: vi.fn(),
      runShell: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    };

    const result = await prepareNeutralWorkspace(sandbox as never);

    expect(sandbox.runShell).toHaveBeenCalledTimes(1);
    expect(sandbox.setWorkingDirectory).not.toHaveBeenCalled();
    expect(result).toEqual({
      cwd: '/home/sandbox/workspace',
      env: { USER: 'user', LOGNAME: 'user' },
    });
  });
});
