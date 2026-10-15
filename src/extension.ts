import * as vscode from 'vscode';
import { findReferences, Reference, ReferenceSearch } from './search';
import { Node, ReferencesTreeProvider, TreeOptions, ViewMode } from './tree';

const VIEW_ID = 'refsTree.results';
const STATE_VIEW_MODE = 'refsTree.viewMode';
const STATE_GROUP_BY_ACCESS = 'refsTree.groupByAccess';

/** Returned from `activate` so the integration tests can drive the extension. */
export interface RefsTreeApi {
  findReferences: typeof findReferences;
  provider: ReferencesTreeProvider;
  runSearch(uri: vscode.Uri, position: vscode.Position): Promise<ReferenceSearch | undefined>;
}

export function activate(context: vscode.ExtensionContext): RefsTreeApi {
  const config = () => vscode.workspace.getConfiguration('refsTree');
  const options: TreeOptions = {
    viewMode: context.globalState.get<ViewMode>(STATE_VIEW_MODE) ?? config().get<ViewMode>('defaultViewMode', 'tree'),
    groupByAccess: context.globalState.get<boolean>(STATE_GROUP_BY_ACCESS) ?? config().get('defaultGroupByAccess', true),
    compactFolders: config().get('compactFolders', true),
    autoExpandLimit: config().get('autoExpandLimit', 250),
  };

  const provider = new ReferencesTreeProvider(options);
  const treeView = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider, showCollapseAll: true });
  context.subscriptions.push(treeView);

  const setContext = (key: string, value: unknown) => vscode.commands.executeCommand('setContext', key, value);
  setContext('refsTree.viewMode', options.viewMode);
  setContext('refsTree.groupByAccess', options.groupByAccess);
  setContext('refsTree.hasResults', false);

  const updateHeader = () => {
    const search = provider.current;
    setContext('refsTree.hasResults', !!search);
    if (!search) {
      treeView.description = undefined;
      treeView.message = 'Put the cursor on a C# symbol and press Shift+Alt+F12 (or right-click → Find All References (Tree)).';
      return;
    }
    const refs = search.references;
    const files = new Set(refs.map((r) => r.location.uri.toString())).size;
    const count = (access: Reference['access']) => refs.filter((r) => r.access === access).length;
    treeView.description = `${search.symbol} · ${refs.length} in ${files} file${files === 1 ? '' : 's'}`;
    treeView.message =
      refs.length === 0
        ? `No references found for '${search.symbol}'.`
        : `${count('write')} write · ${count('read')} read · ${count('definition')} definition`;
  };
  updateHeader();
  context.subscriptions.push(provider.onDidChangeTreeData(updateHeader));

  let searchId = 0;
  let cancellation: vscode.CancellationTokenSource | undefined;

  /** Drops the running search, if any: its result is ignored and it stops sending requests. */
  const cancelSearch = () => {
    searchId++;
    cancellation?.cancel();
    cancellation = undefined;
  };

  const runSearch = async (uri: vscode.Uri, position: vscode.Position) => {
    cancelSearch();
    const id = searchId;
    cancellation = new vscode.CancellationTokenSource();
    const token = cancellation.token;

    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    if (id !== searchId) {
      return undefined;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    const wordRange = document.getWordRangeAtPosition(position);
    treeView.message = wordRange ? `Searching for references to '${document.getText(wordRange)}'…` : 'Searching…';
    try {
      const search = await vscode.window.withProgress({ location: { viewId: VIEW_ID } }, () =>
        findReferences(uri, position, token, {
          namedArgumentsAsWrite: config().get('namedArgumentsAsWrite', true),
        }),
      );
      if (id !== searchId) {
        return undefined;
      }
      provider.setSearch(search);
      return search;
    } catch (error) {
      if (id === searchId && !(error instanceof vscode.CancellationError)) {
        updateHeader();
        vscode.window.showErrorMessage(`Find references failed: ${error instanceof Error ? error.message : error}`);
      }
      return undefined;
    }
  };

  const setViewMode = (viewMode: ViewMode) => {
    context.globalState.update(STATE_VIEW_MODE, viewMode);
    setContext('refsTree.viewMode', viewMode);
    provider.setOptions({ viewMode });
  };

  const setGroupByAccess = (groupByAccess: boolean) => {
    context.globalState.update(STATE_GROUP_BY_ACCESS, groupByAccess);
    setContext('refsTree.groupByAccess', groupByAccess);
    provider.setOptions({ groupByAccess });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('refsTree.find', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        await runSearch(editor.document.uri, editor.selection.active);
      }
    }),
    vscode.commands.registerCommand('refsTree.refresh', async () => {
      const origin = provider.current?.origin;
      if (origin) {
        await runSearch(origin.uri, origin.range.start);
      }
    }),
    vscode.commands.registerCommand('refsTree.clear', () => {
      cancelSearch();
      provider.setSearch(undefined);
    }),
    vscode.commands.registerCommand('refsTree.showAsTree', () => setViewMode('tree')),
    vscode.commands.registerCommand('refsTree.showAsList', () => setViewMode('list')),
    vscode.commands.registerCommand('refsTree.groupByAccess', () => setGroupByAccess(true)),
    vscode.commands.registerCommand('refsTree.ungroupByAccess', () => setGroupByAccess(false)),
    vscode.commands.registerCommand('refsTree.expandAll', () => provider.expandEverything()),
    vscode.commands.registerCommand('refsTree.remove', (node: Node) => node && provider.remove(node)),
    vscode.commands.registerCommand('refsTree.copyPath', (node: Node) => {
      if (!node || node.kind === 'group') {
        return;
      }
      const uri = node.kind === 'ref' ? node.ref.location.uri : node.uri;
      const text = uri.scheme === 'file' ? uri.fsPath : uri.toString();
      const suffix = node.kind === 'ref' ? `:${node.ref.location.range.start.line + 1}` : '';
      return vscode.env.clipboard.writeText(text + suffix);
    }),
    vscode.commands.registerCommand('refsTree.open', (ref: Reference) =>
      vscode.window.showTextDocument(ref.location.uri, {
        selection: ref.location.range,
        preserveFocus: true,
        preview: true,
      }),
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('refsTree.compactFolders') || e.affectsConfiguration('refsTree.autoExpandLimit')) {
        provider.setOptions({
          compactFolders: config().get('compactFolders', true),
          autoExpandLimit: config().get('autoExpandLimit', 250),
        });
      }
    }),
  );

  context.subscriptions.push({ dispose: cancelSearch });

  return { findReferences, provider, runSearch };
}

export function deactivate(): void {}
