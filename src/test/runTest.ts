import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/**
 * Runs the integration tests in a real VS Code window against the sample C# project.
 *
 * VS Code itself is downloaded into .vscode-test (override with VSCODE_EXECUTABLE), but the C#
 * extension is not: the test instance reuses your installed extensions (override with
 * VSCODE_EXTENSIONS_DIR). Every other installed extension is disabled for the run. User settings
 * are isolated in .vscode-test/user-data.
 */
async function main(): Promise<void> {
  const root = path.resolve(__dirname, '../..');
  const extensionsDir = process.env.VSCODE_EXTENSIONS_DIR ?? path.join(os.homedir(), '.vscode', 'extensions');
  const disable = fs
    .readdirSync(extensionsDir)
    .map((dir) => /^(.+?)-\d+\.\d+/.exec(dir)?.[1])
    .filter((id): id is string => !!id && !id.startsWith('ms-dotnettools.'))
    .map((id) => `--disable-extension=${id}`);

  await runTests({
    vscodeExecutablePath: process.env.VSCODE_EXECUTABLE,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(__dirname, 'suite', 'index'),
    launchArgs: [path.join(root, 'test-fixtures', 'Sample'), `--extensions-dir=${extensionsDir}`, ...disable],
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
