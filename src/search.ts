import * as vscode from 'vscode';
import { guessAccess, isNamedArgument, isReadOnlyReference } from './syntax';

export type Access = 'definition' | 'write' | 'read';

export interface Reference {
  location: vscode.Location;
  /** Line text with leading whitespace removed. */
  preview: string;
  /** Number of characters removed from the start of the line to build `preview`. */
  previewOffset: number;
  access: Access;
  /** True when the language server gave no answer and the access kind was guessed from the text. */
  heuristic: boolean;
  /** Why the access kind differs from what the language server said, shown next to the reference. */
  note?: string;
}

export interface SearchOptions {
  /** Treat `Name:` in `new Foo(Name: value)` as a write (it initialises the property of a positional record). */
  namedArgumentsAsWrite: boolean;
}

const DEFAULT_OPTIONS: SearchOptions = { namedArgumentsAsWrite: true };

export interface ReferenceSearch {
  symbol: string;
  origin: vscode.Location;
  references: Reference[];
}

const MAX_PREVIEW = 250;
const FILE_CONCURRENCY = 8;
const MAX_HIGHLIGHT_REQUESTS_PER_FILE = 4;
/** How far back to look for the `(` that opens an argument list (long DTO constructors). */
const NAMED_ARGUMENT_LOOKBACK_LINES = 300;

/**
 * Runs "find all references" through whatever reference provider is active (Roslyn via the
 * C# extension / C# Dev Kit) and tags every hit as definition, write or read.
 *
 * Rejects with `vscode.CancellationError` as soon as `token` is cancelled. VS Code's provider
 * commands take no token, so a request already sent to Roslyn still finishes in the background,
 * but its result is dropped and no further requests are made for this search.
 */
export async function findReferences(
  uri: vscode.Uri,
  position: vscode.Position,
  token?: vscode.CancellationToken,
  options: SearchOptions = DEFAULT_OPTIONS,
): Promise<ReferenceSearch> {
  const document = await vscode.workspace.openTextDocument(uri);
  const wordRange = document.getWordRangeAtPosition(position);
  const symbol = wordRange ? document.getText(wordRange) : '';

  const [locations, definitions] = await cancellable(
    Promise.all([
      vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', uri, position),
      getDefinitions(uri, position),
    ]),
    token,
  );

  const byFile = new Map<string, vscode.Location[]>();
  for (const location of locations ?? []) {
    const key = location.uri.toString();
    const list = byFile.get(key);
    if (list) {
      list.push(location);
    } else {
      byFile.set(key, [location]);
    }
  }

  const references: Reference[] = [];
  await cancellable(
    forEachLimit([...byFile.values()], FILE_CONCURRENCY, async (fileLocations) => {
      if (!token?.isCancellationRequested) {
        references.push(...(await classifyFile(fileLocations, definitions, options, token)));
      }
    }),
    token,
  );

  references.sort(compareReferences);
  return { symbol, origin: new vscode.Location(uri, wordRange ?? new vscode.Range(position, position)), references };
}

async function getDefinitions(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location[]> {
  try {
    const result = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
      'vscode.executeDefinitionProvider',
      uri,
      position,
    );
    return (result ?? []).map((d) =>
      'targetUri' in d ? new vscode.Location(d.targetUri, d.targetSelectionRange ?? d.targetRange) : d,
    );
  } catch {
    return [];
  }
}

/**
 * Classifies all references in one file using document highlights. Asked at one occurrence, Roslyn
 * returns every occurrence of the symbol in that file tagged `Read` or `Write` (assignments, ++/--,
 * compound assignments, ref/out arguments, deconstruction, object initializers, `with`, attribute
 * properties). `Text` carries no access information: Roslyn uses it for the definition, VS Code's
 * word-based fallback uses it for everything before the project has loaded, and Roslyn answers with
 * a lone `Text` when asked from inside a deconstruction. So the first request goes to the
 * definition when it is in this file, and references still without a Read/Write answer get their
 * own request (also needed for linked symbols, e.g. a record's positional parameter and property).
 */
async function classifyFile(
  locations: vscode.Location[],
  definitions: vscode.Location[],
  options: SearchOptions,
  token: vscode.CancellationToken | undefined,
): Promise<Reference[]> {
  const uri = locations[0].uri;
  let document: vscode.TextDocument | undefined;
  try {
    document = await vscode.workspace.openTextDocument(uri);
  } catch {
    // Not loadable (e.g. a virtual document that went away); keep the locations without preview.
  }

  const highlights: vscode.DocumentHighlight[] = [];
  const findHighlight = (location: vscode.Location) => {
    const matches = highlights.filter(
      (h) => h.kind !== vscode.DocumentHighlightKind.Text && h.range.contains(location.range.start),
    );
    return matches.find((h) => h.range.start.isEqual(location.range.start)) ?? matches[0];
  };

  if (document) {
    const definitionHere = locations.find((l) => isDefinition(l, definitions));
    const ordered = definitionHere ? [definitionHere, ...locations.filter((l) => l !== definitionHere)] : locations;
    const tried = new Set<vscode.Location>();
    const needsRequest = (l: vscode.Location) =>
      !tried.has(l) && (l === definitionHere || (!isDefinition(l, definitions) && !findHighlight(l)));
    for (let i = 0; i < MAX_HIGHLIGHT_REQUESTS_PER_FILE && !token?.isCancellationRequested; i++) {
      const next = ordered.find(needsRequest);
      if (!next) {
        break;
      }
      tried.add(next);
      highlights.push(...(await getHighlights(uri, next.range.start)));
    }
  }

  return locations.map((location) => {
    const line = document && location.range.start.line < document.lineCount ? document.lineAt(location.range.start.line).text : '';
    const previewOffset = line.length - line.trimStart().length;
    const preview = line.trim().slice(0, MAX_PREVIEW);
    const base = { location, preview, previewOffset };

    if (isDefinition(location, definitions)) {
      return { ...base, access: 'definition', heuristic: false };
    }

    const highlight = findHighlight(location);
    const heuristic = !highlight;
    const access: Access = highlight
      ? highlight.kind === vscode.DocumentHighlightKind.Write
        ? 'write'
        : 'read'
      : location.range.isSingleLine
        ? guessAccess(line, location.range.start.character, location.range.end.character)
        : 'read';

    if (access === 'read' && document && options.namedArgumentsAsWrite && isNamedArgumentAt(document, location.range)) {
      return { ...base, access: 'write', heuristic, note: 'named argument' };
    }
    if (access === 'write' && isReadOnlyReference(line.slice(0, location.range.start.character))) {
      return { ...base, access: 'read', heuristic, note: 'readonly reference' };
    }
    return { ...base, access, heuristic };
  });
}

function isNamedArgumentAt(document: vscode.TextDocument, range: vscode.Range): boolean {
  if (!range.isSingleLine) {
    return false;
  }
  const lookbackStart = new vscode.Position(Math.max(0, range.start.line - NAMED_ARGUMENT_LOOKBACK_LINES), 0);
  const before = document.getText(new vscode.Range(lookbackStart, range.start));
  const after = document.lineAt(range.end.line).text.slice(range.end.character);
  return isNamedArgument(before, after);
}

async function getHighlights(uri: vscode.Uri, position: vscode.Position): Promise<vscode.DocumentHighlight[]> {
  try {
    return (
      (await vscode.commands.executeCommand<vscode.DocumentHighlight[]>('vscode.executeDocumentHighlights', uri, position)) ?? []
    );
  } catch {
    return [];
  }
}

function isDefinition(location: vscode.Location, definitions: vscode.Location[]): boolean {
  return definitions.some(
    (d) =>
      d.uri.toString() === location.uri.toString() &&
      (d.range.contains(location.range.start) || location.range.contains(d.range.start)),
  );
}

function compareReferences(a: Reference, b: Reference): number {
  const byPath = a.location.uri.toString().localeCompare(b.location.uri.toString());
  if (byPath !== 0) {
    return byPath;
  }
  return a.location.range.start.compareTo(b.location.range.start);
}

/** Settles like `promise`, but rejects with `vscode.CancellationError` as soon as `token` is cancelled. */
function cancellable<T>(promise: Thenable<T>, token: vscode.CancellationToken | undefined): Promise<T> {
  if (!token) {
    return Promise.resolve(promise);
  }
  if (token.isCancellationRequested) {
    return Promise.reject(new vscode.CancellationError());
  }
  return new Promise<T>((resolve, reject) => {
    const subscription = token.onCancellationRequested(() => reject(new vscode.CancellationError()));
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => subscription.dispose());
  });
}

async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      await fn(items[next++]);
    }
  });
  await Promise.all(workers);
}
