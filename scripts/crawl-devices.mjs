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

const TARGET_URL = "https://saily.com/esim-supported-devices/";
const OUTPUT_FILE = "public/devices.json";
const PROFILE_DIR = ".cache/device-crawler-profile-en";
const BROWSER_LOCALE = "en-US";
const ACCEPT_LANGUAGE = "en-US,en;q=0.9";
const BROWSERLESS_BQL_ENDPOINT =
  process.env.BROWSERLESS_BQL_ENDPOINT ??
  "https://production-sfo.browserless.io/stealth/bql";
const SMARTPHONE_SECTION_HEADINGS = ["Smartphone", "Smartphones"];
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
 * Waits until the rendered source page exposes the Smartphone section.
 *
 * @param {import('playwright').Page} page - Playwright page containing the target website.
 * @returns {Promise<void>} Resolves when the Smartphone heading is available.
 */
async function waitForSmartphoneSection(page) {
  try {
    await page.waitForFunction(
      (expectedHeadings) => {
        const normalize = (value) => value?.replace(/\s+/g, " ").trim() ?? "";

        return Array.from(document.querySelectorAll("h2")).some((heading) => {
          return expectedHeadings.includes(normalize(heading.textContent));
        });
      },
      SMARTPHONE_SECTION_HEADINGS,
      { timeout: SECTION_TIMEOUT_MS },
    );
  } catch (error) {
    const pageDiagnostics = await getPageDiagnostics(page);

    throw new Error(
      `Smartphone section was not found within ${SECTION_TIMEOUT_MS}ms. ` +
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
 * Extracts all smartphone models from the rendered source accordion.
 *
 * @param {import('playwright').Page} page - Playwright page with the loaded target website.
 * @returns {Promise<Array<{ model: string, brand: string }>>} Flat list of supported smartphone models.
 */
async function extractSmartphones(page) {
  return page.evaluate((expectedHeadings) => {
    const normalize = (value) => value?.replace(/\s+/g, " ").trim() ?? "";
    const smartphoneHeading = Array.from(document.querySelectorAll("h2")).find(
      (heading) => {
        return expectedHeadings.includes(normalize(heading.textContent));
      },
    );

    if (!smartphoneHeading) {
      throw new Error("Smartphone section heading was not found.");
    }

    // The active device category is contained by a ".pt-6" wrapper; sibling categories are hidden.
    const smartphoneSection = smartphoneHeading.closest(".pt-6");

    if (!smartphoneSection) {
      throw new Error("Smartphone section container was not found.");
    }

    const devices = [];
    const accordionItems = Array.from(smartphoneSection.querySelectorAll("li"));

    for (const accordionItem of accordionItems) {
      const brand = normalize(
        accordionItem.querySelector(":scope > button h3")?.textContent ??
          accordionItem.querySelector(":scope > button")?.textContent,
      );

      if (!brand) {
        continue;
      }

      const models = Array.from(
        accordionItem.querySelectorAll(":scope > section li"),
      )
        .map((modelItem) => normalize(modelItem.textContent))
        .filter(Boolean);

      for (const model of models) {
        devices.push({ model, brand });
      }
    }

    return devices;
  }, SMARTPHONE_SECTION_HEADINGS);
}

/**
 * Extracts all smartphone models from rendered HTML returned by Browserless.
 *
 * @param {string} html - Rendered page HTML.
 * @returns {Array<{ model: string, brand: string }>} Flat list of supported smartphone models.
 */
function extractSmartphonesFromHtml(html) {
  const $ = cheerio.load(html);
  const smartphoneHeading = $("h2")
    .filter((_, heading) => {
      return SMARTPHONE_SECTION_HEADINGS.includes(
        normalizeText($(heading).text()),
      );
    })
    .first();

  if (smartphoneHeading.length === 0) {
    throw new Error("Smartphone section heading was not found in HTML.");
  }

  // The active device category is contained by a ".pt-6" wrapper; sibling categories are hidden.
  const smartphoneSection = smartphoneHeading.closest(".pt-6");

  if (smartphoneSection.length === 0) {
    throw new Error("Smartphone section container was not found in HTML.");
  }

  const devices = [];

  smartphoneSection.find("li").each((_, accordionItem) => {
    const item = $(accordionItem);
    const button = item.children("button").first();
    const brand = normalizeText(button.find("h3").first().text() || button.text());

    if (!brand) {
      return;
    }

    item
      .children("section")
      .find("li")
      .each((__, modelItem) => {
        const model = normalizeText($(modelItem).text());

        if (model) {
          devices.push({ model, brand });
        }
      });
  });

  return devices;
}

/**
 * Fails fast when the extracted data is empty or malformed.
 *
 * @param {Array<{ model: string, brand: string }>} devices - Extracted smartphone device records.
 * @returns {void}
 */
function validateSmartphones(devices) {
  if (!Array.isArray(devices) || devices.length === 0) {
    throw new Error(
      "No smartphone devices were extracted from the source page.",
    );
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

    validateSmartphones(devices);

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
  const devices = extractSmartphonesFromHtml(html);

  validateSmartphones(devices);
  await writeJsonFile(OUTPUT_FILE, devices);

  console.log(
    `Wrote ${devices.length} smartphone records to ${OUTPUT_FILE} with Browserless.`,
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
    await waitForSmartphoneSection(page);

    const devices = await extractSmartphones(page);

    validateSmartphones(devices);
    await writeJsonFile(OUTPUT_FILE, devices);

    console.log(
      `Wrote ${devices.length} smartphone records to ${OUTPUT_FILE}.`,
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
