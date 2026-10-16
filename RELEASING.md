# Releasing (update and publish)

The extension is published to the VS Code Marketplace as **`techital.better-csharp-references`**. The publisher is `Techital`.

- Listing: https://marketplace.visualstudio.com/items?itemName=techital.better-csharp-references
- Publisher admin: https://marketplace.visualstudio.com/manage/publishers/techital

Releases are published **by hand** with a Microsoft Entra ID sign-in. There is no Azure DevOps token, because creating an Azure DevOps organization requires an Azure subscription. Pushing a version tag afterwards creates the GitHub release with the `.vsix` attached.

## Each release

### 1. Make the change and bump the version

On a new branch from `origin/master`:

```bash
git fetch origin
git switch -c <branch-name> origin/master
```

1. Make the change.
2. Bump `version` in `package.json` by hand or with `npm version`. Use `patch` for fixes (1.0.0 → 1.0.1), `minor` for new features, `major` for breaking changes:

   ```bash
   npm version patch --no-git-tag-version
   ```

3. Add a section for the new version at the top of `CHANGELOG.md`. The Marketplace shows it on the **Changelog** tab.
4. Check that everything still works:

   ```bash
   npm run test:unit
   npm test
   npm run package
   ```

   `npm test` opens a VS Code window for about a minute. `npm run package` must finish without warnings.

5. Push the branch, open a PR, wait for **CI** to pass, and merge.

### 2. Publish to the Marketplace

From an up-to-date `master`:

```bash
git switch master
git pull
```

Make sure the Azure CLI is signed in as Techital. This should print `jonathan@techital.se`:

```bash
AZURE_CONFIG_DIR="$HOME/.azure-techital" az account show --query user.name -o tsv
```

If it fails or prints something else, sign in again (see [one-time setup](#one-time-setup), step 3).

Then publish:

```bash
AZURE_CONFIG_DIR="$HOME/.azure-techital" npx vsce publish --azure-credential
```

**The `AZURE_CONFIG_DIR=…` prefix is required.** Without it, `vsce` uses your normal Azure CLI login (e.g. a work account) and the Marketplace refuses with "Access Denied".

The output ends with `DONE  Published techital.better-csharp-references vX.Y.Z.` The new version is live on the Marketplace within a few minutes, and installed copies update automatically.

### 3. Tag the release

The tag must be `v` + the `package.json` version:

```bash
git tag v1.0.1
git push origin v1.0.1
```

The **Publish** workflow (GitHub → Actions):

1. runs the tests
2. checks the tag against `package.json`
3. creates a GitHub release with the `.vsix` attached

It skips the Marketplace step because no `VSCE_PAT` secret is set.

### 4. Check

- The listing shows the new version: https://marketplace.visualstudio.com/items?itemName=techital.better-csharp-references
- In VS Code, the Extensions view shows the update. Click **Update** or reload.

## One-time setup

This is already done. It's kept here in case it has to be redone, e.g. on a new computer.

1. **The publisher.** `Techital` was created at https://marketplace.visualstudio.com/manage, signed in with the **personal Microsoft account** `jonathan@techital.se`. That account is the publisher's **Owner**.

2. **The publishing identity.** The Azure CLI cannot sign in as a personal Microsoft account directly. It signs in as that account's **guest identity** in the Azure tenant "Standardkatalog" (`a768c075-793b-40c4-846c-b84545545a42`). Azure DevOps treats the guest as a different user, with user ID **`649066b1-5c2f-65a6-9076-5338a54ab788`**. That ID was added on the publisher's **Members** page as **Contributor**.
   - The Members page wants the **user ID (GUID), not an email address**. An email gives "Invalid domain".

3. **A separate Azure CLI login folder** (`~/.azure-techital`), so the Techital sign-in doesn't touch your other Azure CLI logins:

   ```bash
   AZURE_CONFIG_DIR="$HOME/.azure-techital" az config set core.login_experience_v2=off
   ```
   ```bash
   AZURE_CONFIG_DIR="$HOME/.azure-techital" az login --tenant a768c075-793b-40c4-846c-b84545545a42 --allow-no-subscriptions
   ```

   - Sign in as `jonathan@techital.se` and complete the MFA prompt.
   - If the browser step doesn't work, add `--use-device-code` to the `az login` command.
   - Run the `az login` command again whenever the session has expired.

## Troubleshooting

| Error | Cause and fix |
|---|---|
| `Access Denied: <id> needs the following permission(s) on the resource /Techital …` | **Wrong account.** Usually the `AZURE_CONFIG_DIR="$HOME/.azure-techital"` prefix is missing, so your work account was used. If `<id>` is a new ID, that identity isn't a publisher member: add `<id>` on the Members page as Contributor. |
| `The requested operation is not allowed` (`InvalidAccessException`) | The signed-in identity has no role on the publisher. Check that user ID `649066b1-…` is still listed under Members. |
| `AADSTS50076 … you must use multi-factor authentication` during `az login` | You signed in without `--tenant`. Use the `az login --tenant a768c075-… --allow-no-subscriptions` command above. |
| `az login` crashes with `'NoneType' object has no attribute 'get'` | A bug in the Azure CLI's account picker. Run the `az config set core.login_experience_v2=off` command above, then sign in again. |
| `… already exists` when publishing | That version is already on the Marketplace. Bump `version` in `package.json`. A published version can't be replaced. |
| Publish workflow fails with "Tag … does not match package.json version" | The tag and `package.json` disagree. Delete the tag (`git tag -d v1.0.1`, `git push origin :refs/tags/v1.0.1`), fix the version, merge, then tag again. |

## Optional: fully automatic publishing

To make pushing a tag also publish to the Marketplace (skipping the "Publish to the Marketplace" step above):

1. Create an Azure subscription and an Azure DevOps organization under the personal account.
2. In that organization, create a personal access token with **Organization: All accessible organizations** and **Scopes: Marketplace → Manage**.
3. Store the token as the GitHub repository secret **`VSCE_PAT`** (Settings → Secrets and variables → Actions).

The Publish workflow then publishes the tagged version itself, and skips versions that are already on the Marketplace.
