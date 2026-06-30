import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const TARGET_URL = 'https://saily.com/it/esim-supported-devices/';
const OUTPUT_FILE = 'public/devices.json';
const PROFILE_DIR = '.cache/device-crawler-profile';
const NAVIGATION_TIMEOUT_MS = readIntegerEnv('CRAWLER_NAVIGATION_TIMEOUT_MS', 60_000);
const SECTION_TIMEOUT_MS = readIntegerEnv('CRAWLER_SECTION_TIMEOUT_MS', 45_000);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

/**
 * Normalizes DOM text while preserving the visible model wording from the source page.
 *
 * @param {string | null | undefined} value - Raw text read from the page.
 * @returns {string} Text trimmed and collapsed to single spaces.
 */
function normalizeText(value) {
  return value?.replace(/\s+/g, ' ').trim() ?? '';
}

/**
 * Reads an environment variable as a boolean flag.
 *
 * @param {string} name - Environment variable name.
 * @param {boolean} defaultValue - Value used when the variable is not set.
 * @returns {boolean} Parsed boolean value.
 */
function readBooleanEnv(name, defaultValue) {
  const value = process.env[name];

  if (value == null) {
    return defaultValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/**
 * Reads an environment variable as an integer timeout.
 *
 * @param {string} name - Environment variable name.
 * @param {number} defaultValue - Value used when the variable is not set or invalid.
 * @returns {number} Parsed integer value.
 */
function readIntegerEnv(name, defaultValue) {
  const value = Number.parseInt(process.env[name] ?? '', 10);

  return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

/**
 * Builds Chromium launch options for local runs and GitHub Actions.
 *
 * @returns {{ headless: boolean, profilePath: string }} Browser options used by the crawler.
 */
function getRuntimeOptions() {
  const isCi = process.env.CI === 'true';

  return {
    headless: readBooleanEnv('CRAWLER_HEADLESS', isCi),
    profilePath: path.join(projectRoot, PROFILE_DIR),
  };
}

/**
 * Waits until the rendered source page exposes the Smartphone section.
 *
 * @param {import('playwright').Page} page - Playwright page containing the target website.
 * @returns {Promise<void>} Resolves when the Smartphone heading is available.
 */
async function waitForSmartphoneSection(page) {
  try {
    await page.waitForFunction(
      () => {
        const normalize = (value) => value?.replace(/\s+/g, ' ').trim() ?? '';

        return Array.from(document.querySelectorAll('h2')).some((heading) => {
          return normalize(heading.textContent) === 'Smartphone';
        });
      },
      undefined,
      { timeout: SECTION_TIMEOUT_MS },
    );
  } catch (error) {
    const pageDiagnostics = await getPageDiagnostics(page);

    throw new Error(
      `Smartphone section was not found within ${SECTION_TIMEOUT_MS}ms. `
        + `Current page diagnostics: ${JSON.stringify(pageDiagnostics)}`,
      { cause: error },
    );
  }
}

/**
 * Collects safe page diagnostics for timeout failures.
 *
 * @param {import('playwright').Page} page - Playwright page to inspect.
 * @returns {Promise<{ title: string, url: string, bodyStart: string }>} Diagnostic page details.
 */
async function getPageDiagnostics(page) {
  return page.evaluate(() => ({
    title: document.title,
    url: location.href,
    bodyStart: document.body?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 500) ?? '',
  }));
}

/**
 * Extracts all smartphone models from the rendered source accordion.
 *
 * @param {import('playwright').Page} page - Playwright page with the loaded target website.
 * @returns {Promise<Array<{ model: string, brand: string }>>} Flat list of supported smartphone models.
 */
async function extractSmartphones(page) {
  return page.evaluate(() => {
    const normalize = (value) => value?.replace(/\s+/g, ' ').trim() ?? '';
    const smartphoneHeading = Array.from(document.querySelectorAll('h2')).find((heading) => {
      return normalize(heading.textContent) === 'Smartphone';
    });

    if (!smartphoneHeading) {
      throw new Error('Smartphone section heading was not found.');
    }

    // The active device category is contained by a ".pt-6" wrapper; sibling categories are hidden.
    const smartphoneSection = smartphoneHeading.closest('.pt-6');

    if (!smartphoneSection) {
      throw new Error('Smartphone section container was not found.');
    }

    const devices = [];
    const accordionItems = Array.from(smartphoneSection.querySelectorAll('li'));

    for (const accordionItem of accordionItems) {
      const brand = normalize(
        accordionItem.querySelector(':scope > button h3')?.textContent
          ?? accordionItem.querySelector(':scope > button')?.textContent,
      );

      if (!brand) {
        continue;
      }

      const models = Array.from(accordionItem.querySelectorAll(':scope > section li'))
        .map((modelItem) => normalize(modelItem.textContent))
        .filter(Boolean);

      for (const model of models) {
        devices.push({ model, brand });
      }
    }

    return devices;
  });
}

/**
 * Fails fast when the extracted data is empty or malformed.
 *
 * @param {Array<{ model: string, brand: string }>} devices - Extracted smartphone device records.
 * @returns {void}
 */
function validateSmartphones(devices) {
  if (!Array.isArray(devices) || devices.length === 0) {
    throw new Error('No smartphone devices were extracted from the source page.');
  }

  for (const device of devices) {
    if (!device.model || !device.brand) {
      throw new Error(`Invalid device record: ${JSON.stringify(device)}`);
    }
  }
}

/**
 * Writes the generated JSON file, creating its parent directory when needed.
 *
 * @param {string} outputPath - Destination path relative to the project root.
 * @param {Array<{ model: string, brand: string }>} devices - Smartphone device records to serialize.
 * @returns {Promise<void>}
 */
async function writeJsonFile(outputPath, devices) {
  const absoluteOutputPath = path.join(projectRoot, outputPath);

  await mkdir(path.dirname(absoluteOutputPath), { recursive: true });
  await writeFile(absoluteOutputPath, `${JSON.stringify(devices, null, 2)}\n`, 'utf8');
}

/**
 * Runs the crawler and writes the public JSON data file.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const runtimeOptions = getRuntimeOptions();
  const context = await chromium.launchPersistentContext(runtimeOptions.profilePath, {
    headless: runtimeOptions.headless,
    locale: 'it-IT',
    timezoneId: 'Europe/Rome',
    viewport: { width: 1440, height: 1200 },
  });

  try {
    const page = context.pages()[0] ?? await context.newPage();

    page.setDefaultTimeout(SECTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    await waitForSmartphoneSection(page);

    const devices = await extractSmartphones(page);

    validateSmartphones(devices);
    await writeJsonFile(OUTPUT_FILE, devices);

    console.log(`Wrote ${devices.length} smartphone records to ${OUTPUT_FILE}.`);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
