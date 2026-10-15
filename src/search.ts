import * as vscode from 'vscode';

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
      : guessAccess(line, location.range);

    if (access === 'read' && document && options.namedArgumentsAsWrite && isNamedArgument(document, location.range)) {
      return { ...base, access: 'write', heuristic, note: 'named argument' };
    }
    if (access === 'write' && isReadOnlyReference(line, location.range)) {
      return { ...base, access: 'read', heuristic, note: 'readonly reference' };
    }
    return { ...base, access, heuristic };
  });
}

/**
 * Roslyn counts every by-reference use as a write, including `ref readonly x = ref field` and
 * `in field` arguments, which cannot modify the value.
 */
function isReadOnlyReference(line: string, range: vscode.Range): boolean {
  return READONLY_REF_BEFORE.test(line.slice(0, range.start.character));
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

/**
 * True for `Name` in `new Foo(Name: value)` / `Foo(Name: value)`. Roslyn reports it as a plain
 * reference to the parameter, but for positional records and primary constructors it is what sets
 * the property. Property patterns (`x is { Name: true }`) and ternaries (`c ? Name : other`) are not
 * matched: the name must start an argument, directly inside parentheses. Comments and string
 * literals between the arguments are ignored.
 */
export function isNamedArgument(document: vscode.TextDocument, range: vscode.Range): boolean {
  if (range.start.line !== range.end.line) {
    return false;
  }
  const after = document.lineAt(range.end.line).text.slice(range.end.character);
  if (!/^\s*:(?!:)/.test(after)) {
    return false;
  }

  const lookbackStart = new vscode.Position(Math.max(0, range.start.line - NAMED_ARGUMENT_LOOKBACK_LINES), 0);
  const before = maskCommentsAndStrings(document.getText(new vscode.Range(lookbackStart, range.start))).trimEnd();
  const previous = before[before.length - 1];
  if (previous !== '(' && previous !== ',') {
    return false;
  }

  let depth = 0;
  for (let i = before.length - 1; i >= 0; i--) {
    const c = before[i];
    if (c === ')' || c === '}' || c === ']') {
      depth++;
    } else if (c === '(' || c === '{' || c === '[') {
      if (depth === 0) {
        return c === '(';
      }
      depth--;
    } else if (c === ';' && depth === 0) {
      return false;
    }
  }
  return false;
}

/** Replaces comments and string/char literals with spaces, so only code is left for bracket matching. */
export function maskCommentsAndStrings(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) {
      if (out[k] !== '\n') {
        out[k] = ' ';
      }
    }
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    let end = i + 1;
    if (c === '/' && text[i + 1] === '/') {
      const newline = text.indexOf('\n', i);
      end = newline < 0 ? text.length : newline;
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      end = close < 0 ? text.length : close + 2;
    } else if (c === '"' || c === "'") {
      end = skipLiteral(text, i);
    } else {
      i++;
      continue;
    }
    blank(i, end);
    i = end;
  }
  return out.join('');
}

/** Index just past the string or char literal starting at `start` (regular, verbatim, interpolated, raw). */
function skipLiteral(text: string, start: number): number {
  const quote = text[start];
  let verbatim = false;
  let interpolated = false;
  for (let p = start - 1; p >= 0 && (text[p] === '@' || text[p] === '$'); p--) {
    verbatim ||= text[p] === '@';
    interpolated ||= text[p] === '$';
  }
  if (quote === '"' && text.startsWith('"""', start)) {
    let quotes = 0;
    while (text[start + quotes] === '"') {
      quotes++;
    }
    const close = text.indexOf('"'.repeat(quotes), start + quotes);
    return close < 0 ? text.length : close + quotes;
  }

  let depth = 0;
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (depth > 0) {
      if (c === '"' || c === "'") {
        i = skipLiteral(text, i);
        continue;
      }
      depth += c === '{' ? 1 : c === '}' ? -1 : 0;
      i++;
    } else if (!verbatim && c === '\\') {
      i += 2;
    } else if (!verbatim && c === '\n') {
      return i;
    } else if (c === quote) {
      if (verbatim && text[i + 1] === quote) {
        i += 2;
      } else {
        return i + 1;
      }
    } else if (interpolated && c === '{') {
      if (text[i + 1] === '{') {
        i += 2;
      } else {
        depth = 1;
        i++;
      }
    } else {
      i++;
    }
  }
  return i;
}

function isDefinition(location: vscode.Location, definitions: vscode.Location[]): boolean {
  return definitions.some(
    (d) =>
      d.uri.toString() === location.uri.toString() &&
      (d.range.contains(location.range.start) || location.range.contains(d.range.start)),
  );
}

const WRITE_AFTER = /^\s*(?:(?:\+|-|\*|\/|%|&|\||\^|<<|>>>?|\?\?)?=(?![=>])|\+\+|--)/;
const WRITE_BEFORE = /(?:\+\+|--|\b(?:out|ref)\s+)\s*$/;
const READONLY_REF_BEFORE = /(?:\bref\s+readonly\b[^;]*=\s*ref|[(,]\s*in)\s+$/;

/** Fallback when the language server returns no highlights: look at the text around the reference. */
export function guessAccess(line: string, range: vscode.Range): Access {
  if (range.start.line !== range.end.line) {
    return 'read';
  }
  const before = line.slice(0, range.start.character);
  const after = line.slice(range.end.character);
  return WRITE_AFTER.test(after) || WRITE_BEFORE.test(before) ? 'write' : 'read';
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
