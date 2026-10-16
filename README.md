# Better C# References

Find All References for C#, the way it should be:

- **See where a field or property is written and where it is only read.** References are grouped into **Definition / Write / Read**, and every row has an icon for its kind (pen = write, eye = read), even with grouping off.
- **Browse results as a folder tree.** Collapse and expand folders, with single-child chains joined (`src/Core/Services`), or switch to a flat file list.
- **Keep your hands on the keyboard.** `Shift+Alt+F12` in a C# file opens the results in a "C# References" panel. Click or press Enter on a row to jump to it.

## Usage

Put the cursor on a C# symbol and press **`Shift+Alt+F12`**, or right-click → **Find All References (Tree)**.

In the panel's title bar you can:

- switch between **tree** and **list**
- turn **Read/Write grouping** on or off
- **Collapse All** / **Expand All**
- **rerun** or **clear** the search

Right-click a row to **dismiss** it (or use its ✕) or to **copy its path**.

Your tree/list and grouping choices are remembered. Starting a new search cancels one that is still running.

## What counts as a write

Read/write comes from the C# language server (Roslyn), the same information that colors reads and writes when you click on a symbol.

| Write | Read |
|---|---|
| `x = …`, `x += …`, `x ??= …`, `x++`, `--x` | `Use(x)`, `x == y`, `$"{x}"` |
| `Bump(ref x)`, `TryGet(out x)`, `ref var r = ref x` | `Peek(in x)`, `ref readonly var r = ref x` |
| `(x, y) = …` deconstruction | `obj is { X: true }`, `switch { { X: true } => … }` |
| `new Foo { X = 1 }`, `foo with { X = 1 }`, `[Attr(X = 1)]` | `nameof(X)`, `new { foo.X }`, tuple `(X: foo.X, …)` |
| **Named arguments:** `new FooDto(X: value)`, `: this(X: value)` | |

Two of these go beyond Roslyn:

- **Named arguments are writes.** For records and primary constructors, `X:` is what sets the property, but Roslyn reports it as a plain reference. Turn this off with `refsTree.namedArgumentsAsWrite`.
- **`in` arguments and `ref readonly` locals are reads.** Roslyn reports every by-reference use as a write.

If the language server gives no answer for a reference (for example while the project is still loading), the kind is guessed from the code around it and the row says **guessed**.

## Requirements

The [C# extension](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csharp) (`ms-dotnettools.csharp`). It works with or without C# Dev Kit.

## Settings

| Setting | Default | Description |
|---|---|---|
| `refsTree.replaceFindAllReferences` | `true` | Use `Shift+Alt+F12` for this extension in C# files. Turn off to keep VS Code's built-in References view on that key. |
| `refsTree.namedArgumentsAsWrite` | `true` | Count `Name:` named arguments as writes |
| `refsTree.defaultViewMode` | `tree` | Tree or list, the first time (your choice is then remembered) |
| `refsTree.defaultGroupByAccess` | `true` | Group by Definition / Write / Read, the first time (your choice is then remembered) |
| `refsTree.compactFolders` | `true` | Join single-child folder chains |
| `refsTree.autoExpandLimit` | `250` | Above this many references, files start collapsed |

## Known limitations

- Only C# files (`.cs`). Razor files (`.razor`, `.cshtml`) are not covered yet.
- The request already sent to the language server cannot be cancelled. When a new search replaces it, that request finishes in the background and its result is discarded.

## Development

```bash
npm install
npm run compile
```

- **Try it:** open this folder in VS Code and press `F5` (**Run Extension (sample C# project)**).
- **Unit tests:** `npm run test:unit`.
- **Integration tests:** `npm test`. They run a real VS Code with the C# extension against `test-fixtures/Sample`.
  - The expected kinds are the `// Symbol: W R` comments in that project.
  - The tests use `~/.vscode/extensions`, or `VSCODE_EXTENSIONS_DIR` if set, and install the C# extension there if it is missing.
- **Package:** `npm run package` produces `better-csharp-references.vsix`.

Releasing is described in [RELEASING.md](RELEASING.md).

## License

[MIT](LICENSE)
