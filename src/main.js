import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';

await Actor.init();

const input = await Actor.getInput() || {};

const {
  startUrl = '',
  search = 'فلل-للبيع',
  city = 'الرياض',
  subArea = '',
  district = '',

  maxResults = 20,
  maxPagesToScan = 30,

  todayOnly = true,
  fetchPhoneFromDetail = true,

  webhookUrl = '',

  proxyConfiguration: proxyInput
} = input;

const MAX_RESULTS = Math.max(1, Number(maxResults) || 20);
const MAX_PAGES = Math.max(1, Number(maxPagesToScan) || 30);

const TODAY_ONLY =
  todayOnly === true ||
  todayOnly === 'true';

const FETCH_PHONE =
  fetchPhoneFromDetail === true ||
  fetchPhoneFromDetail === 'true';

const proxyConfiguration =
  await Actor.createProxyConfiguration(
    proxyInput || {
      useApifyProxy: true,
      groups: ['RESIDENTIAL']
    }
  );

const results = [];
const discovered = new Set();
const detailQueued = new Set();

let pagesScanned = 0;
let detailsChecked = 0;
let noDateCount = 0;

const TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Riyadh',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
}).format(new Date());

function normalize(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function arabicDigits(value) {
  return String(value || '')
    .replace(/[٠-٩]/g, d =>
      String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    )
    .replace(/[۰-۹]/g, d =>
      String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    );
}

function buildBaseUrl() {
  if (String(startUrl).trim()) {
    return String(startUrl).trim().replace(/\/+$/, '');
  }

  const parts = [
    search,
    city,
    subArea,
    district
  ]
    .map(normalize)
    .filter(Boolean);

  return `https://sa.aqar.fm/${parts
    .map(encodeURI)
    .join('/')}`;
}

function pageUrl(base, page) {
  return page === 1
    ? base
    : `${base}/${page}`;
}

function extractId(url) {
  const m = String(url || '').match(
    /-(\d{5,})(?:\/)?(?:[?#].*)?$/
  );

  return m?.[1] || '';
}

function normalizePhone(value) {
  let p = arabicDigits(value)
    .replace(/[^\d+]/g, '');

  if (p.startsWith('+9665')) {
    p = '0' + p.slice(4);
  } else if (p.startsWith('9665')) {
    p = '0' + p.slice(3);
  } else if (p.startsWith('5')) {
    p = '0' + p;
  }

  return /^05\d{8}$/.test(p)
    ? p
    : '';
}

function findPhone(text) {
  const s = arabicDigits(text)
    .replace(/[\s\-().]/g, '');

  const m = s.match(
    /(?:\+966|966|0)?5\d{8}/
  );

  return m
    ? normalizePhone(m[0])
    : '';
}

function dateFromParts(y, m, d) {
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);

  if (
    year < 2000 ||
    year > 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }

  const dt = new Date(
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T12:00:00+03:00`
  );

  if (Number.isNaN(dt.getTime())) {
    return null;
  }

  return dt;
}

function parseDate(value) {
  if (!value) return null;

  const text = arabicDigits(
    String(value)
  ).trim();

  let m = text.match(
    /(?:^|\D)(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})(?:\D|$)/
  );

  if (m) {
    return dateFromParts(
      m[3],
      m[2],
      m[1]
    );
  }

  m = text.match(
    /(?:^|\D)(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})(?:\D|$)/
  );

  if (m) {
    return dateFromParts(
      m[1],
      m[2],
      m[3]
    );
  }

  const native = new Date(text);

  if (
    !Number.isNaN(native.getTime()) &&
    native.getFullYear() >= 2000
  ) {
    return native;
  }

  return null;
}

function relativeDate(value) {
  if (!value) return null;

  const text = arabicDigits(
    String(value)
  ).trim();

  const now = new Date();

  if (
    /اليوم|الآن|منذ لحظات|منذ قليل/.test(text)
  ) {
    return now;
  }

  if (/أمس/.test(text)) {
    now.setDate(now.getDate() - 1);
    return now;
  }

  const m = text.match(
    /منذ\s+(\d+)\s*(ثانية|ثواني|دقيقة|دقائق|ساعة|ساعات|يوم|أيام|أسبوع|أسابيع|شهر|أشهر|سنة|سنوات)/
  );

  if (!m) return null;

  const amount = Number(m[1]);
  const unit = m[2];

  if (!amount) return null;

  if (/ثانية/.test(unit)) {
    now.setSeconds(
      now.getSeconds() - amount
    );
  } else if (/دقيقة/.test(unit)) {
    now.setMinutes(
      now.getMinutes() - amount
    );
  } else if (/ساعة/.test(unit)) {
    now.setHours(
      now.getHours() - amount
    );
  } else if (/يوم/.test(unit)) {
    now.setDate(
      now.getDate() - amount
    );
  } else if (/أسبوع/.test(unit)) {
    now.setDate(
      now.getDate() - amount * 7
    );
  } else if (/شهر/.test(unit)) {
    now.setMonth(
      now.getMonth() - amount
    );
  } else if (/سنة/.test(unit)) {
    now.setFullYear(
      now.getFullYear() - amount
    );
  }

  return now;
}

function isToday(date) {
  if (!date) return false;

  const value =
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Riyadh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date);

  return value === TODAY;
}

function formatDate(date) {
  if (!date) return '';

  return date.toLocaleString('ar-SA', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

async function extractListings(page) {
  return await page.evaluate(() => {
    const output = [];
    const ids = new Set();

    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.href || '';

      if (!href.includes('aqar.fm')) {
        continue;
      }

      const idMatch = href.match(
        /-(\d{5,})(?:\/)?(?:[?#].*)?$/
      );

      if (!idMatch) {
        continue;
      }

      const id = idMatch[1];

      if (ids.has(id)) {
        continue;
      }

      ids.add(id);

      const text = (
        a.innerText || ''
      ).trim();

      if (!text) continue;

      const lines = text
        .split('\n')
        .map(x => x.trim())
        .filter(Boolean);

      const title = lines[0] || '';

      const price =
        text.match(
          /([\d,]+(?:\.\d+)?)\s*(?:ر\.س|ريال|﷼)/
        )?.[1]
        ?.replace(/,/g, '') || '';

      const area =
        text.match(
          /([\d,]+)\s*م²/
        )?.[1]
        ?.replace(/,/g, '') || '';

      const image =
        a.querySelector('img')?.src ||
        a.querySelector('img')?.getAttribute(
          'data-src'
        ) ||
        '';

      output.push({
        id,
        url: href,
        title,
        priceSar: price,
        area_sqm: area,
        description: lines
          .slice(1)
          .join(' ')
          .trim(),
        image,
        listing_type:
          /للإيجار/.test(text)
            ? 'rent'
            : 'sale'
      });
    }

    return output;
  });
}

async function extractDetail(page) {
  const bodyText =
    await page.locator('body').innerText()
      .catch(() => '');

  let data = {
    phone: '',
    postedDate: null,
    postedRaw: '',
    bedrooms: '',
    bathrooms: '',
    ownerName: '',
    verified: false,
    license: ''
  };

  const nextData =
    await page
      .locator('#__NEXT_DATA__')
      .textContent()
      .catch(() => '');

  if (nextData) {
    try {
      const root =
        JSON.parse(nextData);

      const candidates = [];

      function walk(obj, depth = 0) {
        if (
          !obj ||
          typeof obj !== 'object' ||
          depth > 10
        ) {
          return;
        }

        if (
          obj.createdAt ||
          obj.created_at ||
          obj.published_at ||
          obj.posted_at
        ) {
          candidates.push(obj);
        }

        for (
          const value of Object.values(obj)
        ) {
          walk(value, depth + 1);
        }
      }

      walk(root);

      const item =
        candidates.find(x =>
          x.title ||
          x.price ||
          x.property_id ||
          x.id
        ) ||
        candidates[0];

      if (item) {
        data.phone =
          normalizePhone(
            item.phone ||
            item.mobile ||
            item.mobile_number ||
            item.contact_phone ||
            ''
          );

        data.ownerName =
          item.advertiser_name ||
          item.owner_name ||
          item.user?.name ||
          '';

        data.bedrooms = String(
          item.bedrooms ??
          item.rooms ??
          ''
        );

        data.bathrooms = String(
          item.bathrooms ??
          ''
        );

        data.verified = Boolean(
          item.is_verified ||
          item.verified
        );

        data.license =
          item.fal_license ||
          item.rega_license ||
          item.falLicense ||
          '';

        data.postedRaw =
          item.created_at ||
          item.createdAt ||
          item.published_at ||
          item.posted_at ||
          '';

        data.postedDate =
          parseDate(
            data.postedRaw
          ) ||
          relativeDate(
            data.postedRaw
          );
      }
    } catch {
      // Continue with visible page data.
    }
  }

  if (!data.postedDate) {
    const datePatterns = [
      /(?:تاريخ الإضافة|تاريخ الإعلان)[\s:：-]*([^\n]{1,50})/i,
      /(?:أضيف|نشر|نُشر)[\s:：-]*([^\n]{1,50})/i,
      /(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/,
      /(\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2})/,
      /(منذ\s+\d+\s+(?:دقيقة|دقائق|ساعة|ساعات|يوم|أيام|أسبوع|أسابيع))/i,
      /(اليوم|أمس|منذ قليل|منذ لحظات)/i
    ];

    for (const pattern of datePatterns) {
      const match =
        bodyText.match(pattern);

      if (!match) continue;

      const raw =
        match[1] || match[0];

      const date =
        parseDate(raw) ||
        relativeDate(raw);

      if (date) {
        data.postedRaw = raw;
        data.postedDate = date;
        break;
      }
    }
  }

  if (!data.phone && FETCH_PHONE) {
    data.phone =
      findPhone(bodyText);

    if (!data.phone) {
      const tel =
        await page
          .locator('a[href^="tel:"]')
          .first()
          .getAttribute('href')
          .catch(() => '');

      data.phone =
        normalizePhone(
          tel?.replace(/^tel:/i, '')
        );
    }
  }

  if (!data.license) {
    data.license =
      bodyText.match(
        /(?:رخصة فال|رخصه فال|ترخيص)\s*:?\s*(\d{6,})/
      )?.[1] || '';
  }

  if (!data.bedrooms) {
    data.bedrooms =
      bodyText.match(
        /(\d+)\s*(?:غرف|غرفة)/
      )?.[1] || '';
  }

  if (!data.bathrooms) {
    data.bathrooms =
      bodyText.match(
        /(\d+)\s*(?:حمامات|حمام)/
      )?.[1] || '';
  }

  return data;
}

const baseUrl = buildBaseUrl();

log.info(
  `🔗 رابط البحث: ${baseUrl}`
);

log.info(
  `📅 التاريخ المستهدف: ${TODAY}`
);

const crawler =
  new PlaywrightCrawler({
    proxyConfiguration,

    maxConcurrency: 2,

    maxRequestsPerCrawl:
      MAX_PAGES + MAX_RESULTS + 50,

    requestHandlerTimeoutSecs: 90,

    navigationTimeoutSecs: 45,

    async requestHandler({
      page,
      request,
      log: reqLog
    }) {
      const type =
        request.userData?.type;

      if (type === 'DETAIL') {
        await handleDetail(
          page,
          request,
          reqLog
        );

        return;
      }

      await handleList(
        page,
        request,
        reqLog
      );
    },

    async failedRequestHandler({
      request,
      error
    }) {
      log.error(
        `❌ فشل: ${request.url} — ${error.message}`
      );
    }
  });

async function handleList(
  page,
  request,
  reqLog
) {
  const pageNumber =
    Number(
      request.userData?.pageNumber
    ) || 1;

  pagesScanned++;

  reqLog.info(
    `📄 فحص الصفحة ${pageNumber}: ${request.url}`
  );

  await page.goto(
    request.url,
    {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    }
  );

  await page.waitForTimeout(1200);

  const listings =
    await extractListings(page);

  reqLog.info(
    `🔎 وجدنا ${listings.length} إعلان في الصفحة ${pageNumber}`
  );

  for (const item of listings) {
    if (
      discovered.has(item.id)
    ) {
      continue;
    }

    if (
      results.length >= MAX_RESULTS
    ) {
      break;
    }

    discovered.add(item.id);

    if (
      detailQueued.has(item.id)
    ) {
      continue;
    }

    detailQueued.add(item.id);

    await crawler.addRequests([
      {
        url: item.url,

        uniqueKey:
          `detail-${item.id}`,

        userData: {
          type: 'DETAIL',
          listing: item
        }
      }
    ]);
  }

  if (
    pageNumber < MAX_PAGES &&
    results.length < MAX_RESULTS
  ) {
    const next =
      pageUrl(
        baseUrl,
        pageNumber + 1
      );

    await crawler.addRequests([
      {
        url: next,

        uniqueKey:
          `list-${pageNumber + 1}`,

        userData: {
          type: 'LIST',
          pageNumber:
            pageNumber + 1
        }
      }
    ]);
  }
}

async function handleDetail(
  page,
  request,
  reqLog
) {
  if (
    results.length >= MAX_RESULTS
  ) {
    return;
  }

  const listing =
    request.userData.listing;

  detailsChecked++;

  reqLog.info(
    `🔍 تفاصيل ${detailsChecked}: ${listing.id}`
  );

  try {
    await page.goto(
      request.url,
      {
        waitUntil:
          'domcontentloaded',
        timeout: 45000
      }
    );

    await page.waitForTimeout(500);

    const detail =
      await extractDetail(page);

    if (!detail.postedDate) {
      noDateCount++;

      reqLog.warning(
        `⚠️ لم يتم العثور على تاريخ: ${listing.id}`
      );

      return;
    }

    const today =
      isToday(detail.postedDate);

    reqLog.info(
      `${today ? '🟢' : '⚪'} ${listing.id} | ${formatDate(detail.postedDate)}`
    );

    if (
      TODAY_ONLY &&
      !today
    ) {
      return;
    }

    const item = {
      ...listing,

      source: 'aqar',

      phone:
        detail.phone || '',

      posted_at:
        formatDate(
          detail.postedDate
        ),

      posted_at_iso:
        detail.postedDate.toISOString(),

      date_raw:
        detail.postedRaw,

      bedrooms:
        detail.bedrooms,

      bathrooms:
        detail.bathrooms,

      owner_name:
        detail.ownerName,

      is_verified:
        detail.verified,

      rega_license:
        detail.license,

      scanned_at:
        new Date().toISOString()
    };

    results.push(item);

    await Actor.pushData(item);

    reqLog.info(
      `✅ تم حفظ إعلان اليوم: ${listing.id} — ${results.length}/${MAX_RESULTS}`
    );
  } catch (error) {
    reqLog.warning(
      `⚠️ تعذر فحص ${listing.id}: ${error.message}`
    );
  }
}

await crawler.run([
  {
    url: pageUrl(
      baseUrl,
      1
    ),

    uniqueKey:
      'list-1',

    userData: {
      type: 'LIST',
      pageNumber: 1
    }
  }
]);

log.info(
  `━━━━━━━━━━━━━━━━━━━━━━━━━━`
);

log.info(
  `🎯 النتائج النهائية: ${results.length}`
);

log.info(
  `📄 الصفحات المفحوصة: ${pagesScanned}`
);

log.info(
  `🔍 التفاصيل المفحوصة: ${detailsChecked}`
);

log.info(
  `⚠️ إعلانات بدون تاريخ: ${noDateCount}`
);

log.info(
  `📅 وضع اليوم فقط: ${TODAY_ONLY}`
);

if (webhookUrl?.trim()) {
  try {
    const datasetId =
      process.env.APIFY_DEFAULT_DATASET_ID;

    if (datasetId) {
      await fetch(
        webhookUrl.trim(),
        {
          method: 'POST',

          headers: {
            'Content-Type':
              'application/json'
          },

          body: JSON.stringify({
            status: 'success',

            today: TODAY,

            todayOnly:
              TODAY_ONLY,

            search,
            city,

            pagesScanned,

            detailsChecked,

            resultsCount:
              results.length,

            datasetId,

            downloadUrl:
              `https://api.apify.com/v2/datasets/${datasetId}/items?format=json`
          })
        }
      );

      log.info(
        '✅ تم إرسال Webhook'
      );
    }
  } catch (error) {
    log.warning(
      `⚠️ فشل Webhook: ${error.message}`
    );
  }
}

await Actor.exit();
