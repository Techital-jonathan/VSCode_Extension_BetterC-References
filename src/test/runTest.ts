import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';

const CSHARP_EXTENSION = 'ms-dotnettools.csharp';

/**
 * Runs the integration tests in a real VS Code window against the sample C# project.
 *
 * - VS Code is downloaded into .vscode-test (override with VSCODE_EXECUTABLE).
 * - Extensions come from ~/.vscode/extensions (override with VSCODE_EXTENSIONS_DIR, as CI does).
 *   The C# extension is installed there first if it is missing; every other extension in the
 *   folder is disabled for the run.
 * - User settings are isolated in .vscode-test/user-data.
 */
async function main(): Promise<void> {
  const root = path.resolve(__dirname, '../..');
  const extensionsDir = path.resolve(
    process.env.VSCODE_EXTENSIONS_DIR ?? path.join(os.homedir(), '.vscode', 'extensions'),
  );
  const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE ?? (await downloadAndUnzipVSCode('stable'));

  if (!installedExtensionIds(extensionsDir).includes(CSHARP_EXTENSION)) {
    installExtension(vscodeExecutablePath, extensionsDir, CSHARP_EXTENSION);
  }

  const disable = installedExtensionIds(extensionsDir)
    .filter((id) => !id.startsWith('ms-dotnettools.'))
    .map((id) => `--disable-extension=${id}`);

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(__dirname, 'suite', 'index'),
    launchArgs: [path.join(root, 'test-fixtures', 'Sample'), `--extensions-dir=${extensionsDir}`, ...disable],
  });
}

function installedExtensionIds(extensionsDir: string): string[] {
  if (!fs.existsSync(extensionsDir)) {
    return [];
  }
  return fs
    .readdirSync(extensionsDir)
    .map((dir) => /^(.+?)-\d+\.\d+/.exec(dir)?.[1]?.toLowerCase())
    .filter((id): id is string => !!id);
}

function installExtension(vscodeExecutablePath: string, extensionsDir: string, id: string): void {
  console.log(`Installing ${id} into ${extensionsDir}…`);
  const [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath, { reuseMachineInstall: true });
  const result = cp.spawnSync(cli, [...args, `--extensions-dir=${extensionsDir}`, '--install-extension', id], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(`Installing ${id} failed with exit code ${result.status}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
