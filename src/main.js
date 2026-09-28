// -*- coding: utf-8 -*-

import { Actor, log } from 'apify';

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

    concurrency = 8,

    webhookUrl = '',

    proxyConfiguration: proxyInput
} = input;

const MAX_RESULTS =
    Math.max(1, Number(maxResults) || 20);

const MAX_PAGES =
    Math.max(1, Number(maxPagesToScan) || 10);

const CONCURRENCY =
    Math.min(
        20,
        Math.max(1, Number(concurrency) || 8)
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

const TODAY = new Intl.DateTimeFormat(
    'en-CA',
    {
        timeZone: 'Asia/Riyadh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }
).format(new Date());

log.info(`📅 تاريخ الرياض: ${TODAY}`);
log.info(`⚡ HTTP mode`);
log.info(`⚡ Concurrency: ${CONCURRENCY}`);
log.info(`🎯 الحد: ${MAX_RESULTS}`);

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
                '٠١٢٣٤٥٦٧٨٩'
                    .indexOf(d)
            )
        )
        .replace(/[۰-۹]/g, d =>
            String(
                '۰۱۲۳۴۵۶۷۸۹'
                    .indexOf(d)
            )
        );
}

function normalizePhone(value) {
    let phone = arabicDigits(value)
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
            '0' +
            phone;
    }

    return /^05\d{8}$/.test(phone)
        ? phone
        : '';
}

function extractPhone(text) {
    const value =
        arabicDigits(text)
            .replace(/[\s\-().]/g, '');

    const match =
        value.match(
            /(?:\+966|966|0)?5\d{8}/
        );

    return match
        ? normalizePhone(match[0])
        : '';
}

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

    const date = new Date(
        `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T12:00:00+03:00`
    );

    return Number.isNaN(
        date.getTime()
    )
        ? null
        : date;
}

function parseExplicitDate(value) {
    if (!value) return null;

    const text =
        arabicDigits(value)
            .trim();

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
    if (!value) return null;

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

    if (
        Number.isNaN(amount)
    ) {
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
            now.getDate() -
            amount * 7
        );
    } else if (/شهر/.test(unit)) {
        now.setMonth(
            now.getMonth() - amount
        );
    } else if (/سنة/.test(unit)) {
        now.setFullYear(
            now.getFullYear() -
            amount
        );
    }

    return now;
}

function parseDate(value) {
    if (!value) return null;

    return (
        parseExplicitDate(value) ||
        parseRelativeDate(value) ||
        parseNativeDate(value)
    );
}

function parseNativeDate(value) {
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

function isToday(date) {
    if (!date) return false;

    const value =
        new Intl.DateTimeFormat(
            'en-CA',
            {
                timeZone:
                    'Asia/Riyadh',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit'
            }
        ).format(date);

    return value === TODAY;
}

function formatDate(date) {
    if (!date) return '';

    return date.toLocaleString(
        'en-GB',
        {
            timeZone:
                'Asia/Riyadh',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }
    );
}

function listingId(url) {
    const match =
        String(url || '')
            .match(
                /-(\d{5,})(?:\/)?(?:[?#].*)?$/
            );

    return match
        ? match[1]
        : '';
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

/*
 * يحاول استخراج نصوص RSC الخاصة بـ Next.js.
 * عقار يستخدم Next.js App Router، لذلك لا نعتمد
 * على __NEXT_DATA__ فقط.
 */
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
            (match =
                regex.exec(script))
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

function findListingObjects(
    html
) {
    const strings =
        extractRscStrings(html);

    const combined =
        strings.join('\n');

    const objects = [];
    const used = new Set();

    /*
     * نبحث عن كائنات تحتوي على ID
     * ورابط/عنوان/سعر.
     */
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

            if (
                !used.has(id)
            ) {
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

        if (index < 0) continue;

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
                    .replace(/^["']|["']$/g, '')
                    .trim();
            }
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

        city:
            cityName,

        district:
            districtName,

        description,

        bedrooms,

        bathrooms,

        postedRaw,

        postedDate:
            parseDate(
                postedRaw
            ),

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

    for (
        const pattern of patterns
    ) {
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

function parseDomCards(html) {
    const results = [];
    const ids = new Set();

    const regex =
        /href=["']([^"']*-(\d{5,})(?:[?#][^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gi;

    let match;

    while (
        (match =
            regex.exec(html))
    ) {
        const url =
            decodeHtml(
                match[1]
            );

        const id =
            match[2];

        if (
            ids.has(id)
        ) {
            continue;
        }

        ids.add(id);

        const text =
            stripTags(
                match[3]
            );

        if (!text) continue;

        if (
            /^مميز/.test(text)
        ) {
            continue;
        }

        const price =
            text.match(
                /([\d,]+(?:\.\d+)?)\s*(?:ر\.س|ريال|﷼|§)/
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

    for (
        const item of fallback
    ) {
        map.set(
            item._raw_id,
            item
        );
    }

    for (
        const item of primary
    ) {
        const old =
            map.get(
                item._raw_id
            );

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

async function fetchText(
    url,
    timeout = 30000
) {
    const proxy =
        await proxyConfiguration.newUrl();

    const controller =
        new AbortController();

    const timer =
        setTimeout(
            () =>
                controller.abort(),
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
                        controller.signal,

                    ...(proxy
                        ? {
                            dispatcher:
                                undefined
                        }
                        : {})
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

function parseDetailHtml(
    html
) {
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
        /تاريخ الإضافة\s*[:：-]?\s*([^\n]{1,50})/i,
        /تاريخ الإعلان\s*[:：-]?\s*([^\n]{1,50})/i,
        /أضيف\s*[:：-]?\s*([^\n]{1,50})/i
    ];

    for (
        const pattern of datePatterns
    ) {
        const match =
            text.match(pattern);

        if (!match) continue;

        const date =
            parseDate(
                match[1]
            );

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
                parseDate(
                    iso[1]
                );

            if (date) {
                postedRaw =
                    iso[1];

                postedDate =
                    date;
            }
        }
    }

    if (!bedrooms) {
        bedrooms =
            text.match(
                /(\d+)\s*(?:غرف|غرفة)/
            )?.[1] || '';
    }

    if (!bathrooms) {
        bathrooms =
            text.match(
                /(\d+)\s*(?:حمامات|حمام)/
            )?.[1] || '';
    }

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
            ownerMatch[1]
                .trim();
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

async function fetchDetail(
    listing
) {
    if (!listing.url) {
        return null;
    }

    try {
        const html =
            await fetchText(
                listing.url,
                25000
            );

        return parseDetailHtml(
            html
        );

    } catch (error) {
        log.warning(
            `⚠️ detail ${listing._raw_id}: ${error.message}`
        );

        return null;
    }
}

async function mapConcurrent(
    items,
    limit,
    worker
) {
    const output = new Array(
        items.length
    );

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

            output[current] =
                await worker(
                    items[current],
                    current
                );
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
            () =>
                runner()
        );

    await Promise.all(
        workers
    );

    return output;
}

async function processPage(
    pageNumber
) {
    const url =
        getPageUrl(
            pageNumber
        );

    log.info(
        `📄 صفحة ${pageNumber}: ${url}`
    );

    const html =
        await fetchText(
            url,
            30000
        );

    let listings =
        findListingObjects(
            html
        );

    const dom =
        parseDomCards(
            html
        );

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
            await processPage(
                page
            );

        pagesScanned++;

        if (
            listings.length === 0
        ) {
            log.info(
                `ℹ️ لا توجد نتائج إضافية بعد الصفحة ${page}`
            );

            break;
        }

        for (
            const listing of listings
        ) {
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

        continue;
    }
}

log.info(
    `📦 إجمالي الإعلانات الخام: ${allListings.length}`
);

if (
    allListings.length === 0
) {
    log.warning(
        '⚠️ لم يتم العثور على إعلانات.'
    );
} else {
    /*
     * أولاً نحاول الاستفادة من التاريخ
     * الموجود في بيانات صفحة البحث.
     */
    for (
        const listing of allListings
    ) {
        if (
            listing.postedDate
        ) {
            dateFound++;
        }
    }

    /*
     * في وضع اليوم فقط:
     * نفحص تفاصيل الإعلانات التي
     * لا نملك تاريخها.
     *
     * إذا كان لدينا تاريخ اليوم بالفعل
     * لا نحتاج إلى فتح التفاصيل.
     */
    let candidates =
        allListings.filter(
            item => {
                if (
                    TODAY_ONLY &&
                    item.postedDate
                ) {
                    return isToday(
                        item.postedDate
                    );
                }

                return true;
            }
        );

    /*
     * إذا لم يوجد تاريخ في القائمة،
     * نفحص التفاصيل بالتوازي.
     */
    if (
        FETCH_PHONE ||
        TODAY_ONLY ||
        candidates.length <
            MAX_RESULTS
    ) {
        const needDetails =
            allListings.filter(
                item => {
                    if (
                        TODAY_ONLY &&
                        item.postedDate &&
                        !isToday(
                            item.postedDate
                        )
                    ) {
                        return false;
                    }

                    return true;
                }
            );

        log.info(
            `⚡ فحص ${needDetails.length} تفاصيل بتوازي ${CONCURRENCY}`
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

        for (
            const row of details
        ) {
            if (
                !row.detail
            ) {
                continue;
            }

            const {
                listing,
                detail
            } = row;

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

            if (
                detail.phone
            ) {
                listing.phone =
                    detail.phone;
            }

            if (
                detail.bedrooms
            ) {
                listing.bedrooms =
                    detail.bedrooms;
            }

            if (
                detail.bathrooms
            ) {
                listing.bathrooms =
                    detail.bathrooms;
            }

            if (
                detail.ownerName
            ) {
                listing.owner_name =
                    detail.ownerName;
            }

            if (
                detail.license
            ) {
                listing.rega_license =
                    detail.license;
            }

            listing.is_verified =
                detail.verified;
        }

        candidates =
            allListings;
    }

    for (
        const listing of candidates
    ) {
        if (
            results.length >=
            MAX_RESULTS
        ) {
            break;
        }

        if (
            TODAY_ONLY
        ) {
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

        results.push(
            item
        );

        await Actor.pushData(
            item
        );

        log.info(
            `✅ ${results.length}/${MAX_RESULTS} | ${item.name.slice(0, 45)} | ${item.posted_at}`
        );
    }
}

log.info(
    '━━━━━━━━━━━━━━━━━━━━━━'
);

log.info(
    `🎯 النتائج: ${results.length}`
);

log.info(
    `📄 الصفحات: ${pagesScanned}`
);

log.info(
    `🔎 التفاصيل: ${detailsChecked}`
);

log.info(
    `📅 تواريخ مقروءة: ${dateFound}`
);

log.info(
    `⚠️ بدون تاريخ: ${dateMissing}`
);

if (
    results.length === 0 &&
    TODAY_ONLY
) {
    log.warning(
        `⚠️ لم يتم تأكيد أي إعلان بتاريخ ${TODAY}.`
    );

    log.warning(
        'هذا يعني أن النظام لم يجد إعلاناً استطاع تأكيد أنه من اليوم، وليس مجرد تخمين.'
    );
}

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

await Actor.exit();
