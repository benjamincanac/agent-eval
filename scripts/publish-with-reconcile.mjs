#!/usr/bin/env node
/**
 * Runs `changeset publish`, reconciling against the registry on failure.
 *
 * npm publish is not atomic: the registry can commit the version while the
 * client still receives an error (the npm CLI transparently retries the
 * publish PUT, and the retried request can be rejected, e.g. with
 * E401 "Failed to generate Web Auth URLs ... token is invalid"). When that
 * happens the release is live but `changeset publish` exits non-zero and the
 * Release workflow reports a false failure with no git tags or GitHub
 * releases created.
 *
 * On a non-zero publish exit, this script checks whether every public
 * workspace package's local version is resolvable on the registry. If so, it
 * creates the missing git tags and prints the `New tag:` lines that
 * changesets/action parses to push tags and create GitHub releases, then
 * exits 0. If any version is missing on the registry, the original failure
 * is preserved.
 *
 * `--verify-only` skips publishing and tagging; it only checks the registry.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const VERIFY_ATTEMPTS = 3;
const VERIFY_RETRY_DELAY_MS = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8' });
}

function publicPackages() {
  const pkgs = [];
  for (const dir of readdirSync('packages')) {
    let manifest;
    try {
      manifest = JSON.parse(
        readFileSync(join('packages', dir, 'package.json'), 'utf8')
      );
    } catch {
      continue;
    }
    if (!manifest.private && manifest.name && manifest.version) {
      pkgs.push({ name: manifest.name, version: manifest.version });
    }
  }
  return pkgs;
}

async function isOnRegistry({ name, version }) {
  for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await sleep(VERIFY_RETRY_DELAY_MS);
    }
    const res = run('npm', ['view', `${name}@${version}`, 'version']);
    // `npm view pkg@<missing version>` exits 0 with empty output, so the
    // exit code alone is not a liveness signal.
    if (res.status === 0 && res.stdout.trim() === version) {
      return true;
    }
  }
  return false;
}

// Tags any package whose `name@version` tag is missing from origin and
// prints the `New tag:` line changesets/action parses. Returns false if git
// state could not be determined.
function tagMissingReleases(pkgs) {
  for (const { name, version } of pkgs) {
    const tag = `${name}@${version}`;
    const remote = run('git', ['ls-remote', 'origin', `refs/tags/${tag}`]);
    if (remote.status !== 0) {
      console.error(`failed to list remote tags: ${remote.stderr}`);
      return false;
    }
    if (remote.stdout.trim() !== '') {
      continue;
    }
    const local = run('git', ['tag', '--list', tag]);
    if (local.stdout.trim() === '') {
      const created = run('git', ['tag', tag]);
      if (created.status !== 0) {
        console.error(`failed to create tag ${tag}: ${created.stderr}`);
        return false;
      }
    }
    console.log('New tag: ', tag);
  }
  return true;
}

async function main() {
  const verifyOnly = process.argv.includes('--verify-only');
  let publishStatus = 0;

  if (!verifyOnly) {
    const publish = spawnSync('npx', ['changeset', 'publish'], {
      stdio: 'inherit',
    });
    publishStatus = publish.status ?? 1;
    if (publishStatus === 0) {
      return 0;
    }
    console.error(
      `changeset publish exited with ${publishStatus}; checking whether the release landed on the registry anyway`
    );
  }

  const pkgs = publicPackages();
  for (const pkg of pkgs) {
    if (await isOnRegistry(pkg)) {
      console.log(`${pkg.name}@${pkg.version} is live on the registry`);
    } else {
      console.error(`${pkg.name}@${pkg.version} is NOT on the registry`);
      return verifyOnly ? 1 : publishStatus;
    }
  }

  if (verifyOnly) {
    return 0;
  }

  if (!tagMissingReleases(pkgs)) {
    return publishStatus;
  }
  console.log(
    'all packages are live on the registry; treating the publish as successful'
  );
  return 0;
}

process.exit(await main());
