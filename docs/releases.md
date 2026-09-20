# Releases

## Creating a Release

Releases are automated via GitHub Actions and triggered by git tags. The workflow uses npm OIDC trusted publishing (no tokens required) together with **staged publishing**: pushing a tag *stages* the release, and a maintainer must explicitly approve it (with 2FA) before it goes live.

1. Bump version in `package.json`:

```bash
npm version patch  # or minor, or major
```

2. Push with tags:

```bash
git push origin main --tags
```

The workflow automatically:
- Installs dependencies (`npm ci`)
- Stages the release on npm (`npm stage publish --access public`)

3. Approve the staged release (required — this is what makes it live):

```bash
npm stage list          # find the stage id
npm stage approve <stage-id>   # requires 2FA
```

or approve it on npmjs.com under the **Staged Packages** tab (also 2FA).

After approving, verify the publish:

```bash
npm view @qmxme/pi-rottweiler
```

## Prerequisites

- **Staged publishing** must be enabled for the package on [npmjs.com](https://www.npmjs.com) (package → Settings).
- OIDC trusted publishing must be configured on [npmjs.com](https://www.npmjs.com):
  - Package settings → Trusted Publishers
  - Repository: `qmx/pi-rottweiler`
  - Workflow: `publish.yml`
- **2FA enabled** on your npm account (required for the approval step).
- npm CLI ≥ 11.15 / Node ≥ 22.14 (the workflow upgrades npm to latest on Node 24).

## Version Format

Follow [semantic versioning](https://semver.org):

- **Production**: `v1.2.3`
- **Pre-release**: `v1.0.0-beta.1`, `v1.0.0-rc.1`, `v1.0.0-alpha.1`
