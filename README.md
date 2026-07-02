# Smartphone eSIM Device Data

This repository crawls the public eSIM-compatible smartphone list from the source website and publishes it as a static JSON file through GitHub Pages.

The generated file is:

```text
public/devices.json
```

The JSON shape is:

```json
[
  {
    "model": "device model",
    "brand": "device brand"
  }
]
```

## How It Works

The crawler is implemented in Node.js in `scripts/crawl-devices.mjs`.

It supports two runtimes:

- `browserless`: used by GitHub Actions to run the crawl through Browserless BrowserQL.
- `local`: used for local development with Playwright.

The GitHub Actions workflow runs daily at `03:00 UTC`, generates `public/devices.json`, and deploys the `public/` directory to GitHub Pages.

If the source website blocks a CI run and a previously published JSON file exists, the workflow keeps the last valid JSON instead of publishing an empty file.

## Required GitHub Secret

GitHub Actions requires a Browserless token.

Add this secret in the repository settings:

```text
BROWSERLESS_TOKEN
```

Path in GitHub:

```text
Settings -> Secrets and variables -> Actions -> New repository secret
```

The workflow reads it with:

```yaml
BROWSERLESS_TOKEN: ${{ secrets.BROWSERLESS_TOKEN }}
```

## Local Setup

Install dependencies:

```bash
npm install
```

For local Browserless testing, create a local `.env` file:

```env
BROWSERLESS_TOKEN=your_browserless_token
CRAWLER_BROWSER=browserless
CRAWLER_ALLOW_STALE_ON_FAILURE=false
BROWSERLESS_SOLVE_TIMEOUT_MS=60000
CRAWLER_SECTION_TIMEOUT_MS=90000
```

The `.env` file is ignored by git and must not be committed.

Run with Browserless:

```bash
npm run crawl:devices:browserless
```

Run with local Playwright:

```bash
CRAWLER_BROWSER=local npm run crawl:devices
```

## Output

After a successful run, the crawler writes:

```text
public/devices.json
```

When deployed through GitHub Pages, the file is available at:

```text
https://<owner>.github.io/<repo>/devices.json
```
