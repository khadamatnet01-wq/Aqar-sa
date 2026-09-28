import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';

await Actor.init();

const input = await Actor.getInput() || {};
const {
  startUrl = '',
  search = 'شقق-للبيع',
  city = 'الرياض',
  subArea = '',
  district = '',
  maxResults = 20,
  fetchPhoneFromDetail = true,
  todayOnly = false,
  maxPagesToScan = 30,
  proxyConfiguration: proxyInput,
  webhookUrl = '',
} = input;

const MAX_RESULTS = Math.max(1, Number(maxResults) || 20);
const MAX_PAGES = Math.max(1, Number(maxPagesToScan) || 30);
const TODAY_ONLY = todayOnly === true || todayOnly === 'true';
const FETCH_PHONE = fetchPhoneFromDetail === true || fetchPhoneFromDetail === 'true';

const proxyConfiguration = await Actor.createProxyConfiguration(
  proxyInput || { useApifyProxy: true, groups: ['RESIDENTIAL'] }
);

const items = [];
const seen = new Set();
let pagesScanned = 0;
let skippedNoDate = 0;

const digits = s => String(s || '')
  .replace(/[٠-٩]/g, x => '٠١٢٣٤٥٦٧٨٩'.indexOf(x))
  .replace(/[۰-۹]/g, x => '۰۱۲۳۴۵۶۷۸۹'.indexOf(x));

const normalize = s => String(s || '')
  .trim()
  .replace(/\s+/g, '-')
  .replace(/^-+|-+$/g, '');

function listUrl(page = 1) {
  if (startUrl?.trim()) {
    return page === 1
      ? startUrl.trim()
      : `${startUrl.trim().replace(/\/+$/, '')}/${page}`;
  }

  const parts = [search, city, subArea, district]
    .map(normalize)
    .filter(Boolean);

  const base = `https://sa.aqar.fm/${parts.map(encodeURI).join('/')}`;

  return page === 1 ? base : `${base}/${page}`;
}

function riyadhDate(date = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const x = Object.fromEntries(p.map(v => [v.type, v.value]));

  return `${x.year}-${x.month}-${x.day}`;
}

const TODAY = riyadhDate();

function isToday(value) {
  const d = new Date(value);

  return !Number.isNaN(d.getTime()) &&
    riyadhDate(d) === TODAY;
}

function phone(text) {
  const s = digits(text).replace(/[\s\-().]/g, '');
  const m = s.match(/(?:\+?966|0)?5\d{8}/);

  if (!m) return '';

  let p = m[0];

  if (p.startsWith('+9665')) {
    p = '0' + p.slice(4);
  } else if (p.startsWith('9665')) {
    p = '0' + p.slice(3);
  } else if (p.startsWith('5')) {
    p = '0' + p;
  }

  return /^05\d{8}$/.test(p) ? p : '';
}

function explicitDate(text) {
  const s = digits(text).trim();

  const valid = (y, m, d) => {
    const x = new Date(Date.UTC(y, m - 1, d));

    return (
      y >= 2000 &&
      y <= 2100 &&
      x.getUTCFullYear() === y &&
      x.getUTCMonth() === m - 1 &&
      x.getUTCDate() === d
    );
  };

  let m = s.match(
    /(?:^|\D)(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})(?:\D|$)/
  );

  if (m) {
    const d = +m[1];
    const mo = +m[2];
    const y = +m[3];

    if (!valid(y, mo, d)) return null;

    return new Date(
      `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T12:00:00+03:00`
    );
  }

  m = s.match(
    /(?:^|\D)(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})(?:\D|$)/
  );

  if (m) {
    const y = +m[1];
    const mo = +m[2];
    const d = +m[3];

    if (!valid(y, mo, d)) return null;

    return new Date(
      `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T12:00:00+03:00`
    );
  }

  return null;
}

function relativeDate(text) {
  const s = digits(text)
    .replace(/تقريباً|تقريبا|تقريب/g, '')
    .trim();

  const now = new Date();

  if (/اليوم|الآن|منذ لحظات|منذ قليل/.test(s)) {
    return now;
  }

  if (/أمس/.test(s)) {
    now.setDate(now.getDate() - 1);
    return now;
  }

  const nums = {
    ثلاثة: 3,
    ثلاث: 3,
    أربعة: 4,
    أربع: 4,
    خمسة: 5,
    خمس: 5,
    ستة: 6,
    ست: 6,
    سبعة: 7,
    سبع: 7,
    ثمانية: 8,
    ثمان: 8,
    تسعة: 9,
    تسع: 9,
    عشرة: 10,
    عشر: 10
  };

  const m = s.match(
    /منذ\s+([\u0621-\u064A0-9]+)\s+(ثانية|ثواني|دقيقة|دقائق|ساعة|ساعات|يوم|أيام|أسبوع|أسابيع|شهر|أشهر|سنة|سنوات)/
  );

  const bare = {
    ثانية: 1,
    دقيقتان: 2,
    دقيقتين: 2,
    دقيقة: 1,
    ساعتان: 2,
    ساعتين: 2,
    ساعة: 1,
    يومان: 2,
    يومين: 2,
    يوم: 1,
    أسبوعان: 2,
    أسبوعين: 2,
    أسبوع: 1,
    شهران: 2,
    شهرين: 2,
    شهر: 1,
    سنتان: 2,
    سنتين: 2,
    سنة: 1
  };

  const unit = s.match(
    /منذ\s+(ثانيتين|ثانية|دقيقتين|دقيقة|ساعتين|ساعة|يومين|يوم|أسبوعين|أسبوع|شهرين|شهر|سنتين|سنة)/
  );

  let n;
  let u;

  if (m) {
    n = Number(m[1]) || nums[m[1]];
    u = m[2];
  } else if (unit) {
    n = bare[unit[1]];
    u = unit[1];
  } else {
    return null;
  }

  const d = new Date(now);

  if (/ثانية/.test(u)) {
    d.setSeconds(d.getSeconds() - n);
  } else if (/دقيقة/.test(u)) {
    d.setMinutes(d.getMinutes() - n);
  } else if (/ساعة/.test(u)) {
    d.setHours(d.getHours() - n);
  } else if (/يوم/.test(u)) {
    d.setDate(d.getDate() - n);
  } else if (/أسبوع/.test(u)) {
    d.setDate(d.getDate() - n * 7);
  } else if (/شهر/.test(u)) {
    d.setMonth(d.getMonth() - n);
  } else if (/سنة/.test(u)) {
    d.setFullYear(d.getFullYear() - n);
  }

  return d;
}

function formatDate(d, time = true) {
  return d.toLocaleString('en-GB', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(time
      ? {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        }
      : {})
  });
}

async function extractCards(page) {
  return page.evaluate(() => {
    const out = [];
    const seen = new Set();

    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.href;
      const m = href.match(/-(\d{5,})\/?(?:[?#].*)?$/);

      if (!m || !href.includes('aqar.fm')) continue;

      const id = m[1];

      if (seen.has(id)) continue;

      seen.add(id);

      const text = a.innerText || '';

      if (/^مميز/.test(text.trim())) continue;

      const lines = text
        .split('\n')
        .map(x => x.trim())
        .filter(Boolean);

      const title = lines[0] || '';

      const price = (
        text.match(
          /([\d,]+(?:\.\d+)?)\s*(?:§|ر\.س|ريال|﷼)/
        )?.[1] || ''
      ).replace(/,/g, '');

      const area = (
        text.match(/([\d,]+)\s*م²/)?.[1] || ''
      ).replace(/,/g, '');

      const p = text.match(
        /(?:\+?966|0)5[0-9]{8}/
      );

      const img =
        a.querySelector('img')?.src ||
        a.querySelector('img')?.getAttribute('data-src') ||
        '';

      out.push({
        _raw_id: id,
        name: title,
        priceSar: price,
        listing_type: /سنوي/.test(text)
          ? 'rent'
          : 'sale',
        area_sqm: area,

        district:
          title.match(/حي\s+([^\,،]+)/)?.[1]?.trim() ||
          '',

        city:
          title.match(/مدينة\s+([^\,،]+)/)?.[1] ||
          '',

        property_type:
          title.match(
            /^([\u0600-\u06FF]+)\s+(?:للبيع|للإيجار)/
          )?.[1] || '',

        description:
          lines.slice(1).join(' ').trim(),

        phone: p ? p[0] : '',

        has_image: !!img,

        images: img ? [img] : [],

        url: href
      });
    }

    return out;
  });
}

async function detail(page, url, reqLog) {
  await page.route('**/*', route =>
    ['image', 'media', 'font'].includes(
      route.request().resourceType()
    )
      ? route.abort()
      : route.continue()
  );

  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  await page.waitForTimeout(800);

  if (FETCH_PHONE) {
    const btn = await page.$(
      'button:has-text("اتصال"),a:has-text("اتصال"),[class*="call"],[class*="phone"]'
    );

    if (btn) {
      await btn
        .click({ timeout: 3000 })
        .catch(() => {});
    }
  }

  let ph = FETCH_PHONE
    ? phone(
        await page.evaluate(
          () => document.body.innerText || ''
        )
      )
    : '';

  if (FETCH_PHONE && !ph) {
    const href = await page
      .$eval(
        'a[href^="tel:"]',
        e => e.href
      )
      .catch(() => '');

    if (href) {
      ph = phone(
        href.replace(/^tel:/i, '')
      );
    }
  }

  let posted = '';
  let iso = '';
  let raw = '';
  let bedrooms = '';
  let bathrooms = '';
  let owner = '';
  let verified = false;
  let license = '';

  const next = await page
    .$eval(
      '#__NEXT_DATA__',
      e => e.textContent
    )
    .catch(() => null);

  if (next) {
    try {
      const data = JSON.parse(next);
      let prop;

      const find = (o, depth = 0) => {
        if (
          prop ||
          !o ||
          typeof o !== 'object' ||
          depth > 12
        ) {
          return;
        }

        if (
          (o.id ||
            o.property_id ||
            o.ad_id) &&
          (o.createdAt ||
            o.created_at ||
            o.published_at) &&
          (o.title ||
            o.price ||
            o.rooms ||
            o.bedrooms)
        ) {
          prop = o;
          return;
        }

        for (const v of Object.values(o)) {
          find(v, depth + 1);

          if (prop) return;
        }
      };

      find(data);

      if (prop) {
        owner =
          prop.advertiser_name ||
          prop.owner_name ||
          prop.user?.name ||
          '';

        verified = !!(
          prop.is_verified ||
          prop.verified
        );

        license =
          prop.fal_license ||
          prop.rega_license ||
          '';

        bedrooms = String(
          prop.rooms ??
          prop.bedrooms ??
          ''
        );

        bathrooms = String(
          prop.bathrooms ?? ''
        );

        if (FETCH_PHONE && !ph) {
          ph = phone(
            prop.phone ||
            prop.mobile ||
            prop.contact_phone ||
            ''
          );
        }

        raw =
          prop.created_at ||
          prop.createdAt ||
          prop.published_at ||
          '';

        const d =
          raw &&
          new Date(raw);

        if (
          d &&
          !Number.isNaN(d.getTime())
        ) {
          iso = d.toISOString();

          posted =
            d.toLocaleString(
              'ar-SA',
              {
                timeZone: 'Asia/Riyadh',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
              }
            );
        }
      }
    } catch (e) {
      reqLog.warning(
        `NEXT_DATA: ${e.message}`
      );
    }
  }

  if (!posted) {
    const found = await page.evaluate(() => {
      const label = 'تاريخ الإضافة';

      const re =
        /(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4}|\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}|منذ\s+[^\n]{1,30})/;

      for (
        const el of document.querySelectorAll('*')
      ) {
        if (
          el.children.length ||
          (el.textContent || '').trim() !== label
        ) {
          continue;
        }

        let n = el;

        for (
          let i = 0;
          i < 5 && n;
          i++, n = n.parentElement
        ) {
          const t = n.innerText || '';
          const i1 = t.indexOf(label);

          if (i1 < 0) continue;

          const m = t
            .slice(i1 + label.length)
            .match(re);

          if (m) return m[0].trim();
        }
      }

      return '';
    });

    if (found) {
      raw = found;

      const d =
        explicitDate(found) ||
        relativeDate(found);

      if (d) {
        iso = d.toISOString();

        posted = formatDate(
          d,
          !explicitDate(found)
        );
      }
    }
  }

  return {
    phone: ph,
    posted_at: posted,
    posted_at_iso: iso,
    date_raw: raw,
    bedrooms,
    bathrooms,
    owner_name: owner,
    is_verified: verified,
    rega_license: license
  };
}

const crawler = new PlaywrightCrawler({
  proxyConfiguration,

  maxConcurrency: 1,

  maxRequestsPerCrawl:
    TODAY_ONLY
      ? MAX_PAGES * 35 +
        MAX_RESULTS * 3 +
        50
      : MAX_RESULTS * 3 + 50,

  requestHandlerTimeoutSecs: 240,
  navigationTimeoutSecs: 60,

  async requestHandler({
    page,
    request,
    log: reqLog
  }) {
    if (
      request.userData.label !== 'LIST'
    ) {
      return;
    }

    const pageNum =
      Number(request.userData.pageNum) || 1;

    const base =
      request.userData.baseUrl;

    const url =
      pageNum === 1
        ? base
        : `${base}/${pageNum}`;

    reqLog.info(
      `📄 صفحة ${pageNum}: ${url}`
    );

    const response =
      await page
        .goto(url, {
          waitUntil:
            'domcontentloaded',
          timeout: 60000
        })
        .catch(() => null);

    if (
      !response ||
      response.status() >= 400
    ) {
      return;
    }

    await page.waitForTimeout(900);

    const cards =
      await extractCards(page);

    if (!cards.length) return;

    if (TODAY_ONLY) {
      pagesScanned++;

      for (const card of cards) {
        if (
          items.length >= MAX_RESULTS ||
          seen.has(card._raw_id)
        ) {
          continue;
        }

        seen.add(card._raw_id);

        let d;

        try {
          d = await detail(
            page,
            card.url,
            reqLog
          );
        } catch {
          continue;
        }

        if (!d.posted_at_iso) {
          skippedNoDate++;
          continue;
        }

        if (!isToday(d.posted_at_iso)) {
          continue;
        }

        Object.assign(
          card,
          d,
          {
            source: 'aqar',
            scanned_at:
              new Date().toISOString()
          }
        );

        if (!card.rega_license) {
          card.rega_license =
            card.description.match(
              /(?:رخصة فال|رخصه فال|ترخيص)\s*:?\s*(\d{6,})/
            )?.[1] || '';
        }

        items.push(card);

        reqLog.info(
          `✅ ${card.name.slice(0, 40)} | ` +
          `${card.phone || 'لا جوال'}`
        );
      }
    } else {
      for (const card of cards) {
        if (
          items.length >= MAX_RESULTS ||
          seen.has(card._raw_id)
        ) {
          continue;
        }

        seen.add(card._raw_id);

        card.source = 'aqar';
        card.bedrooms = '';
        card.bathrooms = '';
        card.owner_name = '';

        card.rega_license =
          card.description.match(
            /(?:رخصة فال|رخصه فال|ترخيص)\s*:?\s*(\d{6,})/
          )?.[1] || '';

        card.is_verified = false;
        card.posted_at = '';
        card.posted_at_iso = '';
        card.scanned_at =
          new Date().toISOString();

        items.push(card);
      }

      if (FETCH_PHONE) {
        for (
          const card of items.filter(
            x => !x.phone
          )
        ) {
          await crawler.addRequests([
            {
              url: card.url,

              uniqueKey:
                `detail-${card._raw_id}`,

              userData: {
                label: 'DETAIL',
                rawId: card._raw_id
              }
            }
          ]);
        }
      }
    }

    const pageLimit =
      TODAY_ONLY
        ? MAX_PAGES
        : 50;

    if (
      items.length < MAX_RESULTS &&
      pageNum < pageLimit
    ) {
      await crawler.addRequests([
        {
          url:
            `${base}/${pageNum + 1}`,

          uniqueKey:
            `list-${encodeURIComponent(base)}-${pageNum + 1}`,

          userData: {
            label: 'LIST',
            pageNum: pageNum + 1,
            baseUrl: base
          }
        }
      ]);
    }
  },

  async failedRequestHandler({
    request,
    error
  }) {
    log.error(
      `❌ ${request.url} — ${error.message}`
    );
  }
});

const initial =
  listUrl(1);

log.info(
  `🔗 ${initial}`
);

if (TODAY_ONLY) {
  log.info(
    `📅 اليوم: ${TODAY}`
  );
}

await crawler.run([
  {
    url: initial,

    uniqueKey:
      `list-${encodeURIComponent(initial)}-1`,

    userData: {
      label: 'LIST',
      pageNum: 1,
      baseUrl: initial
    }
  }
]);

for (const item of items) {
  await Actor.pushData(item);
}

log.info(
  `🎉 تم استخراج ${items.length} إعلان` +
  (
    TODAY_ONLY
      ? ` من اليوم بعد فحص ${pagesScanned} صفحة`
      : ''
  )
);

if (webhookUrl?.trim()) {
  try {
    const datasetId =
      process.env.APIFY_DEFAULT_DATASET_ID;

    if (!datasetId) {
      throw new Error(
        'APIFY_DEFAULT_DATASET_ID غير متاح'
      );
    }

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
          search,
          city,
          itemsCount: items.length,

          downloadUrl:
            `https://api.apify.com/v2/datasets/${datasetId}/items?format=json`
        })
      }
    );

    log.info(
      '✅ Webhook أُرسل بنجاح'
    );
  } catch (e) {
    log.error(
      `❌ Webhook: ${e.message}`
    );
  }
}

await Actor.exit();
