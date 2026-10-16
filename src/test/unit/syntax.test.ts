import * as assert from 'assert';
import { describe, it } from 'node:test';
import { guessAccess, isNamedArgument, isReadOnlyReference, maskCommentsAndStrings } from '../../syntax';

/** Splits `code` at the `|` marking where the reference starts; the reference is `name`. */
function namedArgument(code: string, name = 'InStock'): boolean {
  const at = code.indexOf('|');
  const before = code.slice(0, at);
  const rest = code.slice(at + 1);
  const lineEnd = rest.indexOf('\n');
  const after = (lineEnd < 0 ? rest : rest.slice(0, lineEnd)).slice(name.length);
  return isNamedArgument(before, after);
}

function guess(line: string, name = 'x'): 'read' | 'write' {
  const start = line.indexOf(name);
  return guessAccess(line, start, start + name.length);
}

describe('isNamedArgument', () => {
  it('matches the first and later named arguments', () => {
    assert.strictEqual(namedArgument('new Dto(|InStock: true)'), true);
    assert.strictEqual(namedArgument('new Dto(a: 1, |InStock: true)'), true);
    assert.strictEqual(namedArgument('Call(\n    a: 1,\n    |InStock: x)'), true);
    assert.strictEqual(namedArgument('public Dto(bool r) : this(|InStock: false, r)'), true);
  });

  it('ignores comments and strings between arguments', () => {
    const code = [
      'new Dto(',
      '    Label: $"odd ) text {x} // not a comment, \\"quoted (\\"",',
      '    Other: @"verbatim "" ) ;",',
      '    Raw: """ ) ; { """,',
      "    Char: ')',",
      '    // A comment (with parentheses), ending with a period.',
      '    /* A block comment; with a semicolon. */',
      '    |InStock: true)',
    ].join('\n');
    assert.strictEqual(namedArgument(code), true);
  });

  it('does not match property patterns, ternaries, labels or plain arguments', () => {
    assert.strictEqual(namedArgument('x is { Reserved: false, |InStock: true }'), false);
    assert.strictEqual(namedArgument('x switch { { |InStock: true } => 1 }'), false);
    assert.strictEqual(namedArgument('Check(flag ? dto.|InStock : false)'), false);
    assert.strictEqual(namedArgument('Check(|InStock)'), false);
    assert.strictEqual(namedArgument('global::|InStock::Foo'), false);
    assert.strictEqual(namedArgument('Run();\n|InStock:\n    goto InStock;'), false);
  });
});

describe('isReadOnlyReference', () => {
  it('matches ref readonly locals and in arguments', () => {
    assert.strictEqual(isReadOnlyReference('ref readonly int view = ref '), true);
    assert.strictEqual(isReadOnlyReference('Peek(in '), true);
    assert.strictEqual(isReadOnlyReference('Peek(a, in '), true);
  });

  it('does not match writable references', () => {
    assert.strictEqual(isReadOnlyReference('ref int alias = ref '), false);
    assert.strictEqual(isReadOnlyReference('Bump(ref '), false);
    assert.strictEqual(isReadOnlyReference('foreach (var y in '), false);
  });
});

describe('guessAccess', () => {
  it('recognises assignments and increments', () => {
    for (const line of ['x = 1;', 'x += 1;', 'x ??= y;', 'x <<= 2;', 'x++;', '--x;', 'Bump(ref x);', 'Try(out x);']) {
      assert.strictEqual(guess(line), 'write', line);
    }
  });

  it('treats comparisons, lambdas and plain use as reads', () => {
    for (const line of ['if (x == 1) {}', 'var f = x => 1;', 'Use(x);', 'return x >= 2;']) {
      assert.strictEqual(guess(line), 'read', line);
    }
  });
});

describe('maskCommentsAndStrings', () => {
  it('keeps code, blanks comments and literals, preserves length and newlines', () => {
    const text = 'a(/* ( */ "(" , \'(\', // (\n b)';
    const masked = maskCommentsAndStrings(text);
    assert.strictEqual(masked.length, text.length);
    assert.strictEqual(masked.replace(/\s+/g, ''), 'a(,,b)');
    assert.strictEqual(masked.split('\n').length, 2);
  });

  it('handles interpolation holes containing strings', () => {
    const masked = maskCommentsAndStrings('f($"{g("x)")}", y)');
    assert.strictEqual(masked.replace(/\s+/g, ''), 'f(,y)');
  });
});
