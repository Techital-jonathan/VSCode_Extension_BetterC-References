import * as path from 'path';
import * as vscode from 'vscode';
import { Access, Reference, ReferenceSearch } from './search';

export type ViewMode = 'tree' | 'list';

export interface TreeOptions {
  viewMode: ViewMode;
  groupByAccess: boolean;
  compactFolders: boolean;
  autoExpandLimit: number;
}

interface NodeBase {
  id: string;
  parent?: ContainerNode;
}

export interface GroupNode extends NodeBase {
  kind: 'group';
  access: Access;
  children: Node[];
  refs: Reference[];
}

export interface FolderNode extends NodeBase {
  kind: 'folder';
  name: string;
  uri: vscode.Uri;
  children: Node[];
  refs: Reference[];
}

export interface FileNode extends NodeBase {
  kind: 'file';
  uri: vscode.Uri;
  /** Folder path shown next to the file name in list mode. */
  dir: string;
  children: RefNode[];
  refs: Reference[];
}

export interface RefNode extends NodeBase {
  kind: 'ref';
  ref: Reference;
}

export type ContainerNode = GroupNode | FolderNode | FileNode;
export type Node = ContainerNode | RefNode;

const ACCESS_ORDER: Access[] = ['definition', 'write', 'read'];

const ACCESS_LABEL: Record<Access, string> = {
  definition: 'Definition',
  write: 'Write',
  read: 'Read',
};

const ACCESS_ICON: Record<Access, vscode.ThemeIcon> = {
  definition: new vscode.ThemeIcon('symbol-class', new vscode.ThemeColor('charts.purple')),
  write: new vscode.ThemeIcon('edit', new vscode.ThemeColor('charts.orange')),
  read: new vscode.ThemeIcon('eye', new vscode.ThemeColor('charts.blue')),
};

export class ReferencesTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  private search: ReferenceSearch | undefined;
  private roots: Node[] = [];
  /** Bumped by "Expand All" so VS Code forgets remembered collapse state (it is keyed by id). */
  private generation = 0;
  private expandAll = false;

  constructor(private options: TreeOptions) {}

  get current(): ReferenceSearch | undefined {
    return this.search;
  }

  setSearch(search: ReferenceSearch | undefined): void {
    this.search = search;
    this.expandAll = false;
    this.rebuild();
  }

  setOptions(options: Partial<TreeOptions>): void {
    this.options = { ...this.options, ...options };
    this.rebuild();
  }

  expandEverything(): void {
    this.generation++;
    this.expandAll = true;
    this.rebuild();
  }

  /** Dismisses a reference, or every reference under a group/folder/file. */
  remove(node: Node): void {
    if (!this.search) {
      return;
    }
    const removed = new Set(node.kind === 'ref' ? [node.ref] : node.refs);
    this.search = { ...this.search, references: this.search.references.filter((r) => !removed.has(r)) };
    this.rebuild();
  }

  getRoots(): Node[] {
    return this.roots;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.roots;
    }
    return node.kind === 'ref' ? [] : node.children;
  }

  getParent(node: Node): Node | undefined {
    return node.parent;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'group': {
        const item = new vscode.TreeItem(ACCESS_LABEL[node.access], vscode.TreeItemCollapsibleState.Expanded);
        item.id = node.id;
        item.description = `${node.refs.length}`;
        item.iconPath = ACCESS_ICON[node.access];
        item.contextValue = 'group';
        return item;
      }
      case 'folder': {
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Expanded);
        item.id = node.id;
        item.resourceUri = node.uri;
        item.iconPath = vscode.ThemeIcon.Folder;
        item.description = `${node.refs.length}`;
        item.tooltip = node.uri.scheme === 'file' ? node.uri.fsPath : node.uri.toString();
        item.contextValue = 'folder';
        return item;
      }
      case 'file': {
        const item = new vscode.TreeItem(node.uri, this.fileCollapsedState());
        item.id = node.id;
        item.iconPath = vscode.ThemeIcon.File;
        item.description =
          this.options.viewMode === 'list' && node.dir ? `${node.dir} · ${node.refs.length}` : `${node.refs.length}`;
        item.tooltip = node.uri.scheme === 'file' ? node.uri.fsPath : node.uri.toString();
        item.contextValue = 'file';
        return item;
      }
      case 'ref':
        return this.refItem(node);
    }
  }

  private refItem(node: RefNode): vscode.TreeItem {
    const { ref } = node;
    const range = ref.location.range;
    const start = Math.max(0, range.start.character - ref.previewOffset);
    const end =
      range.start.line === range.end.line ? range.end.character - ref.previewOffset : ref.preview.length;
    const label: vscode.TreeItemLabel = {
      label: ref.preview || `${path.basename(ref.location.uri.path)}:${range.start.line + 1}`,
      highlights: start < ref.preview.length ? [[start, Math.min(Math.max(end, start), ref.preview.length)]] : [],
    };

    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    item.iconPath = ACCESS_ICON[ref.access];
    const notes = [ref.note, ref.heuristic ? 'guessed' : undefined].filter(Boolean);
    item.description = [`Ln ${range.start.line + 1}`, ...notes].join(' · ');
    item.tooltip = new vscode.MarkdownString(
      `**${ACCESS_LABEL[ref.access]}**` +
        (ref.note ? ` (${ref.note})` : '') +
        (ref.heuristic ? ' (guessed from text, no answer from the language server)' : '') +
        '  \n' +
        `${vscode.workspace.asRelativePath(ref.location.uri)}:${range.start.line + 1}:${range.start.character + 1}`,
    );
    item.contextValue = 'reference';
    item.command = { command: 'refsTree.open', title: 'Open Reference', arguments: [ref] };
    return item;
  }

  private fileCollapsedState(): vscode.TreeItemCollapsibleState {
    const total = this.search?.references.length ?? 0;
    return this.expandAll || total <= this.options.autoExpandLimit
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed;
  }

  private rebuild(): void {
    this.roots = this.search ? buildTree(this.search.references, this.options, `g${this.generation}`) : [];
    this.changed.fire(undefined);
  }
}

export function buildTree(references: Reference[], options: TreeOptions, idPrefix: string): Node[] {
  if (!options.groupByAccess) {
    return buildFiles(references, options, idPrefix, undefined);
  }
  const groups: Node[] = [];
  for (const access of ACCESS_ORDER) {
    const refs = references.filter((r) => r.access === access);
    if (refs.length === 0) {
      continue;
    }
    const group: GroupNode = { kind: 'group', id: `${idPrefix}/${access}`, access, children: [], refs };
    group.children = buildFiles(refs, options, group.id, group);
    groups.push(group);
  }
  return groups;
}

function buildFiles(references: Reference[], options: TreeOptions, idPrefix: string, parent: ContainerNode | undefined): Node[] {
  const files = new Map<string, { uri: vscode.Uri; segments: string[]; refs: Reference[] }>();
  for (const ref of references) {
    const key = ref.location.uri.toString();
    let entry = files.get(key);
    if (!entry) {
      entry = { uri: ref.location.uri, segments: pathSegments(ref.location.uri), refs: [] };
      files.set(key, entry);
    }
    entry.refs.push(ref);
  }

  if (options.viewMode === 'list') {
    return [...files.values()]
      .sort((a, b) => compareNames(a.segments.join('/'), b.segments.join('/')))
      .map((f) => makeFile(f.uri, f.segments, f.refs, `${idPrefix}/${f.segments.join('/')}`, parent));
  }

  const root: FolderNode = { kind: 'folder', id: idPrefix, name: '', uri: vscode.Uri.file('/'), children: [], refs: [] };
  for (const f of files.values()) {
    let folder = root;
    const dirs = f.segments.slice(0, -1);
    dirs.forEach((name, i) => {
      folder.refs.push(...f.refs);
      let child = folder.children.find((c): c is FolderNode => c.kind === 'folder' && c.name === name);
      if (!child) {
        const up = dirs.length - i;
        child = {
          kind: 'folder',
          id: `${folder.id}/${name}`,
          name,
          uri: vscode.Uri.joinPath(f.uri, ...Array<string>(up).fill('..')),
          children: [],
          refs: [],
          parent: folder === root ? parent : folder,
        };
        folder.children.push(child);
      }
      folder = child;
    });
    folder.refs.push(...f.refs);
    folder.children.push(makeFile(f.uri, f.segments, f.refs, `${folder.id}/${f.segments[f.segments.length - 1]}`, folder === root ? parent : folder));
  }

  if (options.compactFolders) {
    root.children.forEach(compact);
  }
  root.children.forEach(sortChildren);
  return sortNodes(root.children);
}

function makeFile(uri: vscode.Uri, segments: string[], refs: Reference[], id: string, parent: ContainerNode | undefined): FileNode {
  const file: FileNode = { kind: 'file', id, uri, dir: segments.slice(0, -1).join('/'), children: [], refs, parent };
  file.children = refs.map((ref) => ({
    kind: 'ref',
    id: `${id}#${ref.location.range.start.line}:${ref.location.range.start.character}`,
    ref,
    parent: file,
  }));
  return file;
}

/** Joins folder chains that have exactly one sub-folder and no files, like VS Code's compact folders. */
function compact(node: Node): void {
  if (node.kind !== 'folder') {
    return;
  }
  while (node.children.length === 1 && node.children[0].kind === 'folder') {
    const only: FolderNode = node.children[0];
    node.name = `${node.name}/${only.name}`;
    node.uri = only.uri;
    node.children = only.children;
    node.children.forEach((c) => (c.parent = node));
  }
  node.children.forEach(compact);
}

function sortChildren(node: Node): void {
  if (node.kind === 'folder') {
    node.children = sortNodes(node.children);
    node.children.forEach(sortChildren);
  }
}

function sortNodes(nodes: Node[]): Node[] {
  const name = (n: Node) => (n.kind === 'folder' ? n.name : n.kind === 'file' ? path.posix.basename(n.uri.path) : '');
  return nodes.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'folder' ? -1 : 1;
    }
    return compareNames(name(a), name(b));
  });
}

function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** Path of a file split into folder names, relative to its workspace folder when it has one. */
function pathSegments(uri: vscode.Uri): string[] {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (folder) {
    const relative = path.posix.relative(folder.uri.path, uri.path).split('/').filter(Boolean);
    const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    return multiRoot ? [folder.name, ...relative] : relative;
  }
  const segments = uri.path.split('/').filter(Boolean);
  return uri.scheme === 'file' ? segments : [uri.scheme, ...segments];
}
