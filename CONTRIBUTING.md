# Contributing

## Setup

```bash
npm install
npm run dev
```

## Before opening a PR

```bash
npm run typecheck
npm test
npm run build
```

CI runs the same three checks on every PR — it must pass before merge.

## Workflow

- Branch off `dev`, PR back into `dev`.
- `main` tracks released, container-shipped state; merges into `main` build and
  publish the Docker image (see `.github/workflows/`).
- Keep commits scoped and use `feat:`/`fix:`/`docs:`/`test:`/`chore:` prefixes,
  matching the existing history.

## Reporting bugs / requesting features

Open an issue with the relevant template. Include repro steps, expected vs.
actual behavior, and proxy logs (`OPENCODE_LOG_LEVEL=debug`) where relevant.
