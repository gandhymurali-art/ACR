const IMAGE_MAGICK_CMD = fs.existsSync("/usr/bin/magick")
  ? "magick"
  : "convert";

console.log("Using ImageMagick command:", IMAGE_MAGICK_CMD);
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { execSync } = require("child_process");
const tesseract = require("node-tesseract-ocr");
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION");
  console.error(err);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION");
  console.error(err);
});

const LOG_FILE = path.join(__dirname, "crawler-debug.log");

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

const OUTPUT_DIR = __dirname;

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

let browser;
let page;
let wrongCaptcha = false;

async function launchBrowser() {
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
    console.log("REQ:", req.method(), req.url());
  });

  page.on("response", (res) => {
    console.log("RES:", res.status(), res.url());
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
          waitUntil: "domcontentloaded",
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

async function waitForSelect(index, min = 2) {
  await page.waitForFunction(
    (idx, count) => {
      const selects = document.querySelectorAll("select");

      if (!selects[idx]) return false;

      return selects[idx].options.length >= count;
    },

    {},

    index,

    min,
  );
}

async function selectByValue(index, value) {
  await page.evaluate(
    (idx, val) => {
      const select = document.querySelectorAll("select")[idx];

      select.value = val;

      select.dispatchEvent(
        new Event("change", {
          bubbles: true,
        }),
      );
    },

    index,

    value,
  );
}

async function selectByText(index, text) {
  const value = await page.evaluate(
    (idx, txt) => {
      const select = document.querySelectorAll("select")[idx];

      if (!select) return null;

      const option = [...select.options].find((x) =>
        x.text.trim().toLowerCase().includes(txt.toLowerCase()),
      );

      return option ? option.value : null;
    },

    index,

    text,
  );

  if (!value) {
    throw new Error(text + " not found");
  }

  await selectByValue(index, value);

  return value;
}

async function selectSecondOption(index) {
  const value = await page.evaluate((idx) => {
    const select = document.querySelectorAll("select")[idx];

    if (!select) return null;

    if (select.options.length < 2) return null;

    return select.options[1].value;
  }, index);

  if (!value) {
    throw new Error("Second option not found");
  }

  await selectByValue(index, value);

  return value;
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
        console.log(
          "Processed Exists:",
          fs.existsSync(processed),
          processed
        );
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

async function clickFetch() {
  await page.waitForSelector('input[value="Fetch"]', {
    visible: true,
  });

  await page.evaluate(() => {
    document.querySelector('input[value="Fetch"]').scrollIntoView();
  });

  await new Promise((resolve) => setTimeout(resolve, 300));

  console.log("Clicking Fetch...");

  const responsePromise = page.waitForResponse(
    (res) => res.url().includes("checkcaptchaforViewRorandPahani"),
    { timeout: 30000 },
  );

  await page.click('input[value="Fetch"]');

  const res = await responsePromise;

  console.log("Captcha Response:", res.status());

  try {
    console.log(await res.text());
  } catch (e) { }

  console.log("Fetch clicked");
}
async function refreshKhata() {
  await page.evaluate(() => {
    const select = document.querySelectorAll("select")[4];

    if (!select) return;

    select.dispatchEvent(
      new Event("change", {
        bubbles: true,
      }),
    );
  });

  await new Promise((resolve) => setTimeout(resolve, 1500));
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

async function getPageText() {
  return await page.evaluate(() => document.body.innerText);
}

function getValue(text, label) {
  const lines = text.split("\n").map((x) => x.trim());

  const index = lines.findIndex((x) => x.toLowerCase() === label.toLowerCase());

  if (index >= 0 && index + 1 < lines.length) {
    return lines[index + 1];
  }

  return "";
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

async function crawl(request) {
  const {
    district,
    mandal,
    village,
    surveyNumber,
    khataNumber
  } = request;

  try {
    await launchBrowser();

    await openPortal();
    await patchCookie();


    console.log(await page.evaluate(() => cookie.toString()));

    console.log("Selecting District...");

    await waitForSelect(0);

    // await selectByValue(0, "13");
    await selectByValue(0, district);

    await waitForSelect(1);

    console.log("Selecting Mandal...");

    // await selectByText(1, "Adilabad (Rural)");
    await selectByText(1, mandal);

    await waitForSelect(2);

    console.log("Selecting Village...");

    // await selectByText(2, "Ankapoor");
    await selectByText(2, village);

    await waitForSelect(3);

    console.log("Selecting Survey...");

    // const surveyText = "2/1";
    const surveyText = surveyNumber;

    await selectByText(3, surveyText);

    await waitForSelect(4);

    console.log("Selecting Khata...");

    const khataValue = await selectSecondOption(4);

    console.log("Khata Selected:", khataValue);

    let pageText = "";

    let captchaSolved = false;

    for (let attempt = 1; attempt <= 20; attempt++) {
      console.log("\nCaptcha Attempt", attempt);

      const captcha = await solveCaptcha();

      console.log("OCR:", captcha);

      if (captcha.length !== 5) {
        await refreshKhata();

        continue;
      }

      await fillCaptcha(captcha);

      wrongCaptcha = false;

      await clickFetch();

      // Give the portal time to finish processing
      await new Promise((resolve) => setTimeout(resolve, 1500));

      pageText = await getPageText();

      if (wrongCaptcha || pageText.includes("Please enter correct Captcha")) {
        console.log("Wrong Captcha");

        await refreshKhata();

        continue;
      }

      captchaSolved = await waitForGrid(10000);

      if (!captchaSolved) {
        console.log("Still waiting for result...");

        captchaSolved = await waitForGrid(20000);
      }

      if (captchaSolved) {

        console.log("Captcha Solved");

        await page.waitForFunction(() => {
          const grid = document.getElementById("searchDataGrid");
          return grid &&
            grid.innerText &&
            grid.innerText.trim().length > 100;
        }, { timeout: 30000 });

        await new Promise(resolve => setTimeout(resolve, 2000));

        pageText = await getPageText();

        console.log("========== PAGE ==========");
        console.log(pageText);
        console.log("==========================");

        break;
      }

      console.log("No grid returned");

      await page.screenshot({
        path: path.join(OUTPUT_DIR, `attempt_${attempt}.png`),
        fullPage: true,
      });

      console.log(await page.evaluate(() => document.body.innerText));

      await refreshKhata();
    }

    if (!captchaSolved) {

      console.error("Captcha failed after all retries");

      console.error("District:", district);
      console.error("Mandal:", mandal);
      console.error("Village:", village);
      console.error("Survey:", surveyNumber);
      console.error("Khata:", khataValue);

      console.error("Last Page Text:");
      console.error(pageText);

      await page.screenshot({
        path: path.join(__dirname, "captcha_failed.png"),
        fullPage: true,
      });

      fs.writeFileSync(
        path.join(__dirname, "captcha_failed_page.txt"),
        pageText
      );

      fs.writeFileSync(
        path.join(__dirname, "captcha_failed.html"),
        await page.content()
      );

      throw new Error("Captcha Failed");
    }

    console.log("Result Loaded");
    await new Promise(resolve => setTimeout(resolve, 5000));

    fs.writeFileSync(
      path.join(OUTPUT_DIR, "page.txt"),

      pageText,

      "utf8",
    );

    const row = {
      District: getValue(pageText, "District"),

      Mandal: getValue(pageText, "Mandal"),

      Village: getValue(pageText, "Village"),

      "Survey No": surveyText,

      "Pattadar Name": getValue(pageText, "Pattadar / Authorised Person Name"),

      "Father/Husband": getValue(pageText, "Father / Husband's Name"),

      "Khata Number": getValue(pageText, "Khata Number"),

      "PPB Number": getValue(pageText, "PPB Number"),

      "eKYC Status": getValue(pageText, "eKYC Status"),

      "Total Extent": getValue(pageText, "Total Extent (Ac. Gts)"),

      "Land Status": getValue(pageText, "Land Status"),

      "Nature of Land": getValue(pageText, "Nature of Land"),

      Classification: getValue(pageText, "Classification of Land"),

      "Land Type": getValue(pageText, "Land Type"),

      "Transaction Status": getValue(pageText, "Transaction Status"),
    };

    // console.log(row);
    // Create Excel
    // const workbook = XLSX.utils.book_new();

    // const worksheet = XLSX.utils.json_to_sheet([row]);

    // worksheet["!cols"] = [
    //   { wch: 20 },
    //   { wch: 20 },
    //   { wch: 20 },
    //   { wch: 18 },
    //   { wch: 35 },
    //   { wch: 30 },
    //   { wch: 15 },
    //   { wch: 20 },
    //   { wch: 18 },
    //   { wch: 18 },
    //   { wch: 20 },
    //   { wch: 20 },
    //   { wch: 20 },
    //   { wch: 20 },
    //   { wch: 20 },
    // ];

    // XLSX.utils.book_append_sheet(workbook, worksheet, "Land Data");

    // const excelPath = path.join(
    //   OUTPUT_DIR,
    //   `land_${Date.now()}.xlsx`
    // );

    // XLSX.writeFile(workbook, excelPath);

    // console.log("Excel Saved:", excelPath);


    // // Screenshot
    // const screenshotPath = path.join(
    //   OUTPUT_DIR,
    //   `result_${Date.now()}.png`
    // );

    // await page.screenshot({
    //   path: screenshotPath,
    //   fullPage: true
    // });

    // console.log("Screenshot Saved");


    // Close Browser
    await browser.close();
    return row;


    // const worksheet = XLSX.utils.json_to_sheet([row]);

    // worksheet["!cols"] = [
    //   { wch: 20 },
    //   { wch: 20 },
    //   { wch: 20 },
    //   { wch: 18 },
    //   { wch: 35 },
    //   { wch: 30 },
    //   { wch: 15 },
    //   { wch: 20 },
    //   { wch: 18 },
    //   { wch: 18 },
    //   { wch: 20 },
    //   { wch: 20 },
    //   { wch: 20 },
    //   { wch: 20 },
    //   { wch: 20 },
    // ];

    // XLSX.utils.book_append_sheet(workbook, worksheet, "Land Data");

    // const excelPath = path.join(OUTPUT_DIR, "pattadar_land_details.xlsx");

    // XLSX.writeFile(workbook, excelPath);

    // console.log("Excel Saved:", excelPath);

    // await page.screenshot({
    //   path: path.join(OUTPUT_DIR, "result.png"),
    //   fullPage: true,
    // });

    // console.log("Screenshot Saved");

    // //await browser.close();

    // console.log("Completed Successfully");
  } catch (err) {

    console.error("====================================");
    console.error("CRAWL FAILED");
    console.error(err);
    console.error("Request:", request);

    if (page) {
      try {

        const html = await page.content();

        fs.writeFileSync(
          path.join(__dirname, "last-page.html"),
          html
        );

        console.log("Saved last-page.html");

      } catch (e) {
        console.error(e);
      }
    }

    if (page) {
      try {

        await page.screenshot({
          path: path.join(__dirname, "error.png"),
          fullPage: true,
        });

        console.log("Saved error.png");

      } catch (e) {
        console.error(e);
      }
    }

    if (browser) {
      try {
        await browser.close();
      } catch (e) { }
    }

    throw err;
  }
}

module.exports = {
  crawl
};
