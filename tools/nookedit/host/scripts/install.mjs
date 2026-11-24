// Registers the native messaging host with Chrome and Edge.
//
// Chrome reads the host's location from the registry (Windows) or from a
// per-browser directory (macOS/Linux), and only trusts origins listed in the
// host manifest. This script finds the loaded NookBin extension, builds the
// host, installs it under the user profile, and writes those registrations.
//
// Usage:
//   node scripts/install.mjs                 # detect the extension, install
//   node scripts/install.mjs --id=<id>       # explicit extension id (repeatable)
//   node scripts/install.mjs --skip-build    # reuse the release binary
//   node scripts/install.mjs --browser=chrome
//   node scripts/install.mjs --uninstall
//
// Load the extension from tools/nookbin/extension/dist before running this, so
// the id can be detected. Chrome derives an unpacked extension's id from its
// path, so the registration has to name that exact id.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_NAME = 'dev.nooksuite.host';
const hostDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(hostDir, '..', '..', 'nookbin', 'extension', 'dist');

const BROWSERS = {
  chrome: {
    label: 'Chrome',
    registry: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
    darwin: 'Google/Chrome/NativeMessagingHosts',
    linux: 'google-chrome/NativeMessagingHosts',
  },
  edge: {
    label: 'Edge',
    registry: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
    darwin: 'Microsoft Edge/NativeMessagingHosts',
    linux: 'microsoft-edge/NativeMessagingHosts',
  },
};

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    ids: [],
    browsers: ['chrome', 'edge'],
    uninstall: false,
    skipBuild: false,
  };

  for (const arg of argv) {
    if (arg === '--uninstall') options.uninstall = true;
    else if (arg === '--skip-build') options.skipBuild = true;
    else if (arg.startsWith('--id=')) options.ids.push(arg.slice('--id='.length).trim());
    else if (arg.startsWith('--browser=')) {
      const requested = arg.slice('--browser='.length).split(',').map((value) => value.trim());
      for (const browser of requested) {
        if (!BROWSERS[browser]) fail(`Unknown browser "${browser}". Use chrome or edge.`);
      }
      options.browsers = requested;
    } else {
      fail(`Unknown argument "${arg}".`);
    }
  }

  return options;
}

function cargoBinary() {
  const name = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  const local = path.join(os.homedir(), '.cargo', 'bin', name);
  return fs.existsSync(local) ? local : name;
}

function hostBinaryName() {
  return process.platform === 'win32' ? 'nooksuite-host.exe' : 'nooksuite-host';
}

function installDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'NookSuite', 'host');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'NookSuite', 'host');
  }
  return path.join(
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'),
    'nooksuite',
    'host',
  );
}

function normalizePath(value) {
  return value.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
}

function detectExtensionIds() {
  const target = normalizePath(distDir);
  const roots = [];

  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? '';
    roots.push(path.join(local, 'Google', 'Chrome', 'User Data'));
    roots.push(path.join(local, 'Microsoft', 'Edge', 'User Data'));
  } else if (process.platform === 'darwin') {
    roots.push(path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome'));
    roots.push(path.join(os.homedir(), 'Library', 'Application Support', 'Microsoft Edge'));
  } else {
    roots.push(path.join(os.homedir(), '.config', 'google-chrome'));
    roots.push(path.join(os.homedir(), '.config', 'microsoft-edge'));
  }

  const ids = new Set();

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;

    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      for (const fileName of ['Preferences', 'Secure Preferences']) {
        const file = path.join(root, entry.name, fileName);
        if (!fs.existsSync(file)) continue;

        let data;
        try {
          data = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
          continue;
        }

        for (const [id, settings] of Object.entries(data.extensions?.settings ?? {})) {
          if (typeof settings?.path !== 'string') continue;

          const loaded = normalizePath(settings.path);
          if (loaded === target || loaded.startsWith(`${target}\\`)) ids.add(id);
        }
      }
    }
  }

  return [...ids];
}

function runReg(args) {
  return spawnSync('reg', args, { encoding: 'utf8', windowsHide: true });
}

function registerWindows(browsers, manifestPath) {
  for (const browser of browsers) {
    const result = runReg([
      'add',
      BROWSERS[browser].registry,
      '/ve',
      '/d',
      manifestPath,
      '/f',
    ]);

    if (result.status !== 0) {
      fail(`Could not register the host for ${BROWSERS[browser].label}:\n${result.stderr || result.stdout}`);
    }

    console.log(`  ${BROWSERS[browser].label}: HKCU\\...\\${HOST_NAME}`);
  }
}

function unregisterWindows(browsers) {
  for (const browser of browsers) {
    runReg(['delete', BROWSERS[browser].registry, '/f']);
    console.log(`  ${BROWSERS[browser].label}: removed`);
  }
}

function registerUnix(browsers, manifestPath) {
  for (const browser of browsers) {
    const base = process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'));

    const directory = path.join(base, BROWSERS[browser][process.platform === 'darwin' ? 'darwin' : 'linux']);
    fs.mkdirSync(directory, { recursive: true });
    fs.copyFileSync(manifestPath, path.join(directory, `${HOST_NAME}.json`));
    console.log(`  ${BROWSERS[browser].label}: ${path.join(directory, `${HOST_NAME}.json`)}`);
  }
}

function unregisterUnix(browsers) {
  for (const browser of browsers) {
    const base = process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'));

    const directory = path.join(base, BROWSERS[browser][process.platform === 'darwin' ? 'darwin' : 'linux']);
    fs.rmSync(path.join(directory, `${HOST_NAME}.json`), { force: true });
    console.log(`  ${BROWSERS[browser].label}: removed`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const targetDir = installDir();
  const manifestPath = path.join(targetDir, `${HOST_NAME}.json`);

  if (options.uninstall) {
    if (process.platform === 'win32') unregisterWindows(options.browsers);
    else unregisterUnix(options.browsers);

    fs.rmSync(targetDir, { recursive: true, force: true });
    console.log(`\nRemoved ${targetDir}.`);
    return;
  }

  let ids = options.ids;

  if (ids.length === 0) {
    ids = detectExtensionIds();
  }

  if (ids.length === 0) {
    fail(
      'Could not find a loaded NookBin extension.\n' +
        `Load ${distDir} in chrome://extensions (Developer mode), then run this again.\n` +
        'Or pass the id from chrome://extensions with --id=<extension id>.',
    );
  }

  for (const id of ids) {
    if (!/^[a-p]{32}$/.test(id)) {
      fail(`"${id}" does not look like a Chrome extension id.`);
    }
  }

  if (!options.skipBuild) {
    console.log('Building the host (cargo build --release)...');
    try {
      execFileSync(cargoBinary(), ['build', '--release'], {
        cwd: hostDir,
        stdio: 'inherit',
      });
    } catch {
      fail('The host build failed. Install Rust, or pass --skip-build to use an existing binary.');
    }
  }

  const source = path.join(hostDir, 'target', 'release', hostBinaryName());
  if (!fs.existsSync(source)) {
    fail(`No host binary at ${source}. Run without --skip-build first.`);
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const installed = path.join(targetDir, hostBinaryName());
  fs.copyFileSync(source, installed);

  const manifest = {
    name: HOST_NAME,
    description: 'NookSuite library host for NookBin',
    path: installed,
    type: 'stdio',
    allowed_origins: ids.map((id) => `chrome-extension://${id}/`),
  };

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`\nInstalled ${installed}`);
  console.log(`Manifest ${manifestPath}`);
  console.log(`Allowed origins: ${ids.join(', ')}`);

  if (process.platform === 'win32') registerWindows(options.browsers, manifestPath);
  else registerUnix(options.browsers, manifestPath);

  console.log('\nReopen the NookBin panel; it should report the NookSuite library.');
}

main();
