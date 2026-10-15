# Changelog

## 1.0.0

First Marketplace release.

- Find All References for C# (`Shift+Alt+F12`) in its own panel, as a collapsible folder tree or a flat list.
- Grouping into Definition / Write / Read, using Roslyn's read/write information.
- Named arguments (`new Dto(InStock: value)`) count as writes; `ref readonly` locals and `in` arguments count as reads.
- Starting a new search cancels the one still running.
- Setting `refsTree.replaceFindAllReferences` to keep VS Code's built-in References view on `Shift+Alt+F12`.
