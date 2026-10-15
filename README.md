# C# References Tree

A replacement for "Find All References" in C# files. Results are shown in their own panel, where you can:

- **Tree or list:** show files as a collapsible folder tree (single-child folder chains are compacted, e.g. `src/Core/Services`) or as a flat list.
- **Group by access:** group references into **Definition / Write / Read**. Each reference also has an icon for its kind (pen = write, eye = read), even when grouping is off.
- **Manage results:** Collapse All / Expand All, rerun, clear, dismiss individual results (✕), copy path.

`Shift+Alt+F12` runs it when a C# editor has focus, replacing VS Code's built-in "Find All References" view for C# files only. Shortcuts from installed extensions take priority over those of built-in extensions such as the References view, so no extra setup is needed; only your own `keybindings.json` can override it. It is also available on the editor right-click menu as **Find All References (Tree)**.

## How it works

- References come from `vscode.executeReferenceProvider`, so the results are the same as the C# Dev Kit / Roslyn ones.
- Read/write comes from Roslyn's document highlights (`vscode.executeDocumentHighlights`), usually one request per file.
  - **Write:** `=`, compound assignments and `??=`, `++`/`--`, `ref`/`out` arguments, `ref` locals, deconstruction targets, object initializer and `with` members, attribute properties.
  - **Read:** everything else, including property patterns (`x is { InStock: true }`), `nameof`, anonymous-type projections and tuple elements.
- Two corrections on top of Roslyn:
  - **Named arguments** (`new PartDto(InStock: value)`) count as writes, since for records and primary constructors they set the property. Roslyn reports them as plain references; turn this off with `refsTree.namedArgumentsAsWrite`.
  - **`ref readonly` locals and `in` arguments** count as reads. Roslyn reports every by-reference use as a write.
- The definition comes from `vscode.executeDefinitionProvider`.
- If the server returns no highlight for a reference, the access is guessed from the surrounding text and marked "guessed".

## Settings

| Setting | Default | |
|---|---|---|
| `refsTree.defaultViewMode` | `tree` | First-time view mode (toggling is remembered) |
| `refsTree.defaultGroupByAccess` | `true` | First-time grouping (toggling is remembered) |
| `refsTree.compactFolders` | `true` | Join single-child folder chains |
| `refsTree.namedArgumentsAsWrite` | `true` | Count `Name:` named arguments as writes |
| `refsTree.autoExpandLimit` | `250` | Above this many references, files start collapsed |

## Development

```bash
npm install
npm run compile
```

- **Try it:** open this folder in VS Code and press `F5` ("Run Extension (sample C# project)").
- **Integration tests:** `npm test`.
  - The tests run against the real C# extension. They use the extensions installed in `~/.vscode/extensions` and download a test copy of VS Code into `.vscode-test`.
  - The expected access kinds are the `// Symbol: W R` comments in `test-fixtures/Sample`.
- **Package:** `npm run package` produces `csharp-references-tree.vsix`.
