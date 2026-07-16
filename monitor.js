const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const STATE_PATH = path.join(__dirname, 'state.json');
const BASE_URL =
  'https://www.cinemacity.hu/films/odusszeia/7460d2r' +
  '?lang=hu_HU#/buy-tickets-by-film' +
  '?in-cinema=budapest&at=';
const URL_END =
  '&for-movie=7460d2r&filtered=imax&view-mode=list';

const MAX_FORWARD_DAYS = 45;
const PAGE_TIMEOUT_MS = 45_000;
const MINIMUM_WAIT_MS = 10_000;
const POLL_INTERVAL_MS = 750;
const STABLE_READS_REQUIRED = 4;

function assertIsoDate(value, fieldName) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${fieldName} nem érvényes ISO-dátum: ${value}`);
  }

  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`${fieldName} nem létező dátum: ${value}`);
  }
}

function addDays(isoDate, days) {
  assertIsoDate(isoDate, 'Dátum');
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function extractAtDate(url) {
  const match = url.match(/[?&]at=(\d{4}-\d{2}-\d{2})(?:&|$)/i);
  return match ? match[1] : null;
}

function buildUrl(isoDate) {
  return `${BASE_URL}${isoDate}${URL_END}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFinalUrlState(page) {
  const startedAt = Date.now();
  let previousUrl = '';
  let stableReads = 0;

  while (Date.now() - startedAt < PAGE_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);

    const currentUrl = page.url();

    if (!currentUrl) {
      previousUrl = '';
      stableReads = 0;
      continue;
    }

    if (currentUrl === previousUrl) {
      stableReads += 1;
    } else {
      previousUrl = currentUrl;
      stableReads = 1;
    }

    const waitedLongEnough = Date.now() - startedAt >= MINIMUM_WAIT_MS;
    const actualDate = extractAtDate(currentUrl);

    if (
      waitedLongEnough &&
      stableReads >= STABLE_READS_REQUIRED &&
      actualDate
    ) {
      return { finalUrl: currentUrl, actualDate };
    }
  }

  throw new Error(
    `Az URL ${PAGE_TIMEOUT_MS / 1000} másodpercen belül nem került stabil, kiértékelhető állapotba. Utolsó URL: ${page.url()}`
  );
}

async function checkDate(page, requestedDate) {
  const targetUrl = buildUrl(requestedDate);
  console.log(`Ellenőrzés: ${requestedDate}`);

  await page.goto(targetUrl, {
    waitUntil: 'domcontentloaded',
    timeout: PAGE_TIMEOUT_MS,
  });

  const { finalUrl, actualDate } = await waitForFinalUrlState(page);
  const accepted = actualDate === requestedDate;

  console.log(`  URL-ben maradt dátum: ${actualDate}`);
  console.log(`  Elfogadva: ${accepted ? 'igen' : 'nem'}`);
  console.log(`  Végleges URL: ${finalUrl}`);

  return { requestedDate, actualDate, accepted, finalUrl };
}

function writeGitHubOutputs(values) {
  const outputPath = process.env.GITHUB_OUTPUT;

  if (!outputPath) {
    return;
  }

  const lines = Object.entries(values).map(([key, value]) => {
    const safeValue = String(value).replace(/\r?\n/g, ' ');
    return `${key}=${safeValue}`;
  });

  fs.appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  if (!fs.existsSync(STATE_PATH)) {
    throw new Error('Nem található a state.json állomány.');
  }

  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  const oldLastDate = state.lastKnownImaxDate;
  assertIsoDate(oldLastDate, 'lastKnownImaxDate');

  let browser;
  let page;
  let requestedDate = addDays(oldLastDate, 1);
  let newLastDate = oldLastDate;
  let firstUnavailableDate = '';
  let lastFinalUrl = '';
  let checkedDays = 0;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      locale: 'hu-HU',
      timezoneId: 'Europe/Budapest',
      viewport: { width: 1440, height: 1100 },
    });

    page = await context.newPage();

    for (let i = 0; i < MAX_FORWARD_DAYS; i += 1) {
      checkedDays += 1;
      const result = await checkDate(page, requestedDate);
      lastFinalUrl = result.finalUrl;

      if (!result.accepted) {
        firstUnavailableDate = requestedDate;
        break;
      }

      newLastDate = requestedDate;
      requestedDate = addDays(requestedDate, 1);
    }

    if (!firstUnavailableDate) {
      throw new Error(
        `A figyelő elérte a ${MAX_FORWARD_DAYS} napos biztonsági korlátot visszairányítás nélkül.`
      );
    }

    const changed = newLastDate !== oldLastDate;
    const newRangeStart = changed ? addDays(oldLastDate, 1) : '';

    if (changed) {
      const updatedState = {
        lastKnownImaxDate: newLastDate,
        updatedAt: new Date().toISOString(),
      };

      fs.writeFileSync(
        STATE_PATH,
        `${JSON.stringify(updatedState, null, 2)}\n`,
        'utf8'
      );
    }

    writeGitHubOutputs({
      changed,
      old_date: oldLastDate,
      new_date: newLastDate,
      new_range_start: newRangeStart,
      first_unavailable_date: firstUnavailableDate,
      checked_days: checkedDays,
      final_url: lastFinalUrl,
    });

    console.log('');
    console.log(`Korábbi legkésőbbi dátum: ${oldLastDate}`);
    console.log(`Új legkésőbbi dátum: ${newLastDate}`);
    console.log(`Első még nem elérhető dátum: ${firstUnavailableDate}`);
    console.log(`Változás: ${changed ? 'igen' : 'nem'}`);
  } catch (error) {
    if (page) {
      try {
        await page.screenshot({
          path: path.join(__dirname, 'debug-error.png'),
          fullPage: true,
        });
      } catch (screenshotError) {
        console.error('A hibaképernyő mentése sem sikerült:', screenshotError);
      }
    }

    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

main().catch((error) => {
  console.error('A figyelő hibával leállt:');
  console.error(error);
  process.exitCode = 1;
});
