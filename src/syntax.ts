/**
 * Plain-text C# helpers used to refine or replace the language server's read/write answer.
 * No `vscode` import, so they can be unit tested with Node alone.
 */

const WRITE_AFTER = /^\s*(?:(?:\+|-|\*|\/|%|&|\||\^|<<|>>>?|\?\?)?=(?![=>])|\+\+|--)/;
const WRITE_BEFORE = /(?:\+\+|--|\b(?:out|ref)\s+)\s*$/;
const READONLY_REF_BEFORE = /(?:\bref\s+readonly\b[^;]*=\s*ref|[(,]\s*in)\s+$/;

/**
 * Fallback when the language server returns no highlights: guesses from the text around the
 * reference at `[start, end)` of `line`.
 */
export function guessAccess(line: string, start: number, end: number): 'read' | 'write' {
  const before = line.slice(0, start);
  const after = line.slice(end);
  return WRITE_AFTER.test(after) || WRITE_BEFORE.test(before) ? 'write' : 'read';
}

/**
 * Roslyn counts every by-reference use as a write, including `ref readonly x = ref field` and
 * `in field` arguments, which cannot modify the value. `before` is the line up to the reference.
 */
export function isReadOnlyReference(before: string): boolean {
  return READONLY_REF_BEFORE.test(before);
}

/**
 * True for `Name` in `new Foo(Name: value)` / `Foo(Name: value)`. Roslyn reports it as a plain
 * reference to the parameter, but for positional records and primary constructors it is what sets
 * the property. Property patterns (`x is { Name: true }`) and ternaries (`c ? Name : other`) are not
 * matched: the name must start an argument, directly inside parentheses. Comments and string
 * literals between the arguments are ignored.
 *
 * @param before Source text before the reference (as many lines as needed to reach the `(`).
 * @param after The rest of the reference's line.
 */
export function isNamedArgument(before: string, after: string): boolean {
  if (!/^\s*:(?!:)/.test(after)) {
    return false;
  }

  const code = maskCommentsAndStrings(before).trimEnd();
  const previous = code[code.length - 1];
  if (previous !== '(' && previous !== ',') {
    return false;
  }

  let depth = 0;
  for (let i = code.length - 1; i >= 0; i--) {
    const c = code[i];
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
    let from = i;
    let end = i + 1;
    if (c === '/' && text[i + 1] === '/') {
      const newline = text.indexOf('\n', i);
      end = newline < 0 ? text.length : newline;
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      end = close < 0 ? text.length : close + 2;
    } else if (c === '"' || c === "'") {
      end = skipLiteral(text, i);
      while (from > 0 && (text[from - 1] === '$' || text[from - 1] === '@')) {
        from--;
      }
    } else {
      i++;
      continue;
    }
    blank(from, end);
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
