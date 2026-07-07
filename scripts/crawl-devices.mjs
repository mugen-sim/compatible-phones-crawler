import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

loadEnvFile(path.join(projectRoot, ".env"));

const TARGET_URL = "https://supportjapantravel.com/en/#faq";
const OUTPUT_FILE = "public/devices.json";
const PROFILE_DIR = ".cache/device-crawler-profile-en";
const BROWSER_LOCALE = "en-US";
const ACCEPT_LANGUAGE = "en-US,en;q=0.9";
const BROWSERLESS_BQL_ENDPOINT =
  process.env.BROWSERLESS_BQL_ENDPOINT ??
  "https://production-sfo.browserless.io/stealth/bql";
const DEVICE_LIST_HEADING = "List of eSIM-compatible devices";
const FAMILY_PREFIXES_BY_BRAND = new Map([
  ["Apple", ["iPhone", "iPad"]],
  ["Google", ["Pixel"]],
  ["Microsoft", ["Surface"]],
  ["Nothing", ["Phone"]],
  ["Redmi", ["Note"]],
  ["Samsung", ["Galaxy"]],
  ["Sharp", ["Aquos"]],
  ["Sony", ["Xperia"]],
]);
const NAVIGATION_TIMEOUT_MS = readIntegerEnv(
  "CRAWLER_NAVIGATION_TIMEOUT_MS",
  60_000,
);
const SECTION_TIMEOUT_MS = readIntegerEnv("CRAWLER_SECTION_TIMEOUT_MS", 45_000);
const BROWSERLESS_SOLVE_TIMEOUT_MS = readIntegerEnv(
  "BROWSERLESS_SOLVE_TIMEOUT_MS",
  60_000,
);
const ALLOW_STALE_ON_FAILURE = readBooleanEnv(
  "CRAWLER_ALLOW_STALE_ON_FAILURE",
  false,
);
const CRAWLER_BROWSER = process.env.CRAWLER_BROWSER ?? "auto";

/**
 * Normalizes DOM text while preserving the visible model wording from the source page.
 *
 * @param {string | null | undefined} value - Raw text read from the page.
 * @returns {string} Text trimmed and collapsed to single spaces.
 */
function normalizeText(value) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

/**
 * Escapes text before it is embedded in a regular expression.
 *
 * @param {string} value - Literal text that should be matched by a RegExp.
 * @returns {string} Text with RegExp metacharacters escaped.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Checks whether a model entry already starts with the given brand.
 *
 * @param {string} modelName - Normalized model name read from the source page.
 * @param {string} brand - Brand name read from the current heading.
 * @returns {boolean} True when the model entry starts with the brand.
 */
function modelStartsWithBrand(modelName, brand) {
  const brandPrefixPattern = new RegExp(
    `^${escapeRegExp(brand)}(?:\\s+|$)`,
    "i",
  );

  return brandPrefixPattern.test(modelName);
}

/**
 * Removes a leading brand from a model entry when the source already includes it.
 *
 * @param {string} modelName - Normalized model name read from the source page.
 * @param {string} brand - Brand name read from the current heading.
 * @returns {string} Model name without a duplicated leading brand.
 */
function stripLeadingBrand(modelName, brand) {
  if (!modelStartsWithBrand(modelName, brand)) {
    return modelName;
  }

  const brandPrefixPattern = new RegExp(
    `^${escapeRegExp(brand)}(?:\\s+|$)`,
    "i",
  );

  return normalizeText(modelName.replace(brandPrefixPattern, ""));
}

/**
 * Splits a source paragraph into individual model entries.
 *
 * @param {string} paragraphText - Text from a paragraph below a brand heading.
 * @returns {string[]} Normalized model entries from the paragraph.
 */
function splitModelEntries(paragraphText) {
  return paragraphText
    .split(",")
    .map((entry) => normalizeText(entry))
    .filter(Boolean);
}

/**
 * Finds the family prefix that starts the current model entry.
 *
 * @param {string} modelName - Model entry without a duplicated leading brand.
 * @param {string} brand - Brand name read from the current heading.
 * @returns {string | null} Matching family prefix, or null when no known prefix matches.
 */
function findFamilyPrefix(modelName, brand) {
  const familyPrefixes = FAMILY_PREFIXES_BY_BRAND.get(brand) ?? [];

  return (
    familyPrefixes.find((familyPrefix) => {
      const familyPrefixPattern = new RegExp(
        `^${escapeRegExp(familyPrefix)}(?:\\s+|$)`,
        "i",
      );

      return familyPrefixPattern.test(modelName);
    }) ?? null
  );
}

/**
 * Expands model entries that omit an obvious family prefix inside the same source paragraph.
 *
 * @param {string} brand - Brand name read from the current heading.
 * @param {string[]} entries - Model entries split from one source paragraph.
 * @returns {string[]} Model entries with known family prefixes restored.
 */
function expandFamilyPrefixes(brand, entries) {
  let activeFamilyPrefix = null;

  return entries.map((entry) => {
    const modelName = stripLeadingBrand(entry, brand);
    const familyPrefix = findFamilyPrefix(modelName, brand);

    if (familyPrefix) {
      activeFamilyPrefix = familyPrefix;
      return modelName;
    }

    // The source often writes "Galaxy A35 5G, A54 5G" or "iPhone 17, 17 Pro";
    // subsequent comma-separated entries inherit the last explicit family prefix.
    if (activeFamilyPrefix) {
      return normalizeText(`${activeFamilyPrefix} ${modelName}`);
    }

    return modelName;
  });
}

/**
 * Builds the final JSON model value with the brand always present once at the start.
 *
 * @param {string} brand - Brand name read from the current heading.
 * @param {string} modelName - Model name after source cleanup and family expansion.
 * @returns {string} Full model name written to the output JSON.
 */
function buildFullModelName(brand, modelName) {
  const modelWithoutBrand = stripLeadingBrand(modelName, brand);

  return normalizeText(
    modelWithoutBrand ? `${brand} ${modelWithoutBrand}` : brand,
  );
}

/**
 * Loads local environment variables from a gitignored .env file.
 *
 * @param {string} envPath - Absolute path to the local .env file.
 * @returns {void}
 */
function loadEnvFile(envPath) {
  let fileContent;

  try {
    fileContent = readFileSync(envPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  for (const rawLine of fileContent.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    // Shell variables and GitHub Actions secrets must win over local .env values.
    if (process.env[key] != null) {
      continue;
    }

    process.env[key] = parseEnvValue(rawValue);
  }
}

/**
 * Parses a dotenv-style value with optional single or double quotes.
 *
 * @param {string} value - Raw value read after the first equals sign.
 * @returns {string} Parsed environment variable value.
 */
function parseEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
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

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

/**
 * Reads an environment variable as an integer timeout.
 *
 * @param {string} name - Environment variable name.
 * @param {number} defaultValue - Value used when the variable is not set or invalid.
 * @returns {number} Parsed integer value.
 */
function readIntegerEnv(name, defaultValue) {
  const value = Number.parseInt(process.env[name] ?? "", 10);

  return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

/**
 * Builds Chromium launch options for local runs and GitHub Actions.
 *
 * @returns {{ headless: boolean, profilePath: string }} Browser options used by the crawler.
 */
function getRuntimeOptions() {
  const isCi = process.env.CI === "true";

  return {
    headless: readBooleanEnv("CRAWLER_HEADLESS", isCi),
    profilePath: path.join(projectRoot, PROFILE_DIR),
  };
}

/**
 * Decides which browser runtime should be used for this run.
 *
 * @returns {"browserless" | "local"} The selected crawler runtime.
 */
function getCrawlerRuntime() {
  if (CRAWLER_BROWSER === "browserless") {
    return "browserless";
  }

  if (CRAWLER_BROWSER === "local") {
    return "local";
  }

  return process.env.CI === "true" && process.env.BROWSERLESS_TOKEN
    ? "browserless"
    : "local";
}

/**
 * Builds the Browserless BrowserQL endpoint URL with the token query parameter.
 *
 * @returns {string} Full BrowserQL HTTPS endpoint.
 */
function getBrowserlessUrl() {
  if (!process.env.BROWSERLESS_TOKEN) {
    throw new Error(
      "BROWSERLESS_TOKEN is required when CRAWLER_BROWSER=browserless.",
    );
  }

  const url = new URL(BROWSERLESS_BQL_ENDPOINT);

  url.searchParams.set("token", process.env.BROWSERLESS_TOKEN);

  return url.toString();
}

/**
 * Waits until the rendered source page exposes the device list section.
 *
 * @param {import('playwright').Page} page - Playwright page containing the target website.
 * @returns {Promise<void>} Resolves when the device list heading is available.
 */
async function waitForDeviceList(page) {
  try {
    await page.waitForFunction(
      (expectedHeading) => {
        const normalize = (value) => value?.replace(/\s+/g, " ").trim() ?? "";

        return Array.from(document.querySelectorAll("h2")).some((heading) => {
          return normalize(heading.textContent).includes(expectedHeading);
        });
      },
      DEVICE_LIST_HEADING,
      { timeout: SECTION_TIMEOUT_MS },
    );
  } catch (error) {
    const pageDiagnostics = await getPageDiagnostics(page);

    throw new Error(
      `Device list section was not found within ${SECTION_TIMEOUT_MS}ms. ` +
        `Current page diagnostics: ${JSON.stringify(pageDiagnostics)}`,
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
  try {
    return page.evaluate(() => ({
      title: document.title,
      url: location.href,
      bodyStart:
        document.body?.innerText?.replace(/\s+/g, " ").trim().slice(0, 500) ??
        "",
    }));
  } catch (error) {
    // The page can be closed by the browser or the challenge layer before diagnostics are collected.
    return {
      title: "",
      url: page.url(),
      bodyStart: `Unable to collect page diagnostics: ${error.message}`,
    };
  }
}

/**
 * Extracts all supported device models from the Support Japan Travel HTML.
 *
 * @param {string} html - Rendered or static page HTML.
 * @returns {Array<{ model: string, brand: string }>} Flat list of supported device models.
 */
function extractDevicesFromHtml(html) {
  const $ = cheerio.load(html);
  const deviceListHeading = $("h2")
    .filter((_, heading) => {
      return normalizeText($(heading).text()).includes(DEVICE_LIST_HEADING);
    })
    .first();

  if (deviceListHeading.length === 0) {
    throw new Error("Device list heading was not found in HTML.");
  }

  const deviceListGroup = deviceListHeading
    .nextAll("div.wp-block-group")
    .first();

  if (deviceListGroup.length === 0) {
    throw new Error("Device list container was not found in HTML.");
  }

  const innerContainer = deviceListGroup
    .find(".wp-block-group__inner-container")
    .first();
  const deviceListContent = innerContainer.length
    ? innerContainer
    : deviceListGroup;
  const devices = [];

  deviceListContent.children("h4.wp-block-heading").each((_, brandHeading) => {
    const brand = normalizeText($(brandHeading).text());

    if (!brand) {
      return;
    }

    let cursor = $(brandHeading).next();

    while (cursor.length && cursor.prop("tagName")?.toLowerCase() !== "h4") {
      if (cursor.prop("tagName")?.toLowerCase() === "p") {
        const paragraphModels = expandFamilyPrefixes(
          brand,
          splitModelEntries(cursor.text()),
        );

        for (const paragraphModel of paragraphModels) {
          devices.push({
            model: buildFullModelName(brand, paragraphModel),
            brand,
          });
        }
      }

      cursor = cursor.next();
    }
  });

  return devices;
}

/**
 * Fails fast when the extracted data is empty or malformed.
 *
 * @param {Array<{ model: string, brand: string }>} devices - Extracted device records.
 * @returns {void}
 */
function validateDevices(devices) {
  if (!Array.isArray(devices) || devices.length === 0) {
    throw new Error("No devices were extracted from the source page.");
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
 * @param {Array<{ model: string, brand: string }>} devices - Device records to serialize.
 * @returns {Promise<void>}
 */
async function writeJsonFile(outputPath, devices) {
  const absoluteOutputPath = path.join(projectRoot, outputPath);

  await mkdir(path.dirname(absoluteOutputPath), { recursive: true });
  await writeFile(
    absoluteOutputPath,
    `${JSON.stringify(devices, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Reads an existing generated JSON file for stale fallback publishing.
 *
 * @param {string} outputPath - Existing JSON path relative to the project root.
 * @returns {Promise<Array<{ model: string, brand: string }> | null>} Existing devices, or null when unavailable.
 */
async function readExistingJsonFile(outputPath) {
  const absoluteOutputPath = path.join(projectRoot, outputPath);

  try {
    const fileContent = await readFile(absoluteOutputPath, "utf8");
    const devices = JSON.parse(fileContent);

    validateDevices(devices);

    return devices;
  } catch {
    return null;
  }
}

/**
 * Calls Browserless BrowserQL and returns the rendered page HTML after challenge solving.
 *
 * @returns {Promise<string>} Rendered page HTML returned by Browserless.
 */
async function fetchHtmlWithBrowserless() {
  const query = `
    mutation ExtractDeviceHtml($url: String!, $solveTimeout: Float!, $htmlTimeout: Float!) {
      goto(url: $url, waitUntil: domContentLoaded) {
        status
      }
      solve(timeout: $solveTimeout, wait: true) {
        found
        solved
        time
      }
      html(timeout: $htmlTimeout) {
        html
      }
    }
  `;

  const response = await fetch(getBrowserlessUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      operationName: "ExtractDeviceHtml",
      query,
      variables: {
        htmlTimeout: SECTION_TIMEOUT_MS,
        solveTimeout: BROWSERLESS_SOLVE_TIMEOUT_MS,
        url: TARGET_URL,
      },
    }),
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Browserless request failed with HTTP ${response.status}: ${responseText}`,
    );
  }

  const payload = JSON.parse(responseText);

  if (payload.errors?.length) {
    throw new Error(`Browserless BQL errors: ${JSON.stringify(payload.errors)}`);
  }

  const html = payload.data?.html?.html;

  if (!html) {
    throw new Error(`Browserless response did not include HTML: ${responseText}`);
  }

  return html;
}

/**
 * Runs Browserless BrowserQL and writes the public JSON data file.
 *
 * @returns {Promise<void>}
 */
async function crawlWithBrowserless() {
  const html = await fetchHtmlWithBrowserless();
  const devices = extractDevicesFromHtml(html);

  validateDevices(devices);
  await writeJsonFile(OUTPUT_FILE, devices);

  console.log(
    `Wrote ${devices.length} device records to ${OUTPUT_FILE} with Browserless.`,
  );
}

/**
 * Runs the local Playwright crawler and writes the public JSON data file.
 *
 * @returns {Promise<void>}
 */
async function crawlWithLocalPlaywright() {
  const runtimeOptions = getRuntimeOptions();
  const context = await chromium.launchPersistentContext(
    runtimeOptions.profilePath,
    {
      headless: runtimeOptions.headless,
      locale: BROWSER_LOCALE,
      timezoneId: "UTC",
      extraHTTPHeaders: {
        // The source site uses browser language signals and cookies to pick localized copy.
        "Accept-Language": ACCEPT_LANGUAGE,
      },
      viewport: { width: 1440, height: 1200 },
    },
  );

  try {
    const page = context.pages()[0] ?? (await context.newPage());

    page.setDefaultTimeout(SECTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

    await page.goto(TARGET_URL, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    await waitForDeviceList(page);

    const devices = extractDevicesFromHtml(await page.content());

    validateDevices(devices);
    await writeJsonFile(OUTPUT_FILE, devices);

    console.log(
      `Wrote ${devices.length} device records to ${OUTPUT_FILE}.`,
    );
  } finally {
    await context.close();
  }
}

/**
 * Runs the selected live crawler and writes the public JSON data file.
 *
 * @returns {Promise<void>}
 */
async function crawlAndWriteDevices() {
  const runtime = getCrawlerRuntime();

  console.log(`Using ${runtime} crawler runtime.`);

  if (runtime === "browserless") {
    await crawlWithBrowserless();
    return;
  }

  await crawlWithLocalPlaywright();
}

/**
 * Runs the crawler, optionally keeping a valid stale JSON file when the source blocks CI.
 *
 * @returns {Promise<void>}
 */
async function main() {
  try {
    await crawlAndWriteDevices();
  } catch (error) {
    if (!ALLOW_STALE_ON_FAILURE) {
      throw error;
    }

    const existingDevices = await readExistingJsonFile(OUTPUT_FILE);

    if (!existingDevices) {
      throw error;
    }

    console.warn(
      `Crawler failed; keeping ${existingDevices.length} existing records from ${OUTPUT_FILE}.`,
    );
    console.warn(error);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
