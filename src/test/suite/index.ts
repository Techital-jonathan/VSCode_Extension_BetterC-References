import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { RefsTreeApi } from '../../extension';
import type { Access, ReferenceSearch } from '../../search';
import type { Node } from '../../tree';

const ACCESS_BY_MARKER: Record<string, Access> = { D: 'definition', W: 'write', R: 'read' };
const SERVER_TIMEOUT_MS = 180_000;

/** Entry point called by VS Code's test host (see runTest.ts). */
export async function run(): Promise<void> {
  const fixture = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(fixture, 'The sample project must be opened as the workspace');

  const csharp = vscode.extensions.getExtension('ms-dotnettools.csharp');
  assert.ok(csharp, 'The C# extension (ms-dotnettools.csharp) must be installed');
  await csharp.activate();

  const ours = vscode.extensions.getExtension<RefsTreeApi>('techital.better-csharp-references');
  assert.ok(ours, 'Extension under test not found');
  const api = await ours.activate();

  const failures: string[] = [];
  for (const symbol of ['_count', 'Total', '_name', 'InStock', 'Enabled']) {
    try {
      await checkSymbol(api, fixture, symbol);
    } catch (error) {
      failures.push(`${symbol}: ${error instanceof Error ? error.message : error}`);
    }
  }
  try {
    await checkCancellation(api, fixture);
  } catch (error) {
    failures.push(`cancellation: ${error instanceof Error ? error.message : error}`);
  }
  try {
    await checkTreeShape(api, fixture);
  } catch (error) {
    failures.push(`tree: ${error instanceof Error ? error.message : error}`);
  }

  if (failures.length > 0) {
    throw new Error(`\n${failures.join('\n')}`);
  }
  console.log('\nAll checks passed.');
}

async function checkSymbol(api: RefsTreeApi, fixture: vscode.Uri, symbol: string): Promise<void> {
  const expected = await readExpectations(fixture, symbol);
  const definition = [...expected.values()].find((e) => e.access === 'definition');
  assert.ok(definition, `No "D" marker for ${symbol} in the fixture`);

  const search = await waitForReferences(api, definition.uri, definition.position, expected.size);
  console.log(`\n${symbol}: ${search.references.length} references`);

  const mismatches: string[] = [];
  const seen = new Set<string>();
  for (const ref of search.references) {
    const key = keyOf(ref.location.uri, ref.location.range.start);
    seen.add(key);
    const want = expected.get(key)?.access;
    const where = `${vscode.workspace.asRelativePath(ref.location.uri)}:${ref.location.range.start.line + 1}`;
    console.log(`  ${(ref.access + (ref.heuristic ? '*' : '')).padEnd(11)} ${where.padEnd(24)} ${ref.preview}`);
    if (want === undefined) {
      mismatches.push(`unexpected reference at ${where}`);
    } else if (want !== ref.access) {
      mismatches.push(`${where}: expected ${want}, got ${ref.access}${ref.heuristic ? ' (guessed)' : ''}`);
    }
  }
  for (const [key, e] of expected) {
    if (!seen.has(key)) {
      mismatches.push(`missing reference at ${vscode.workspace.asRelativePath(e.uri)}:${e.position.line + 1}`);
    }
  }
  const guessed = search.references.filter((r) => r.heuristic).length;
  if (guessed > 0) {
    console.log(`  (* = ${guessed} guessed from text because the language server returned no highlight)`);
  }
  assert.deepStrictEqual(mismatches, [], mismatches.join('\n'));
}

/** A second search cancels the first: the first settles straight away and only the second is shown. */
async function checkCancellation(api: RefsTreeApi, fixture: vscode.Uri): Promise<void> {
  const count = [...(await readExpectations(fixture, '_count')).values()].find((e) => e.access === 'definition')!;
  const total = [...(await readExpectations(fixture, 'Total')).values()].find((e) => e.access === 'definition')!;

  const settled: string[] = [];
  const first = api.runSearch(count.uri, count.position).then((r) => (settled.push('first'), r));
  const second = api.runSearch(total.uri, total.position).then((r) => (settled.push('second'), r));
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.strictEqual(firstResult, undefined, 'The first search should be dropped');
  assert.strictEqual(secondResult?.symbol, 'Total');
  assert.strictEqual(api.provider.current?.symbol, 'Total', 'The view should show the second search');
  assert.deepStrictEqual(settled, ['first', 'second'], 'The first search should stop before the second finishes');

  const source = new vscode.CancellationTokenSource();
  const pending = api.findReferences(count.uri, count.position, source.token);
  source.cancel();
  await assert.rejects(pending, (e) => e instanceof vscode.CancellationError);
  console.log('\nCancellation: first search dropped, second shown.');
}

async function checkTreeShape(api: RefsTreeApi, fixture: vscode.Uri): Promise<void> {
  const expected = await readExpectations(fixture, 'Total');
  const definition = [...expected.values()].find((e) => e.access === 'definition')!;
  await api.runSearch(definition.uri, definition.position);

  api.provider.setOptions({ viewMode: 'tree', groupByAccess: true, compactFolders: true });
  const grouped = api.provider.getRoots();
  assert.deepStrictEqual(
    grouped.map((n) => (n.kind === 'group' ? n.access : n.kind)),
    ['definition', 'write', 'read'],
  );
  const writeTree = describe(api, grouped[1]);
  console.log(`\nTree, grouped, "Write" group:\n${writeTree}`);
  assert.match(writeTree, /^ {2}folder Sub\/Deep \(1\)$/m, 'Sub/Deep should be one compacted folder');
  assert.match(writeTree, /^ {4}file Usage\.cs \(1\)$/m);

  api.provider.setOptions({ viewMode: 'list', groupByAccess: false });
  const flat = api.provider.getRoots();
  assert.ok(flat.every((n) => n.kind === 'file'), 'List mode should only have files at the top');
  console.log(`\nList, ungrouped:\n${flat.map((n) => describe(api, n, 0, false)).join('')}`);

  api.provider.setOptions({ viewMode: 'tree', groupByAccess: true });
}

function describe(api: RefsTreeApi, node: Node, depth = 0, recurse = true): string {
  const name =
    node.kind === 'group' ? node.access : node.kind === 'folder' ? node.name : node.kind === 'file' ? path.basename(node.uri.path) : node.ref.preview;
  const count = node.kind === 'ref' ? '' : ` (${node.refs.length})`;
  let text = `${'  '.repeat(depth)}${node.kind} ${name}${count}\n`;
  if (recurse) {
    for (const child of api.provider.getChildren(node)) {
      text += describe(api, child, depth + 1);
    }
  }
  return text;
}

/** Roslyn needs a while to load the project; retry until all expected references show up. */
async function waitForReferences(
  api: RefsTreeApi,
  uri: vscode.Uri,
  position: vscode.Position,
  count: number,
): Promise<ReferenceSearch> {
  const deadline = Date.now() + SERVER_TIMEOUT_MS;
  for (;;) {
    const search = await api.findReferences(uri, position);
    if (search.references.length >= count || Date.now() > deadline) {
      return search;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

interface Expectation {
  uri: vscode.Uri;
  position: vscode.Position;
  access: Access;
}

/** Reads `// Symbol: W R | Other: D` markers (`-` = same name, different symbol) from the fixture's .cs files. */
async function readExpectations(fixture: vscode.Uri, symbol: string): Promise<Map<string, Expectation>> {
  const result = new Map<string, Expectation>();
  const files = await vscode.workspace.findFiles(new vscode.RelativePattern(fixture, '**/*.cs'), '**/{bin,obj}/**');
  for (const uri of files) {
    const lines = (await vscode.workspace.openTextDocument(uri)).getText().split(/\r?\n/);
    lines.forEach((text, line) => {
      const commentAt = text.indexOf('//');
      if (commentAt < 0) {
        return;
      }
      const code = text.slice(0, commentAt);
      for (const part of text.slice(commentAt + 2).split('|')) {
        const match = /^\s*(\w+):\s*([DWR\- ]+?)\s*$/.exec(part);
        if (!match || match[1] !== symbol) {
          continue;
        }
        const markers = match[2].split(/\s+/);
        const columns = [...code.matchAll(new RegExp(`\\b${symbol}\\b`, 'g'))].map((m) => m.index!);
        assert.strictEqual(columns.length, markers.length, `Marker count mismatch on ${uri.path}:${line + 1}`);
        columns.forEach((character, i) => {
          if (markers[i] === '-') {
            return;
          }
          const position = new vscode.Position(line, character);
          result.set(keyOf(uri, position), { uri, position, access: ACCESS_BY_MARKER[markers[i]] });
        });
      }
    });
  }
  return result;
}

function keyOf(uri: vscode.Uri, position: vscode.Position): string {
  return `${uri.fsPath}:${position.line}:${position.character}`;
}
