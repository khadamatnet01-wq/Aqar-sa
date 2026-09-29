// -*- coding: utf-8 -*-

import { Actor, log } from 'apify';
import { chromium } from 'playwright';

await Actor.init();

const input = await Actor.getInput() || {};

const {
    startUrl = '',
    search = 'فلل-للبيع',
    city = 'الرياض',
    subArea = '',
    district = '',

    maxResults = 20,
    maxPagesToScan = 10,

    todayOnly = true,
    fetchPhoneFromDetail = true,

    // مهم: لا ترفعها كثيراً لأن الهاتف يستخدم Playwright
    concurrency = 3,

    webhookUrl = '',

    proxyConfiguration: proxyInput
} = input;

const MAX_RESULTS =
    Math.max(1, Number(maxResults) || 20);

const MAX_PAGES =
    Math.max(1, Number(maxPagesToScan) || 10);

const CONCURRENCY =
    Math.min(
        5,
        Math.max(1, Number(concurrency) || 3)
    );

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
const seen = new Set();

let pagesScanned = 0;
let detailsChecked = 0;
let dateFound = 0;
let dateMissing = 0;
let phonesFound = 0;
let phonesMissing = 0;

let browser = null;

const TODAY =
    new Intl.DateTimeFormat(
        'en-CA',
        {
            timeZone: 'Asia/Riyadh',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }
    ).format(new Date());

log.info(`📅 تاريخ الرياض: ${TODAY}`);
log.info(`⚡ وضع السحب: HTTP + Playwright للهاتف فقط`);
log.info(`⚡ توازي التفاصيل: ${CONCURRENCY}`);
log.info(`🎯 الحد المطلوب: ${MAX_RESULTS}`);
log.info(`📱 جلب الهاتف: ${FETCH_PHONE}`);


/* =========================================================
   أدوات عامة
========================================================= */

function normalize(value) {
    return String(value || '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function buildBaseUrl() {
    if (String(startUrl).trim()) {
        return String(startUrl)
            .trim()
            .replace(/\/+$/, '');
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

function getPageUrl(page) {
    const base = buildBaseUrl();

    return page === 1
        ? base
        : `${base}/${page}`;
}

function arabicDigits(value) {
    return String(value || '')
        .replace(/[٠-٩]/g, d =>
            String(
                '٠١٢٣٤٥٦٧٨٩'.indexOf(d)
            )
        )
        .replace(/[۰-۹]/g, d =>
            String(
                '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)
            )
        );
}

function normalizePhone(value) {
    let phone =
        arabicDigits(value)
            .replace(/[^\d+]/g, '');

    if (phone.startsWith('+9665')) {
        phone =
            '0' +
            phone.slice(4);
    }

    if (phone.startsWith('9665')) {
        phone =
            '0' +
            phone.slice(3);
    }

    if (phone.startsWith('5')) {
        phone =
            '0' + phone;
    }

    return /^05\d{8}$/.test(phone)
        ? phone
        : '';
}

function extractPhone(text) {
    const value =
        arabicDigits(text)
            .replace(/[\s\-().]/g, '');

    const patterns = [
        /(?:\+966|00966|966|0)?5\d{8}/,
        /05\d{8}/,
        /5\d{8}/
    ];

    for (const pattern of patterns) {
        const match =
            value.match(pattern);

        if (match) {
            const phone =
                normalizePhone(match[0]);

            if (phone) {
                return phone;
            }
        }
    }

    return '';
}

function decodeHtml(value) {
    return String(value || '')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

function stripTags(value) {
    return decodeHtml(
        String(value || '')
            .replace(
                /<script[\s\S]*?<\/script>/gi,
                ' '
            )
            .replace(
                /<style[\s\S]*?<\/style>/gi,
                ' '
            )
            .replace(
                /<[^>]+>/g,
                ' '
            )
            .replace(
                /\s+/g,
                ' '
            )
            .trim()
    );
}


/* =========================================================
   التاريخ
========================================================= */

function dateFromParts(
    year,
    month,
    day
) {
    const y = Number(year);
    const m = Number(month);
    const d = Number(day);

    if (
        y < 2000 ||
        y > 2100 ||
        m < 1 ||
        m > 12 ||
        d < 1 ||
        d > 31
    ) {
        return null;
    }

    const date =
        new Date(
            `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T12:00:00+03:00`
        );

    return Number.isNaN(
        date.getTime()
    )
        ? null
        : date;
}

function parseExplicitDate(value) {
    if (!value) {
        return null;
    }

    const text =
        arabicDigits(value).trim();

    let match =
        text.match(
            /(?:^|\D)(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})(?:\D|$)/
        );

    if (match) {
        return dateFromParts(
            match[3],
            match[2],
            match[1]
        );
    }

    match =
        text.match(
            /(?:^|\D)(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})(?:\D|$)/
        );

    if (match) {
        return dateFromParts(
            match[1],
            match[2],
            match[3]
        );
    }

    return null;
}

function parseRelativeDate(value) {
    if (!value) {
        return null;
    }

    const text =
        arabicDigits(value)
            .replace(
                /تقريباً|تقريبا|تقريب/g,
                ''
            )
            .trim();

    const now = new Date();

    if (
        /اليوم|الآن|منذ لحظات|منذ قليل/
            .test(text)
    ) {
        return now;
    }

    if (/أمس/.test(text)) {
        now.setDate(
            now.getDate() - 1
        );

        return now;
    }

    const words = {
        واحد: 1,
        واحدة: 1,
        اثنان: 2,
        اثنتان: 2,
        اثنين: 2,
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

    const match =
        text.match(
            /منذ\s+([\u0621-\u064A0-9]+)\s+(ثانية|ثواني|دقيقة|دقائق|ساعة|ساعات|يوم|أيام|أسبوع|أسابيع|شهر|أشهر|سنة|سنوات)/
        );

    if (!match) {
        return null;
    }

    let amount =
        Number(match[1]);

    if (Number.isNaN(amount)) {
        amount =
            words[match[1]];
    }

    if (!amount) {
        return null;
    }

    const unit =
        match[2];

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

function parseNativeDate(value) {
    if (!value) {
        return null;
    }

    const date =
        new Date(value);

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {
        return null;
    }

    if (
        date.getFullYear() < 2000
    ) {
        return null;
    }

    return date;
}

function parseDate(value) {
    if (!value) {
        return null;
    }

    return (
        parseExplicitDate(value) ||
        parseRelativeDate(value) ||
        parseNativeDate(value)
    );
}

function isToday(date) {
    if (!date) {
        return false;
    }

    const value =
        new Intl.DateTimeFormat(
            'en-CA',
            {
                timeZone: 'Asia/Riyadh',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit'
            }
        ).format(date);

    return value === TODAY;
}

function formatDate(date) {
    if (!date) {
        return '';
    }

    return date.toLocaleString(
        'en-GB',
        {
            timeZone: 'Asia/Riyadh',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }
    );
}


/* =========================================================
   Next.js / RSC
========================================================= */

function extractRscScripts(html) {
    const scripts = [];

    const regex =
        /<script[^>]*>([\s\S]*?)<\/script>/gi;

    let match;

    while (
        (match = regex.exec(html))
    ) {
        const text =
            match[1] || '';

        if (
            text.includes(
                'self.__next_f.push'
            )
        ) {
            scripts.push(text);
        }
    }

    return scripts;
}

function extractRscStrings(html) {
    const scripts =
        extractRscScripts(html);

    const output = [];

    for (const script of scripts) {
        const regex =
            /self\.__next_f\.push\(\s*\[\s*\d+\s*,\s*(".*?")\s*\]\s*\)/gs;

        let match;

        while (
            (match = regex.exec(script))
        ) {
            try {
                output.push(
                    JSON.parse(match[1])
                );
            } catch {
                output.push(
                    match[1]
                );
            }
        }
    }

    return output;
}

function extractValue(
    text,
    keys
) {
    for (const key of keys) {
        const patterns = [
            new RegExp(
                `"${key}"\\s*:\\s*"([^"]*)"`
            ),
            new RegExp(
                `"${key}"\\s*:\\s*([^,}\\n]+)`
            )
        ];

        for (const pattern of patterns) {
            const match =
                text.match(pattern);

            if (match) {
                return String(
                    match[1]
                )
                    .replace(
                        /^["']|["']$/g,
                        ''
                    )
                    .trim();
            }
        }
    }

    return '';
}

function findListingUrl(
    chunk,
    id
) {
    const patterns = [
        new RegExp(
            `"url"\\s*:\\s*"([^"]*${id}[^"]*)"`
        ),
        new RegExp(
            `"(?:href|link)"\\s*:\\s*"([^"]*${id}[^"]*)"`
        )
    ];

    for (const pattern of patterns) {
        const match =
            chunk.match(pattern);

        if (match) {
            return decodeHtml(
                match[1]
            )
                .replace(
                    /\\u002F/g,
                    '/'
                )
                .replace(
                    /\\\//g,
                    '/'
                );
        }
    }

    return '';
}

function parseListingChunk(
    chunk,
    id
) {
    const title =
        extractValue(
            chunk,
            [
                'title',
                'name',
                'propertyTitle'
            ]
        );

    const description =
        extractValue(
            chunk,
            [
                'description',
                'desc'
            ]
        );

    const price =
        extractValue(
            chunk,
            [
                'price',
                'priceValue'
            ]
        );

    const area =
        extractValue(
            chunk,
            [
                'area',
                'areaSqm',
                'area_sqm'
            ]
        );

    const cityName =
        extractValue(
            chunk,
            [
                'city',
                'cityName'
            ]
        );

    const districtName =
        extractValue(
            chunk,
            [
                'district',
                'districtName'
            ]
        );

    const bedrooms =
        extractValue(
            chunk,
            [
                'bedrooms',
                'beds',
                'rooms'
            ]
        );

    const bathrooms =
        extractValue(
            chunk,
            [
                'bathrooms',
                'baths'
            ]
        );

    const image =
        extractValue(
            chunk,
            [
                'mainImage',
                'image',
                'imageUrl',
                'coverPhoto'
            ]
        );

    const postedRaw =
        extractValue(
            chunk,
            [
                'postedAt',
                'createdAt',
                'created_at',
                'publishedAt',
                'published_at'
            ]
        );

    const isFeatured =
        /"isFeatured"\s*:\s*true/i
            .test(chunk) ||
        /"isPremium"\s*:\s*true/i
            .test(chunk);

    if (isFeatured) {
        return null;
    }

    if (
        !title &&
        !price &&
        !description
    ) {
        return null;
    }

    const type =
        /إيجار|للايجار|للإيجار/
            .test(
                `${title} ${description}`
            )
            ? 'rent'
            : 'sale';

    const url =
        findListingUrl(
            chunk,
            id
        );

    return {
        _raw_id: id,

        name: title,

        priceSar:
            price.replace(
                /,/g,
                ''
            ),

        listing_type: type,

        area_sqm:
            area.replace(
                /,/g,
                ''
            ),

        city: cityName,

        district: districtName,

        description,

        bedrooms,

        bathrooms,

        postedRaw,

        postedDate:
            parseDate(postedRaw),

        images:
            image
                ? [image]
                : [],

        has_image:
            Boolean(image),

        url:
            url ||
            `https://sa.aqar.fm/${id}`
    };
}

function findListingObjects(html) {
    const strings =
        extractRscStrings(html);

    const combined =
        strings.join('\n');

    const objects = [];
    const used = new Set();

    const patterns = [
        /"id"\s*:\s*"(\d{5,})"/g,
        /"id"\s*:\s*(\d{5,})/g,
        /"propertyId"\s*:\s*"(\d{5,})"/g,
        /"property_id"\s*:\s*"(\d{5,})"/g
    ];

    const ids = [];

    for (const pattern of patterns) {
        let match;

        while (
            (match =
                pattern.exec(combined))
        ) {
            const id =
                String(match[1]);

            if (!used.has(id)) {
                used.add(id);
                ids.push(id);
            }
        }
    }

    for (const id of ids) {
        const index =
            combined.indexOf(
                `"${id}"`
            );

        if (index < 0) {
            continue;
        }

        const start =
            Math.max(
                0,
                index - 4000
            );

        const end =
            Math.min(
                combined.length,
                index + 12000
            );

        const chunk =
            combined.slice(
                start,
                end
            );

        const item =
            parseListingChunk(
                chunk,
                id
            );

        if (item) {
            objects.push(item);
        }
    }

    return objects;
}


/* =========================================================
   استخراج بطاقات HTML كخطة احتياطية
========================================================= */

function parseDomCards(html) {
    const results = [];
    const ids = new Set();

    const regex =
        /href=["']([^"']*-(\d{5,})(?:[?#][^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gi;

    let match;

    while (
        (match = regex.exec(html))
    ) {
        const url =
            decodeHtml(match[1]);

        const id =
            match[2];

        if (ids.has(id)) {
            continue;
        }

        ids.add(id);

        const text =
            stripTags(match[3]);

        if (!text) {
            continue;
        }

        if (/^مميز/.test(text)) {
            continue;
        }

        const price =
            text.match(
                /([\d,]+(?:\.\d+)?)\s*(?:ر\.س|ريال|﷼)/
            )?.[1] || '';

        const area =
            text.match(
                /([\d,]+)\s*م²/
            )?.[1] || '';

        results.push({
            _raw_id: id,

            name:
                text.split(/\s{2,}/)[0] ||
                text.slice(0, 100),

            priceSar:
                price.replace(/,/g, ''),

            listing_type:
                /إيجار|للإيجار|للايجار/
                    .test(text)
                    ? 'rent'
                    : 'sale',

            area_sqm:
                area.replace(/,/g, ''),

            description:
                text,

            url:
                url.startsWith('http')
                    ? url
                    : `https://sa.aqar.fm${url}`,

            images: [],

            has_image: false
        });
    }

    return results;
}

function mergeListings(
    primary,
    fallback
) {
    const map = new Map();

    for (const item of fallback) {
        map.set(
            item._raw_id,
            item
        );
    }

    for (const item of primary) {
        const old =
            map.get(item._raw_id);

        map.set(
            item._raw_id,
            {
                ...old,
                ...item,
                url:
                    item.url ||
                    old?.url ||
                    ''
            }
        );
    }

    return [...map.values()];
}


/* =========================================================
   HTTP
========================================================= */

async function fetchText(
    url,
    timeout = 30000
) {
    const controller =
        new AbortController();

    const timer =
        setTimeout(
            () => controller.abort(),
            timeout
        );

    try {
        const response =
            await fetch(
                url,
                {
                    headers: {
                        'User-Agent':
                            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',

                        'Accept':
                            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',

                        'Accept-Language':
                            'ar-SA,ar;q=0.9,en;q=0.8',

                        'Cache-Control':
                            'no-cache'
                    },

                    signal:
                        controller.signal
                }
            );

        if (!response.ok) {
            throw new Error(
                `HTTP ${response.status}`
            );
        }

        return await response.text();

    } finally {
        clearTimeout(timer);
    }
}


/* =========================================================
   تفاصيل الإعلان - HTTP
========================================================= */

function parseDetailHtml(html) {
    const text =
        stripTags(html);

    let phone =
        extractPhone(text);

    let postedDate = null;
    let postedRaw = '';

    let bedrooms = '';
    let bathrooms = '';

    let ownerName = '';
    let license = '';

    let verified = false;

    const datePatterns = [
        /تاريخ الإضافة\s*[:：-]?\s*([^\n]{1,80})/i,
        /تاريخ الإعلان\s*[:：-]?\s*([^\n]{1,80})/i,
        /أضيف\s*[:：-]?\s*([^\n]{1,80})/i
    ];

    for (const pattern of datePatterns) {
        const match =
            text.match(pattern);

        if (!match) {
            continue;
        }

        const date =
            parseDate(match[1]);

        if (date) {
            postedRaw =
                match[1].trim();

            postedDate =
                date;

            break;
        }
    }

    if (!postedDate) {
        const iso =
            html.match(
                /"(?:createdAt|created_at|postedAt|publishedAt|published_at)"\s*:\s*"([^"]+)"/
            );

        if (iso) {
            const date =
                parseDate(iso[1]);

            if (date) {
                postedRaw =
                    iso[1];

                postedDate =
                    date;
            }
        }
    }

    bedrooms =
        text.match(
            /(\d+)\s*(?:غرف|غرفة)/
        )?.[1] || '';

    bathrooms =
        text.match(
            /(\d+)\s*(?:حمامات|حمام)/
        )?.[1] || '';

    const licenseMatch =
        text.match(
            /(?:رخصة فال|رخصه فال|فال|ترخيص)\s*:?\s*(\d{6,})/
        );

    if (licenseMatch) {
        license =
            licenseMatch[1];
    }

    const ownerMatch =
        text.match(
            /(?:المعلن|المعلن عنه|صاحب الإعلان)\s*:?\s*([^\n]{2,80})/
        );

    if (ownerMatch) {
        ownerName =
            ownerMatch[1].trim();
    }

    verified =
        /موثق|موثقة|verified/i
            .test(text);

    return {
        phone,
        postedDate,
        postedRaw,
        bedrooms,
        bathrooms,
        ownerName,
        license,
        verified
    };
}


/* =========================================================
   Playwright للهاتف فقط
========================================================= */

async function getBrowser() {
    if (browser) {
        return browser;
    }

    log.info(
        '🌐 تشغيل متصفح الهاتف...'
    );

    browser =
        await chromium.launch({
            headless: true,

            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-background-networking'
            ]
        });

    return browser;
}

async function phoneFromPage(page) {

    // 1) tel links
    let phone =
        await page.evaluate(() => {
            const links =
                [...document.querySelectorAll(
                    'a[href^="tel:"], a[href*="tel:"], a[href*="phone"]'
                )];

            for (const link of links) {
                const href =
                    link.getAttribute('href') || '';

                const text =
                    link.textContent || '';

                const value =
                    `${href} ${text}`;

                const match =
                    value.match(
                        /(?:\+966|00966|966|0)?[\s\-().]*5[\s\-().]*\d{8}/
                    );

                if (match) {
                    return match[0];
                }
            }

            return '';
        });

    phone =
        extractPhone(phone);

    if (phone) {
        return phone;
    }

    // 2) البحث في HTML نفسه
    const html =
        await page.content();

    phone =
        extractPhone(html);

    if (phone) {
        return phone;
    }

    // 3) محاولة الضغط على اتصال
    const selectors = [
        'text=اتصال',
        'text=اتصل',
        'button:has-text("اتصال")',
        'a:has-text("اتصال")'
    ];

    for (const selector of selectors) {
        try {
            const locator =
                page.locator(selector);

            const count =
                await locator.count();

            if (!count) {
                continue;
            }

            await locator
                .first()
                .click({
                    timeout: 4000
                })
                .catch(() => {});

            await page.waitForTimeout(1000);

            break;

        } catch {
            // نجرب selector التالي
        }
    }

    // 4) بعد الضغط: tel
    phone =
        await page.evaluate(() => {
            const links =
                [...document.querySelectorAll(
                    'a[href^="tel:"], a[href*="tel:"], a[href*="phone"]'
                )];

            return links
                .map(link =>
                    `${link.getAttribute('href') || ''} ${link.textContent || ''}`
                )
                .join(' ');
        });

    phone =
        extractPhone(phone);

    if (phone) {
        return phone;
    }

    // 5) بعد الضغط: body
    const bodyText =
        await page.locator('body')
            .innerText()
            .catch(() => '');

    phone =
        extractPhone(bodyText);

    return phone || '';
}

async function fetchPhoneWithBrowser(
    listing
) {
    if (!listing?.url) {
        return '';
    }

    let page = null;

    try {
        const browser =
            await getBrowser();

        page =
            await browser.newPage({
                viewport: {
                    width: 1280,
                    height: 900
                },

                locale: 'ar-SA',

                userAgent:
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36'
            });

        // نمنع الصور والخطوط والإعلانات
        // لتقليل الوقت واستهلاك CPU
        await page.route(
            '**/*',
            async route => {
                const type =
                    route.request().resourceType();

                if (
                    [
                        'image',
                        'font',
                        'media'
                    ].includes(type)
                ) {
                    await route.abort()
                        .catch(() => {});
                } else {
                    await route.continue()
                        .catch(() => {});
                }
            }
        );

        await page.goto(
            listing.url,
            {
                waitUntil:
                    'domcontentloaded',

                timeout: 20000
            }
        );

        await page.waitForTimeout(700);

        const phone =
            await phoneFromPage(page);

        if (phone) {
            log.info(
                `📱 الهاتف ${listing._raw_id}: ${phone}`
            );

            return phone;
        }

        log.warning(
            `⚠️ لم يظهر الهاتف: ${listing._raw_id}`
        );

        return '';

    } catch (error) {
        log.warning(
            `⚠️ فشل استخراج الهاتف ${listing._raw_id}: ${error.message}`
        );

        return '';

    } finally {
        if (page) {
            await page.close()
                .catch(() => {});
        }
    }
}


/* =========================================================
   تفاصيل كاملة
========================================================= */

async function fetchDetail(listing) {
    if (!listing?.url) {
        return null;
    }

    try {
        const html =
            await fetchText(
                listing.url,
                20000
            );

        const detail =
            parseDetailHtml(html);

        /*
         * إذا لم نجد الهاتف في HTTP
         * نستخدم Playwright فقط هنا.
         */
        if (
            FETCH_PHONE &&
            !detail.phone
        ) {
            detail.phone =
                await fetchPhoneWithBrowser(
                    listing
                );
        }

        return detail;

    } catch (error) {
        log.warning(
            `⚠️ HTTP detail ${listing._raw_id}: ${error.message}`
        );

        /*
         * حتى إذا فشل HTTP،
         * نحاول الهاتف مباشرة.
         */
        if (FETCH_PHONE) {
            const phone =
                await fetchPhoneWithBrowser(
                    listing
                );

            if (phone) {
                return {
                    phone,

                    postedDate: null,
                    postedRaw: '',

                    bedrooms: '',
                    bathrooms: '',

                    ownerName: '',
                    license: '',

                    verified: false
                };
            }
        }

        return null;
    }
}


/* =========================================================
   التوازي
========================================================= */

async function mapConcurrent(
    items,
    limit,
    worker
) {
    const output =
        new Array(items.length);

    let index = 0;

    async function runner() {
        while (true) {
            const current =
                index++;

            if (
                current >=
                items.length
            ) {
                return;
            }

            try {
                output[current] =
                    await worker(
                        items[current],
                        current
                    );
            } catch (error) {
                log.warning(
                    `⚠️ Worker error: ${error.message}`
                );

                output[current] =
                    null;
            }
        }
    }

    const workers =
        Array.from(
            {
                length:
                    Math.min(
                        limit,
                        items.length
                    )
            },
            () => runner()
        );

    await Promise.all(
        workers
    );

    return output;
}


/* =========================================================
   صفحة البحث
========================================================= */

async function processPage(
    pageNumber
) {
    const url =
        getPageUrl(pageNumber);

    log.info(
        `📄 فتح صفحة ${pageNumber}: ${url}`
    );

    const html =
        await fetchText(
            url,
            30000
        );

    let listings =
        findListingObjects(html);

    const dom =
        parseDomCards(html);

    listings =
        mergeListings(
            listings,
            dom
        );

    log.info(
        `🔎 صفحة ${pageNumber}: ${listings.length} إعلان`
    );

    return listings;
}


/* =========================================================
   جمع الصفحات
========================================================= */

const allListings = [];

for (
    let page = 1;
    page <= MAX_PAGES;
    page++
) {
    if (
        allListings.length >=
        MAX_RESULTS * 4
    ) {
        break;
    }

    try {
        const listings =
            await processPage(page);

        pagesScanned++;

        if (
            listings.length === 0
        ) {
            log.info(
                `ℹ️ لا توجد نتائج إضافية بعد الصفحة ${page}`
            );

            break;
        }

        for (const listing of listings) {
            if (
                !listing._raw_id ||
                seen.has(
                    listing._raw_id
                )
            ) {
                continue;
            }

            seen.add(
                listing._raw_id
            );

            allListings.push(
                listing
            );
        }

    } catch (error) {
        log.warning(
            `⚠️ فشل الصفحة ${page}: ${error.message}`
        );
    }
}

log.info(
    `📦 إجمالي الإعلانات الخام: ${allListings.length}`
);


/* =========================================================
   معالجة التفاصيل
========================================================= */

if (allListings.length > 0) {

    /*
     * نحاول أولاً استخدام التاريخ الموجود
     * في صفحة البحث.
     */
    for (const listing of allListings) {
        if (listing.postedDate) {
            dateFound++;
        }
    }

    /*
     * في وضع اليوم فقط:
     * الإعلان الذي نعرف أنه قديم نستبعده.
     *
     * أما الإعلان الذي لا نعرف تاريخه،
     * فيدخل مرحلة التفاصيل.
     */
    const needDetails =
        allListings.filter(
            listing => {

                if (
                    TODAY_ONLY &&
                    listing.postedDate &&
                    !isToday(
                        listing.postedDate
                    )
                ) {
                    return false;
                }

                return true;
            }
        );

    log.info(
        `⚡ سيتم فحص ${needDetails.length} إعلان بالتفاصيل`
    );

    const details =
        await mapConcurrent(
            needDetails,
            CONCURRENCY,
            async listing => {

                detailsChecked++;

                return {
                    listing,

                    detail:
                        await fetchDetail(
                            listing
                        )
                };
            }
        );

    for (const row of details) {

        if (!row) {
            continue;
        }

        const {
            listing,
            detail
        } = row;

        if (!detail) {
            continue;
        }

        /*
         * التاريخ
         */
        if (
            detail.postedDate
        ) {
            dateFound++;

            listing.postedDate =
                detail.postedDate;

            listing.postedRaw =
                detail.postedRaw;
        } else {
            dateMissing++;
        }

        /*
         * الهاتف
         */
        if (detail.phone) {
            listing.phone =
                detail.phone;

            phonesFound++;
        } else {
            phonesMissing++;
        }

        /*
         * باقي البيانات
         */
        if (detail.bedrooms) {
            listing.bedrooms =
                detail.bedrooms;
        }

        if (detail.bathrooms) {
            listing.bathrooms =
                detail.bathrooms;
        }

        if (detail.ownerName) {
            listing.owner_name =
                detail.ownerName;
        }

        if (detail.license) {
            listing.rega_license =
                detail.license;
        }

        listing.is_verified =
            Boolean(
                detail.verified
            );
    }


    /* =====================================================
       إخراج النتائج
    ===================================================== */

    for (
        const listing of allListings
    ) {

        if (
            results.length >=
            MAX_RESULTS
        ) {
            break;
        }

        /*
         * اليوم فقط
         */
        if (TODAY_ONLY) {

            if (
                !listing.postedDate
            ) {
                continue;
            }

            if (
                !isToday(
                    listing.postedDate
                )
            ) {
                continue;
            }
        }

        const item = {

            _raw_id:
                listing._raw_id,

            name:
                listing.name || '',

            priceSar:
                listing.priceSar || '',

            listing_type:
                listing.listing_type ||
                'sale',

            area_sqm:
                listing.area_sqm || '',

            city:
                listing.city ||
                city,

            district:
                listing.district ||
                district,

            property_type:
                listing.name
                    ?.split(/\s+/)[0] ||
                '',

            description:
                listing.description ||
                '',

            /*
             * الهاتف
             */
            phone:
                listing.phone ||
                '',

            bedrooms:
                listing.bedrooms ||
                '',

            bathrooms:
                listing.bathrooms ||
                '',

            owner_name:
                listing.owner_name ||
                '',

            rega_license:
                listing.rega_license ||
                '',

            is_verified:
                Boolean(
                    listing.is_verified
                ),

            posted_at:
                listing.postedDate
                    ? formatDate(
                        listing.postedDate
                    )
                    : '',

            posted_at_iso:
                listing.postedDate
                    ? listing.postedDate
                        .toISOString()
                    : '',

            date_raw:
                listing.postedRaw ||
                '',

            url:
                listing.url,

            images:
                listing.images ||
                [],

            has_image:
                Boolean(
                    listing.has_image
                ),

            source:
                'aqar',

            scanned_at:
                new Date()
                    .toISOString()
        };

        results.push(item);

        await Actor.pushData(item);

        log.info(
            `✅ ${results.length}/${MAX_RESULTS} | ${item.name.slice(0, 45)} | 📱 ${item.phone || 'بدون هاتف'}`
        );
    }
}


/* =========================================================
   الإحصائيات
========================================================= */

log.info(
    '━━━━━━━━━━━━━━━━━━━━━━'
);

log.info(
    `🎯 النتائج النهائية: ${results.length}`
);

log.info(
    `📄 الصفحات المفحوصة: ${pagesScanned}`
);

log.info(
    `🔎 التفاصيل المفحوصة: ${detailsChecked}`
);

log.info(
    `📅 تواريخ مقروءة: ${dateFound}`
);

log.info(
    `⚠️ بدون تاريخ: ${dateMissing}`
);

log.info(
    `📱 أرقام تم العثور عليها: ${phonesFound}`
);

log.info(
    `📵 أرقام لم يتم العثور عليها: ${phonesMissing}`
);

if (
    results.length === 0 &&
    TODAY_ONLY
) {
    log.warning(
        `⚠️ لم يتم تأكيد أي إعلان بتاريخ ${TODAY}.`
    );
}

if (
    FETCH_PHONE &&
    phonesFound === 0 &&
    results.length > 0
) {
    log.warning(
        '⚠️ ظهرت النتائج لكن لم يتم العثور على أي رقم هاتف.'
    );

    log.warning(
        'قد يكون الهاتف محمياً أو يحتاج آلية مختلفة من موقع عقار.'
    );
}


/* =========================================================
   Webhook
========================================================= */

if (
    webhookUrl &&
    webhookUrl.trim()
) {
    try {

        const datasetId =
            process.env
                .APIFY_DEFAULT_DATASET_ID;

        await fetch(
            webhookUrl.trim(),
            {
                method: 'POST',

                headers: {
                    'Content-Type':
                        'application/json'
                },

                body:
                    JSON.stringify({

                        status:
                            'success',

                        today:
                            TODAY,

                        todayOnly:
                            TODAY_ONLY,

                        search,

                        city,

                        pagesScanned,

                        detailsChecked,

                        resultsCount:
                            results.length,

                        phonesFound,

                        phonesMissing,

                        datasetId,

                        downloadUrl:
                            `https://api.apify.com/v2/datasets/${datasetId}/items?format=json`
                    })
            }
        );

        log.info(
            '✅ Webhook تم إرساله'
        );

    } catch (error) {

        log.warning(
            `⚠️ Webhook: ${error.message}`
        );
    }
}


/* =========================================================
   إغلاق المتصفح
========================================================= */

if (browser) {
    await browser.close()
        .catch(() => {});
}

await Actor.exit();
