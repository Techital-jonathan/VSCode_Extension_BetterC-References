# Releasing

Releases are published to the VS Code Marketplace by the **Publish** GitHub Actions workflow. It runs when a version tag is pushed.

## One-time setup

1. **Create the publisher.**
   - Sign in at https://marketplace.visualstudio.com/manage with the Microsoft account that should own the extension.
   - Create a publisher with the ID **`techital`**. It must match `publisher` in `package.json`.
2. **Create a token.**
   - In Azure DevOps (https://dev.azure.com, same Microsoft account), go to **User settings → Personal access tokens → New Token**:
     - Organization: **All accessible organizations**
     - Scopes: **Custom defined → Marketplace → Manage**
3. **Store the token on GitHub.**
   - In the GitHub repository, go to **Settings → Secrets and variables → Actions → New repository secret**.
   - Name: `VSCE_PAT`. Value: the token.

## Each release

1. Update `version` in `package.json` and add a section to `CHANGELOG.md`.
2. Merge to `master` and wait for CI to pass.
3. Tag the release and push the tag. The tag must be `v` + the `package.json` version, for example `v1.0.0`:

   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

The workflow then:

1. runs the tests
2. checks the tag against `package.json`
3. publishes to the Marketplace
4. creates a GitHub release with the `.vsix` attached

The extension appears in the Extensions view within a few minutes.

## Publishing by hand

```bash
VSCE_PAT=<token> npx vsce publish
```

`npx vsce publish --azure-credential` signs in with Microsoft Entra ID instead of a token. It uses your `az login` session.
