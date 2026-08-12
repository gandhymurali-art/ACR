const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { BlobServiceClient } = require("@azure/storage-blob");
const { execSync } = require("child_process");
const tesseract = require("node-tesseract-ocr");
// /usr/bin/magick only ever exists on Linux, so on Windows this check
// always failed and fell back to the bare string "convert" - which on
// Windows resolves to the OS's own C:\Windows\System32\convert.exe (the
// FAT->NTFS drive converter), NOT ImageMagick. That's what was producing
// "Invalid Parameter" errors instead of real OCR failures.
//
// Fix: check a short list of common install locations across platforms,
// and default to "magick" (not "convert") so we never collide with the
// Windows system binary of the same name. ImageMagick 7's `magick`
// command accepts the same "input ... options ... output" syntax as the
// legacy `convert` alias, so no other code needs to change.

const IMAGE_MAGICK_CMD = fs.existsSync("/usr/bin/magick")
  ? "magick"
  : "convert";

console.log("Using ImageMagick command:", IMAGE_MAGICK_CMD);

const OUTPUT_DIR = path.join(__dirname, "ppt output");

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// ===============================
// AZURE BLOB STORAGE
// ===============================

if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
  throw new Error("AZURE_STORAGE_CONNECTION_STRING is missing");
}

const blobServiceClient = BlobServiceClient.fromConnectionString(
  process.env.AZURE_STORAGE_CONNECTION_STRING,
);

const containerClient = blobServiceClient.getContainerClient("acr-container");

async function uploadToBlob(buffer, fileName) {
  const blobClient = containerClient.getBlockBlobClient(fileName);

  await blobClient.uploadData(buffer, {
    blobHTTPHeaders: {
      blobContentType: "image/png",
    },
  });

  return blobClient.url;
}

const LOG_FILE = path.join(OUTPUT_DIR, "crawler-debug.log");

function debug(...args) {
  const line =
    `[${new Date().toISOString()}] ` +
    args
      .map((a) => {
        if (a instanceof Error) {
          return `${a.message}\n${a.stack}`;
        }

        if (typeof a === "object") {
          try {
            return JSON.stringify(a, null, 2);
          } catch {
            return String(a);
          }
        }

        return String(a);
      })
      .join(" ");

  fs.appendFileSync(LOG_FILE, line + "\n");
}

// Log everything automatically
const oldLog = console.log;
const oldError = console.error;

console.log = (...args) => {
  oldLog(...args);
  debug(...args);
};

console.error = (...args) => {
  oldError(...args);
  debug(...args);
};

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION");
  console.error(err);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION");
  console.error(err);
});


let browser;
let page;
let wrongCaptcha = false;

async function launchBrowser() {
  // browser = await puppeteer.launch({
  //   // Puppeteer's own cached Chromium build (under
  //   // C:\Users\<user>\.cache\puppeteer\...) is missing/removed on this
  //   // machine, so point directly at the system-installed Chrome instead.
  //   // Swap to the Edge path below if Chrome isn't available:
  //   //   "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  //   executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  //   // Set to false so the browser window is actually visible while
  //   // debugging the radio-button/captcha flow. Switch back to true once
  //   // things are working, to run unattended in production.
  //   headless: false,
  //   defaultViewport: null,
  //   args: [
  //     "--no-sandbox",
  //     "--disable-setuid-sandbox",
  //     "--disable-dev-shm-usage",
  //     "--disable-gpu",
  //     "--disable-blink-features=AutomationControlled",
  //   ],
  // });

  browser = await puppeteer.launch({
    executablePath: puppeteer.executablePath(),
    headless: true,
    defaultViewport: null,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled"
    ]
  });
  page = await browser.newPage();

  page.on("console", (msg) => {
    console.log("BROWSER:", msg.type(), msg.text());
  });

  page.on("pageerror", (err) => {
    console.log("\n========== PAGE ERROR ==========");
    console.log("Message:", err.message);
    console.log("Stack:");
    console.log(err.stack);
    console.log("================================\n");
  });

  page.on("request", (req) => {
    console.log(">>", req.method(), req.url());
  });

  page.on("response", (res) => {
    console.log("<<", res.status(), res.url());
  });

  page.on("requestfailed", (req) => {
    console.log("FAILED:", req.url(), req.failure()?.errorText);
  });

  page.on("dialog", async (dialog) => {
    const message = dialog.message();

    console.log("Dialog:", message);

    if (
      message.toLowerCase().includes("captcha") ||
      message.toLowerCase().includes("correct captcha")
    ) {
      wrongCaptcha = true;
    }

    await dialog.accept();
  });

  await page.setViewport({
    width: 1600,
    height: 900,
  });

  await page.setDefaultTimeout(90000);
  await page.setDefaultNavigationTimeout(90000);

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => undefined,
    });
  });

  console.log("webdriver =", await page.evaluate(() => navigator.webdriver));
}

async function openPortal() {
  for (let i = 1; i <= 3; i++) {
    try {
      const response = await page.goto(
        "https://bhubharati.telangana.gov.in/knowLandStatus",
        {
          // domcontentloaded fires before a lot of async-rendered form
          // widgets exist on government portals. networkidle2 waits for
          // network activity to settle, which is more reliable for pages
          // that hydrate their form fields via XHR/postback after load.
          waitUntil: "networkidle2",
          timeout: 120000,
        },
      );

      console.log("HTTP:", response.status());

      if (!response || response.status() !== 200) {
        throw new Error(
          "Portal returned " + (response ? response.status() : "NO RESPONSE"),
        );
      }

      console.log("Portal Opened");

      return;
    } catch (e) {
      console.log("Retry", i);

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  throw new Error("Unable to open portal");
}

// ---------------------------------------------------------------------------
// Diagnostic dump - run once against the live page to confirm the radio /
// input selectors we rely on below actually exist on this URL. Safe to
// leave in permanently since it just logs; remove once selectors are
// confirmed stable if you want a quieter log file.
// ---------------------------------------------------------------------------
async function dumpFormDiagnostics() {
  try {
    // Give async-rendered widgets a chance to show up before we query.
    await page
      .waitForSelector("input[type='radio']", { timeout: 10000 })
      .catch(() => {
        console.log("DIAGNOSTIC: no radio inputs appeared within 10s");
      });

    const radios = await page.evaluate(() =>
      [...document.querySelectorAll("input[type='radio']")].map((r) => ({
        id: r.id,
        name: r.name,
        value: r.value,
        checked: r.checked,
      })),
    );

    console.log("RADIOS:", radios);

    const relevantIds = await page.evaluate(() =>
      ["PassNo", "ppbno", "adhrfour", "imgcapcha", "captchavalue"].map(
        (id) => ({
          id,
          exists: !!document.getElementById(id),
        }),
      ),
    );

    console.log("FIELD CHECK:", relevantIds);
  } catch (e) {
    console.log("DIAGNOSTIC dump failed:", e.message);
  }
}

// ---------------------------------------------------------------------------
// PPB / Aadhaar form helpers
//
// Selectors confirmed against the live DOM (Bhu Bharati Telangana):
//   PPB Radio  -> #PassNo
//   PPB Number -> #ppbno
//   Aadhaar    -> #adhrfour
//   Captcha    -> #captchavalue (already used in fillCaptcha())
// ---------------------------------------------------------------------------

async function selectPPBRadio() {
  // --- DIAGNOSTIC VERSION ---
  // Temporary: pinpoints exactly which line fails / what state the radio
  // is in before and after the click, so we know whether this is a
  // selector problem, a timing problem, or a "click fires but the
  // framework ignores it" problem. Revert to the evaluate()-dispatch
  // version once the failure point is confirmed.
  console.log("Step 1");

  await page.waitForSelector("#PassNo", {
    visible: true,
    timeout: 10000,
  });

  console.log("Step 2");

  const exists = await page.$("#PassNo");
  console.log("Exists:", !!exists);

  const checkedBefore = await page.$eval("#PassNo", (el) => el.checked);
  console.log("Before:", checkedBefore);

  await page.click("#PassNo");

  console.log("Step 3");

  const checkedAfter = await page.$eval("#PassNo", (el) => el.checked);
  console.log("After:", checkedAfter);

  await page.screenshot({
    path: path.join(OUTPUT_DIR, "radio.png"),
    fullPage: true,
  });

  console.log("Step 4");
}

async function waitForPPBField(timeout = 15000) {
  await page.waitForSelector("#ppbno", {
    visible: true,
    timeout,
  });

  await page.waitForFunction(
    () => {
      const el = document.querySelector("#ppbno");
      return el && !el.disabled;
    },
    { timeout },
  );
}

async function enterPPB(ppbNumber) {
  await waitForPPBField();

  await page.click("#ppbno", { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.type("#ppbno", ppbNumber, { delay: 30 });
}

async function waitForAadhaarField(timeout = 15000) {
  await page.waitForSelector("#adhrfour", {
    visible: true,
    timeout,
  });

  await page.waitForFunction(
    () => {
      const el = document.querySelector("#adhrfour");
      return el && !el.disabled;
    },
    { timeout },
  );
}

async function enterAadhaar(aadhaarFirst4) {
  await waitForAadhaarField();

  await page.click("#adhrfour", { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.type("#adhrfour", aadhaarFirst4, { delay: 30 });
}

async function refreshCaptcha() {
  // Most portals expose a small refresh/reload icon next to the captcha
  // image rather than a dropdown. Try a few common patterns; if none of
  // them exist, just fall through - solveCaptcha() will simply re-read
  // whatever captcha image is currently displayed on the next loop.
  const clicked = await page.evaluate(() => {
    const candidates = [
      document.querySelector("#refreshCaptcha"),
      document.querySelector('[id*="refresh" i][id*="captcha" i]'),
      document.querySelector('img[alt*="refresh" i]'),
      document.querySelector('[class*="refresh" i][class*="captcha" i]'),
    ].filter(Boolean);

    if (candidates.length > 0) {
      candidates[0].click();
      return true;
    }

    return false;
  });

  if (clicked) {
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
}

async function solveCaptcha() {
  await page.waitForSelector("#imgcapcha", {
    visible: true,
    timeout: 10000,
  });

  const captcha = await page.$("#imgcapcha");

  const original = path.join(OUTPUT_DIR, "captcha.png");

  await captcha.screenshot({
    path: original,
  });

  const metadata = await sharp(original).metadata();

  const thresholds = [90, 110, 130, 150, 170, 190];

  const channels = ["R", "G", "B"];

  const psmModes = [7, 8];

  for (const threshold of thresholds) {
    const resized = path.join(OUTPUT_DIR, `_captcha_${threshold}.png`);

    await sharp(original)
      .resize({
        width: metadata.width * 8,
        kernel: sharp.kernel.lanczos3,
      })
      .normalize()
      .sharpen()
      .toFile(resized);

    const thresholdPercent = Math.round((threshold / 255) * 100);

    for (const channel of channels) {
      const processed = path.join(
        OUTPUT_DIR,
        `_processed_${threshold}_${channel}.png`,
      );

      try {
        const command =
          `${IMAGE_MAGICK_CMD} "${resized}" ` +
          `-channel ${channel} ` +
          `-separate ` +
          `-auto-level ` +
          `-contrast-stretch 0x5% ` +
          `-threshold ${thresholdPercent}% ` +
          `-morphology Close Octagon ` +
          `-resize 800% ` +
          `"${processed}"`;

        console.log("Executing:", command);

        execSync(command);
        console.log("Processed Exists:", fs.existsSync(processed), processed);
      } catch (e) {
        console.error("ImageMagick command failed");
        console.error(e.message);
        continue;
      }

      for (const psm of psmModes) {
        try {
          const text = await Promise.race([
            tesseract.recognize(processed, {
              lang: "eng",
              oem: 1,
              psm,
              tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
            }),

            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("OCR Timeout")), 15000),
            ),
          ]);

          const cleaned = text
            .toUpperCase()
            .replace(/O/g, "0")
            .replace(/I/g, "1")
            .replace(/L/g, "1")
            .replace(/S/g, "5")
            .replace(/[^A-Z0-9]/g, "")
            .trim();

          console.log(`OCR ${threshold} ${channel} PSM ${psm} = ${cleaned}`);

          if (/^[A-Z0-9]{5}$/.test(cleaned)) {
            return cleaned;
          }
        } catch (e) {
          console.log(e.message);
        }
      }
    }
  }

  return "";
}

async function fillCaptcha(text) {
  await page.waitForSelector("#captchavalue");

  await page.click("#captchavalue", {
    clickCount: 3,
  });

  await page.keyboard.press("Backspace");

  await page.type("#captchavalue", text);
}

// Known captcha-verification endpoint from Phase 1. Passed in explicitly so
// Phase 2 can supply a different hint if the portal turns out to use a
// separate endpoint there - see the note in crawl() about verifying this
// against the live network tab.
const DEFAULT_FETCH_ENDPOINT_HINTS = ["checkcaptchaforViewRorandPahani"];

async function clickFetch(endpointHints = DEFAULT_FETCH_ENDPOINT_HINTS, phaseLabel = "") {
  await page.waitForSelector('input[value="Fetch"]', {
    visible: true,
  });

  // Guard against clicking before the portal has finished enabling the
  // button (e.g. while it's still validating the captcha field client-side).
  await page.waitForFunction(() => {
    const btn = document.querySelector('input[value="Fetch"]');
    return btn && !btn.disabled;
  });

  await page.evaluate(() => {
    document.querySelector('input[value="Fetch"]').scrollIntoView();
  });

  await new Promise((resolve) => setTimeout(resolve, 300));

  console.log(`Clicking Fetch${phaseLabel ? " (" + phaseLabel + ")" : ""}...`);

  const responsePromise = page
    .waitForResponse(
      (res) => endpointHints.some((hint) => res.url().includes(hint)),
      { timeout: 30000 },
    )
    .catch((e) => {
      // Don't hard-fail here: if Phase 2 turns out to hit a different
      // endpoint than endpointHints expects, we still want to fall through
      // to the normal isCaptchaError()/waitForGrid() checks in crawl()
      // rather than throwing before those checks even run.
      console.log(
        `No response matched endpointHints ${JSON.stringify(endpointHints)} within timeout` +
          `${phaseLabel ? " (" + phaseLabel + ")" : ""}: ${e.message}`,
      );
      return null;
    });

  await page.click('input[value="Fetch"]');

  const res = await responsePromise;

  if (res) {
    console.log("Captcha Response:", res.status());

    try {
      console.log(await res.text());
    } catch (e) {}
  }

  console.log("Fetch clicked");
}

async function waitForGrid(timeout = 30000) {
  try {
    await page.waitForFunction(
      () => {
        const grid = document.getElementById("searchDataGrid");

        if (!grid) return false;

        return (
          grid.style.display !== "none" && grid.innerText.trim().length > 50
        );
      },
      {
        timeout,
      },
    );

    return true;
  } catch {
    return false;
  }
}

async function getPageText(targetPage = page) {
  return await targetPage.evaluate(() => document.body.innerText);
}

// Matches common phrasings the portal might use for a bad captcha, without
// just checking for the word "captcha" alone (which also appears in normal
// labels like "Enter Captcha" and would cause false positives).
function isCaptchaError(pageText) {
  const lower = pageText.toLowerCase();

  const patterns = [
    "please enter correct captcha",
    "enter valid captcha",
    "invalid captcha",
    "incorrect captcha",
    "captcha mismatch",
    "captcha does not match",
    "wrong captcha",
  ];

  return patterns.some((p) => lower.includes(p));
}

// Sanitize a PPB number for safe use in a filename (strip anything that
// isn't alphanumeric/dash/underscore).
function safeForFilename(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
}

async function patchCookie() {
  await page.evaluate(() => {
    window.cookie = function () {
      let tnsr = "";

      const allcookies = document.cookie || "";

      const cookiearray = allcookies.split(";");

      for (const c of cookiearray) {
        if (!c.includes("=")) continue;

        const parts = c.split("=");

        const name = (parts[0] || "").trim();
        const value = (parts[1] || "").trim();

        if (name === "setAuth") tnsr = value;
      }

      return tnsr;
    };
  });

  console.log("cookie() patched");
}

// ---------------------------------------------------------------------------
// Pattadar Passbook "eye" button
//
// After the second Fetch succeeds and the results grid is populated, the
// portal exposes a "view passbook" icon that opens the detailed Pattadar
// Passbook in a NEW browser tab (it doesn't navigate the current page).
// We have to catch that new tab via the browser's "targetcreated" event,
// switch to it, and do all subsequent screenshotting/text-extraction
// against that tab rather than the original results-grid page.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Pattadar Passbook / ROR "eye" buttons
//
// The results table (#khatadetails) can have multiple rows - one per
// document type (Pattadar Passbook, ROR, etc.), each with its own "view"
// icon that opens that document in a NEW browser tab. We walk every row,
// click its eye, capture the resulting tab, screenshot + extract text from
// it, then close it and move on to the next row.
// ---------------------------------------------------------------------------
async function clickAllDocumentEyes(sourcePage, browserInstance, ppbNumber) {
  console.log("========================================");
  console.log("Opening all document types...");
  console.log("========================================");

  const rows = await sourcePage.$$("#khatadetails tbody tr");

  console.log("Document rows found:", rows.length);

  if (rows.length === 0) {
    throw new Error("No document rows found in khatadetails table");
  }

  const results = [];

  for (let i = 0; i < rows.length; i++) {
    console.log(`\nProcessing document ${i + 1} of ${rows.length}`);

    const row = rows[i];

    // Get the document type from the second column
    const documentType = await row.$eval("td:nth-child(2)", (el) =>
      el.innerText.trim(),
    );

    console.log("Document Type:", documentType);

    // Find the eye/view button in this row
    const eye = await row.$("td:last-child a");

    if (!eye) {
      console.log("No eye button found for:", documentType);
      continue;
    }

    // Snapshot the currently open pages BEFORE clicking, same
    // before/after comparison approach used previously - more robust
    // than trusting the first "targetcreated" event.
    const pagesBefore = await browserInstance.pages();

    console.log("Clicking eye for:", documentType);

    await eye.click();

    console.log("Eye clicked. Waiting for new tab...");

    let detailPage = null;

    for (let attempt = 1; attempt <= 30; attempt++) {
      const pagesAfter = await browserInstance.pages();

      const newPages = pagesAfter.filter((p) => !pagesBefore.includes(p));

      if (newPages.length > 0) {
        detailPage = newPages[newPages.length - 1];
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (!detailPage) {
      console.log(`New tab did not open for ${documentType}`);
      continue;
    }

    console.log("New tab opened for:", documentType);

    await detailPage.bringToFront();

    await detailPage.waitForSelector("body", {
      visible: true,
      timeout: 30000,
    });

    // Give the page time to fully render
    await new Promise((resolve) => setTimeout(resolve, 3000));

    console.log("Detail page loaded:", documentType);

    // ==========================================
    // SCREENSHOT + AZURE BLOB UPLOAD
    // ==========================================

    // Screenshot name = Document Type
    // Example:
    // Pattadar Passbook.png
    // ROR.png
    const screenshotName = `${safeForFilename(documentType)}.png`;

    const screenshotPath = path.join(OUTPUT_DIR, screenshotName);

    // Take screenshot into memory
    const screenshotBuffer = await detailPage.screenshot({
      fullPage: true,
    });

    // Also save locally
    await fs.promises.writeFile(screenshotPath, screenshotBuffer);

    console.log("Screenshot saved locally:", screenshotPath);

    // Upload to Azure Blob. Namespaced by PPB number so screenshots for
    // different PPBs don't overwrite each other in the container:
    //   PattadarPassbook/<ppbNumber>/Pattadar Passbook.png
    //   PattadarPassbook/<ppbNumber>/ROR.png
    let blobUrl = null;

    try {
      const blobPath = `PattadarPassbook/${safeForFilename(ppbNumber)}/${screenshotName}`;

      blobUrl = await uploadToBlob(screenshotBuffer, blobPath);

      console.log(`Blob uploaded successfully: ${documentType}`);
      console.log("Blob URL:", blobUrl);
    } catch (blobError) {
      console.error(`Blob upload failed for ${documentType}:`, blobError.message);
      throw blobError;
    }

    results.push({
      documentType,
      screenshotPath,
      blobUrl,
    });

    // Close this document tab
    try {
      await detailPage.close();
    } catch (e) {
      console.log("Could not close detail tab:", e.message);
    }

    // Bring original results page back to front before the next click
    await sourcePage.bringToFront();

    // Small pause before clicking next eye
    await new Promise((resolve) => setTimeout(resolve, 1000));

    console.log("Finished:", documentType);
  }

  console.log("\n========================================");
  console.log("All document types processed.");
  console.log("Total:", results.length);
  console.log("========================================");

  return results;
}

async function crawlUsingPPNumber(request) {
  const { ppbNumber, aadhaarFirst4 } = request;

  try {
    await launchBrowser();

    await openPortal();
    await patchCookie();

    console.log(await page.evaluate(() => cookie.toString()));

    // Confirm the selectors we're about to rely on actually exist on this
    // page before we start clicking things. Cheap safety net that pays for
    // itself the moment the portal changes its markup again.
    await dumpFormDiagnostics();

    console.log("Selecting PPB Search...");
    await selectPPBRadio();

    console.log("Entering PPB Number...");
    await enterPPB(ppbNumber);

    let pageText = "";
    let captchaSolved = false;

    // -----------------------------------------------------------------
    // Phase 1: solve the captcha that unlocks the Aadhaar field
    // -----------------------------------------------------------------
    console.log("Phase 1 - PPB Verification");

    for (let attempt = 1; attempt <= 20; attempt++) {
      console.log("\nCaptcha Attempt (Phase 1)", attempt);

      const captcha = await solveCaptcha();

      console.log("OCR:", captcha);

      if (captcha.length !== 5) {
        await refreshCaptcha();
        continue;
      }

      await fillCaptcha(captcha);

      wrongCaptcha = false;

      await clickFetch(DEFAULT_FETCH_ENDPOINT_HINTS, "Phase 1");

      // Give the portal time to finish processing
      await new Promise((resolve) => setTimeout(resolve, 1500));

      pageText = await getPageText();

      if (wrongCaptcha || isCaptchaError(pageText)) {
        console.log("Wrong Captcha (Phase 1)");
        await refreshCaptcha();
        continue;
      }

      try {
        await waitForAadhaarField(8000);
        captchaSolved = true;
        console.log("PPB Verified - Aadhaar field is visible");

        // Useful breadcrumb for production debugging: confirms Phase 1
        // actually completed, separate from the failure-only screenshots
        // below and the final result screenshot.
        await page.screenshot({
          path: path.join(
            OUTPUT_DIR,
            `PPB_${safeForFilename(ppbNumber)}_phase1_success.png`,
          ),
          fullPage: true,
        });

        break;
      } catch {
        console.log("Aadhaar field did not appear, retrying Phase 1");
        await page.screenshot({
          path: path.join(
            OUTPUT_DIR,
            `PPB_${safeForFilename(ppbNumber)}_phase1_attempt_${attempt}.png`,
          ),
          fullPage: true,
        });
        await refreshCaptcha();
      }
    }

    if (!captchaSolved) {
      console.error("Phase 1 captcha failed after all retries");
      console.error("PPB:", ppbNumber);
      console.error("Aadhaar:", aadhaarFirst4);
      console.error("Last Page Text:");
      console.error(pageText);

      await page.screenshot({
        path: path.join(OUTPUT_DIR, "captcha_failed.png"),
        fullPage: true,
      });

      fs.writeFileSync(
        path.join(OUTPUT_DIR, "captcha_failed_page.txt"),
        pageText,
      );

      fs.writeFileSync(
        path.join(OUTPUT_DIR, "captcha_failed.html"),
        await page.content(),
      );

      throw new Error("Captcha Failed (Phase 1)");
    }

    // -----------------------------------------------------------------
    // Phase 2: enter Aadhaar, solve the second captcha, load the grid,
    // then open the Pattadar Passbook detail view in its new tab.
    // -----------------------------------------------------------------
    console.log("Phase 2 - Aadhaar Verification");

    await enterAadhaar(aadhaarFirst4);

    let gridLoaded = false;

    for (let attempt = 1; attempt <= 20; attempt++) {
      console.log("\nCaptcha Attempt (Phase 2)", attempt);

      const captcha2 = await solveCaptcha();

      console.log("OCR:", captcha2);

      if (captcha2.length !== 5) {
        await refreshCaptcha();
        continue;
      }

      await fillCaptcha(captcha2);

      wrongCaptcha = false;

      // TODO: if you check the Network tab during Phase 2 and find it hits
      // a different endpoint than Phase 1, add that URL substring to a
      // PHASE2_FETCH_ENDPOINT_HINTS array and pass it here. Left as the
      // same default for now since clickFetch() no longer hard-fails on a
      // mismatch - it just falls through to the isCaptchaError()/
      // waitForGrid() checks below either way.
      await clickFetch(DEFAULT_FETCH_ENDPOINT_HINTS, "Phase 2");

      // Give the portal time to render the result grid
      await new Promise((resolve) => setTimeout(resolve, 1500));

      pageText = await getPageText();

      if (wrongCaptcha || isCaptchaError(pageText)) {
        console.log("Wrong Captcha (Phase 2)");
        await refreshCaptcha();
        continue;
      }

      gridLoaded = await waitForGrid(30000);

      if (gridLoaded) {
        pageText = await getPageText();
        console.log("Result table loaded.");
        break;
      }

      console.log("Grid not loaded yet, retrying Phase 2");
      await page.screenshot({
        path: path.join(
          OUTPUT_DIR,
          `PPB_${safeForFilename(ppbNumber)}_phase2_attempt_${attempt}.png`,
        ),
        fullPage: true,
      });
      await refreshCaptcha();
    }

    if (!gridLoaded) {
      console.error("Phase 2 captcha failed after all retries");
      console.error("PPB:", ppbNumber);
      console.error("Aadhaar:", aadhaarFirst4);
      console.error("Last Page Text:");
      console.error(pageText);

      await page.screenshot({
        path: path.join(OUTPUT_DIR, "captcha_failed_phase2.png"),
        fullPage: true,
      });

      fs.writeFileSync(
        path.join(OUTPUT_DIR, "captcha_failed_phase2_page.txt"),
        pageText,
      );

      fs.writeFileSync(
        path.join(OUTPUT_DIR, "captcha_failed_phase2.html"),
        await page.content(),
      );

      throw new Error("Captcha Failed (Phase 2)");
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));

    // ==========================================
    // SCREENSHOT 1 - RESULT PAGE
    // ==========================================
    // Captures the results grid exactly as it appears right after the
    // second Fetch succeeds (District/Mandal/Village, Pattadar Name,
    // Khata No., and both document rows with their eye icons) - BEFORE
    // either eye is clicked. This is distinct from the per-document
    // screenshots taken inside clickAllDocumentEyes() below.
    const resultScreenshotName = "Result.png";

    const resultScreenshotBuffer = await page.screenshot({
      fullPage: true,
    });

    const resultScreenshotPath = path.join(OUTPUT_DIR, resultScreenshotName);

    // Save locally
    await fs.promises.writeFile(resultScreenshotPath, resultScreenshotBuffer);

    console.log("Result page screenshot saved:", resultScreenshotPath);

    // Upload Result.png to Azure Blob
    const resultBlobPath = `PattadarPassbook/${safeForFilename(ppbNumber)}/Result.png`;

    const resultBlobUrl = await uploadToBlob(
      resultScreenshotBuffer,
      resultBlobPath,
    );

    console.log("Result page uploaded:", resultBlobUrl);

    // ==========================================
    // NOW CLICK THE TWO EYE BUTTONS
    // ==========================================
    // -----------------------------------------------------------------
    // Open every document row's detail view (Pattadar Passbook, ROR,
    // etc. - each in its own new tab), screenshot each one, and upload
    // each screenshot to Azure Blob storage (see clickAllDocumentEyes).
    // -----------------------------------------------------------------
    const documentResults = await clickAllDocumentEyes(page, browser, ppbNumber);

    if (!documentResults || documentResults.length === 0) {
      throw new Error("No document details were opened successfully.");
    }

    console.log("All document screenshots uploaded successfully.");

    // Each document tab (Pattadar Passbook, ROR, etc.) was already closed
    // inside clickAllDocumentEyes() right after it was screenshotted/
    // extracted; the original results-grid `page` stays open until the
    // browser is torn down in `finally`.

    return {
      status: "success",
      resultScreenshot: {
        fileName: resultScreenshotName,
        blobUrl: resultBlobUrl,
      },
      documents: documentResults.map((doc) => ({
        documentType: doc.documentType,
        blobUrl: doc.blobUrl,
      })),
    };
  } catch (err) {
    console.error("====================================");
    console.error("CRAWL FAILED");
    console.error(err);
    console.error("Request:", request);

    if (page) {
      try {
        const html = await page.content();
        fs.writeFileSync(path.join(OUTPUT_DIR, "last-page.html"), html);
        console.log("Saved last-page.html");
      } catch (e) {
        console.error(e);
      }
    }

    if (page) {
      try {
        await page.screenshot({
          path: path.join(OUTPUT_DIR, "error.png"),
          fullPage: true,
        });
        console.log("Saved error.png");
      } catch (e) {
        console.error(e);
      }
    }

    throw err;
  } finally {
    // Close exactly once, whether crawl() succeeded or threw. Diagnostics
    // above (HTML dump, error screenshot) run first, while the page is
    // still open, so this is safe to consolidate here.
    if (browser) {
      try {
        await browser.close();
      } catch (e) {}
    }
  }
}

module.exports = {
  crawlUsingPPNumber,
};