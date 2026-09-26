// -*- coding: utf-8 -*-
// أكتور Apify لاستخراج إعلانات عقار (sa.aqar.fm)

import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    // يمكن كتابة مسار كامل جاهز، أو تركه فارغاً واستخدام الحقول أدناه
    startUrl = '',
    search = 'شقق-للبيع',
    city = 'الرياض',
    subArea = '',      // اختياري: مثال "شمال-الرياض"
    district = '',      // اختياري: مثال "حي-الياسمين"
    maxResults = 20,
    fetchPhoneFromDetail = true,
    proxyConfiguration: proxyInput,
    webhookUrl = '',
} = input;

const proxyConfiguration = await Actor.createProxyConfiguration(
    proxyInput || { useApifyProxy: true, groups: ['RESIDENTIAL'] },
);

const finalItems = [];
const seenIds = new Set();

// قائمة أنواع البحث الصحيحة المعروفة في عقار
const VALID_SEARCH_TYPES = [
    'شقق-للبيع', 'شقق-للإيجار', 'فلل-للبيع', 'فلل-للإيجار',
    'أراضي-للبيع', 'أراضي-للإيجار', 'دور-للبيع', 'دور-للإيجار',
    'عمائر-للبيع', 'عمائر-للإيجار', 'محلات-للبيع', 'محلات-للإيجار',
    'مكتب-تجاري-للبيع', 'مكتب-تجاري-للإيجار', 'استراحة-للبيع', 'استراحة-للإيجار',
    'استوديوهات-للبيع', 'استوديوهات-للإيجار', 'مزرعة-للبيع', 'مزرعة-للإيجار',
    'عقارات',
];

// التحقق من صحة كل مدخل قبل بناء أي رابط أو فتح المتصفح
function validateInputs() {
    const errors = [];

    if (startUrl && startUrl.trim()) {
        if (!startUrl.includes('aqar.fm')) {
            errors.push(`startUrl لا يبدو رابط عقار صحيح: ${startUrl}`);
        }
        return errors; // لا حاجة لفحص باقي الحقول إذا استُخدم رابط جاهز
    }

    if (!search || !search.trim()) {
        errors.push('حقل "نوع البحث" فارغ.');
    } else if (!VALID_SEARCH_TYPES.includes(search.trim()) && !/^(.+)-(للبيع|للإيجار)$/.test(search.trim())) {
        errors.push(`"${search}" ليس نوع بحث صحيح. يجب أن ينتهي بـ "-للبيع" أو "-للإيجار" (مثل: فلل-للبيع)، وليس فقط "فلل".`);
    }

    if (!city || !city.trim()) {
        errors.push('حقل "المدينة" فارغ.');
    } else {
        if (/^حي[- ]/.test(city.trim())) {
            errors.push(`"${city}" يبدو أنه اسم حي وليس مدينة. ضع اسم الحي في حقل "الحي" بدلاً من ذلك، مع تحديد المدينة الصحيحة هنا (مثل: الرياض).`);
        }
        if (city.includes(' ')) {
            errors.push(`حقل "المدينة" (${city}) يحتوي مسافة — استخدم شرطة "-" بدل المسافة، أو تأكد أنه اسم مدينة صحيح فقط.`);
        }
    }

    if (subArea && subArea.trim()) {
        if (subArea.includes(' ')) {
            errors.push(`حقل "المنطقة الفرعية" (${subArea}) يحتوي مسافة — استخدم شرطة "-" مثل: شمال-الرياض.`);
        }
        if (VALID_SEARCH_TYPES.includes(subArea.trim()) || /(للبيع|للإيجار)/.test(subArea)) {
            errors.push(`"${subArea}" في حقل "المنطقة الفرعية" يبدو نوع بحث وليس منطقة جغرافية — تحقق من ترتيب الحقول.`);
        }
    }

    if (district && district.trim()) {
        if (!/^حي[-]/.test(district.trim())) {
            errors.push(`حقل "الحي" (${district}) يجب أن يبدأ بـ "حي-" مثل: حي-الياسمين.`);
        }
        if (!subArea || !subArea.trim()) {
            errors.push('تحديد "الحي" يتطلب أيضاً تعبئة "المنطقة الفرعية" (مثل: شمال-الرياض).');
        }
    }

    return errors;
}

// بناء رابط البحث من الأجزاء، أو استخدام startUrl مباشرة إن وُجد
function buildListUrl() {
    if (startUrl && startUrl.trim()) return startUrl.trim();

    const parts = [search.trim(), city.trim()];
    if (subArea && subArea.trim()) parts.push(subArea.trim());
    if (district && district.trim()) parts.push(district.trim());

    const path = parts.map(p => encodeURI(p)).join('/');
    return `https://sa.aqar.fm/${path}`;
}

const extractPhone = (text) => {
    if (!text) return '';
    const match = text.match(/(?:\+?966|0)5[0-9]{8}/);
    if (!match) return '';
    let phone = match[0].replace(/\s|-/g, '');
    if (phone.startsWith('+9665')) phone = '0' + phone.slice(4);
    if (phone.startsWith('9665'))  phone = '0' + phone.slice(3);
    if (phone.startsWith('5'))     phone = '0' + phone;
    return phone;
};

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: 2,
    maxRequestsPerCrawl: maxResults + 60,
    requestHandlerTimeoutSecs: 180,
    navigationTimeoutSecs: 60,

    async requestHandler({ page, request, log: reqLog }) {

        // ==========================================
        // مسار 1: صفحة القائمة
        // ==========================================
        if (request.userData.label === 'LIST') {

            const pageNum = request.userData.pageNum || 1;
            const baseUrl = request.userData.baseUrl;
            const listUrl = pageNum === 1 ? baseUrl : `${baseUrl}/${pageNum}`;

            reqLog.info(`فتح صفحة القائمة رقم ${pageNum}: ${listUrl}`);

            const response = await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

            const status = response?.status();
            if (status && status >= 400) {
                reqLog.error(`⚠️ الرابط أعاد حالة ${status} — تحقق من صحة المسار: ${listUrl}`);
                return;
            }

            const noResultsFound = await page.evaluate(() => {
                const text = document.body.innerText || '';
                return /لا توجد نتائج|لم يتم العثور|no results/i.test(text);
            });
            if (noResultsFound) {
                reqLog.warning(`⚠️ الصفحة لا تحتوي نتائج — تحقق من صحة المسار أو جرّب مسار آخر: ${listUrl}`);
                return;
            }

            try {
                await page.waitForSelector('a[href*="-"]', { timeout: 15000 });
            } catch {
                reqLog.warning('لم تظهر بطاقات، سيتم المتابعة...');
            }
            await page.waitForTimeout(1500);

            const cards = await page.evaluate(() => {
                const results = [];
                const seen = new Set();

                const links = Array.from(document.querySelectorAll('a[href]'))
                    .filter(a => a.href.match(/-\d{5,}$/) && a.href.includes('sa.aqar.fm'));

                for (const link of links) {
                    const href = link.href;
                    const idMatch = href.match(/-(\d{5,})$/);
                    if (!idMatch) continue;
                    const id = idMatch[1];
                    if (seen.has(id)) continue;
                    seen.add(id);

                    const fullText = link.innerText || '';
                    const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);
                    const title = lines[0] || '';

                    const priceMatch = fullText.match(/([\d,]+(?:\.\d+)?)\s*§/);
                    const price = priceMatch ? priceMatch[1].replace(/,/g, '') : '';
                    const isRent = /سنوي/.test(fullText);

                    const areaMatch = fullText.match(/([\d,]+)\s*م²/);
                    const area = areaMatch ? areaMatch[1].replace(/,/g, '') : '';

                    const districtMatch = title.match(/حي\s+([^\,،]+)/);
                    const cityMatch = title.match(/مدينة\s+([^\,،]+)/);
                    const districtName = districtMatch ? districtMatch[1].trim() : '';
                    const cityName = cityMatch ? cityMatch[1].trim() : '';

                    const propTypeMatch = title.match(/^([\u0600-\u06FF]+)\s+(?:للبيع|للإيجار)/);
                    const propertyType = propTypeMatch ? propTypeMatch[1].trim() : '';

                    const description = lines.slice(1).join(' ').trim();

                    const phoneMatch = fullText.match(/(?:\+?966|0)5[0-9]{8}/);
                    let phone = '';
                    if (phoneMatch) {
                        phone = phoneMatch[0].replace(/\s|-/g, '');
                        if (phone.startsWith('+9665')) phone = '0' + phone.slice(4);
                        if (phone.startsWith('9665'))  phone = '0' + phone.slice(3);
                        if (phone.startsWith('5'))     phone = '0' + phone;
                    }

                    const imgEl = link.querySelector('img');
                    const imgSrc = imgEl?.src || imgEl?.getAttribute('data-src') || '';

                    results.push({
                        _raw_id: id,
                        name: title,
                        priceSar: price,
                        listing_type: isRent ? 'rent' : 'sale',
                        area_sqm: area,
                        district: districtName,
                        city: cityName,
                        property_type: propertyType,
                        description,
                        phone,
                        has_image: !!imgSrc,
                        images: imgSrc ? [imgSrc] : [],
                        url: href,
                    });
                }
                return results;
            });

            let newCount = 0;
            for (const card of cards) {
                if (seenIds.has(card._raw_id)) continue;
                if (finalItems.length >= maxResults) break;
                seenIds.add(card._raw_id);

                card.source = 'aqar';
                card.bedrooms = '';
                card.bathrooms = '';
                card.owner_name = '';
                card.rega_license = '';
                card.is_verified = false;
                card.posted_at = '';
                card.posted_at_iso = '';
                card.scanned_at = new Date().toISOString();

                const licenseMatch = card.description.match(/(?:رخصة فال|رخصه فال|ترخيص)\s*:?\s*(\d{6,})/);
                if (licenseMatch) card.rega_license = licenseMatch[1];

                finalItems.push(card);
                newCount++;
            }

            reqLog.info(`تم جمع ${finalItems.length} إعلان حتى الآن (صفحة ${pageNum}) — ${cards.length} بطاقة وُجدت في هذه الصفحة`);

            if (cards.length === 0) {
                reqLog.warning(`⚠️ لم يُعثر على أي بطاقة إعلان في الصفحة. تحقق من صحة الرابط: ${listUrl}`);
            }

            if (finalItems.length < maxResults && newCount > 0 && pageNum < 50) {
                await crawler.addRequests([{
                    url: `${baseUrl}#page${pageNum + 1}`,
                    uniqueKey: `list-page-${pageNum + 1}`,
                    userData: { label: 'LIST', pageNum: pageNum + 1, baseUrl },
                }]);
            }

            if (fetchPhoneFromDetail) {
                for (const item of cards) {
                    if (!item.phone) {
                        await crawler.addRequests([{
                            url: item.url,
                            userData: { label: 'DETAIL', rawId: item._raw_id },
                        }]);
                    }
                }
            }

        // ==========================================
        // مسار 2: صفحة تفاصيل الإعلان
        // ==========================================
        } else if (request.userData.label === 'DETAIL') {

            const rawId = request.userData.rawId;
            reqLog.info(`فتح تفاصيل الإعلان ${rawId}`);

            await page.route('**/*', (route) => {
                const type = route.request().resourceType();
                if (['image', 'media', 'font'].includes(type)) {
                    route.abort();
                } else {
                    route.continue();
                }
            });

            await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(1500);

            try {
                const callBtn = await page.$('button:has-text("اتصال"), a:has-text("اتصال"), [class*="call"], [class*="phone"]');
                if (callBtn) {
                    await callBtn.click({ timeout: 3000 }).catch(() => {});
                    await page.waitForTimeout(1500);
                }
            } catch { /* تجاهل */ }

            const pageText = await page.evaluate(() => document.body.innerText || '');
            let phone = extractPhone(pageText);

            if (!phone) {
                const telHref = await page.evaluate(() => {
                    const el = document.querySelector('a[href^="tel:"]');
                    return el ? el.href : '';
                });
                if (telHref) phone = telHref.replace('tel:', '').trim();
            }

            const nextDataText = await page.evaluate(() => {
                const el = document.querySelector('#__NEXT_DATA__');
                return el ? el.textContent : null;
            });

            let posted_at = '';
            let posted_at_iso = '';
            let bedrooms = '';
            let bathrooms = '';
            let owner_name = '';
            let is_verified = false;
            let rega_license = '';

            if (nextDataText) {
                try {
                    const data = JSON.parse(nextDataText);
                    let propObj = null;
                    const findProp = (obj, depth = 0) => {
                        if (depth > 15 || propObj || !obj || typeof obj !== 'object') return;
                        if ((obj.title || obj.name) && (obj.price || obj.createdAt || obj.created_at)) {
                            propObj = obj;
                            return;
                        }
                        for (const val of Object.values(obj)) findProp(val, depth + 1);
                    };
                    findProp(data);

                    if (propObj) {
                        owner_name   = propObj.advertiser_name || propObj.owner_name || propObj.user?.name || '';
                        is_verified  = !!(propObj.is_verified || propObj.verified);
                        rega_license = propObj.fal_license || propObj.rega_license || rega_license;
                        bedrooms     = String(propObj.rooms || propObj.bedrooms || '');
                        bathrooms    = String(propObj.bathrooms || '');

                        const nextPhone = propObj.phone || propObj.mobile || propObj.contact_phone || '';
                        if (nextPhone && !phone) phone = extractPhone(String(nextPhone)) || String(nextPhone);

                        const rawDate = propObj.created_at || propObj.createdAt || propObj.published_at || '';
                        if (rawDate) {
                            const d = new Date(rawDate);
                            if (!isNaN(d.getTime())) {
                                posted_at_iso = d.toISOString();
                                posted_at = d.toLocaleString('ar-SA', {
                                    timeZone: 'Asia/Riyadh',
                                    year: 'numeric', month: '2-digit', day: '2-digit',
                                    hour: '2-digit', minute: '2-digit',
                                });
                            }
                        }
                    }
                } catch (e) {
                    reqLog.warning(`فشل تحليل __NEXT_DATA__: ${e.message}`);
                }
            }

            if (!posted_at) {
                const domDate = await page.evaluate(() => {
                    const el = document.querySelector('time[datetime], [class*="date"], [class*="publish"]');
                    return el?.getAttribute('datetime') || el?.innerText?.trim() || '';
                });
                if (domDate) {
                    const d = new Date(domDate);
                    if (!isNaN(d.getTime())) {
                        posted_at_iso = d.toISOString();
                        posted_at = d.toLocaleString('ar-SA', {
                            timeZone: 'Asia/Riyadh',
                            year: 'numeric', month: '2-digit', day: '2-digit',
                            hour: '2-digit', minute: '2-digit',
                        });
                    } else {
                        posted_at = domDate;
                    }
                }
            }

            const idx = finalItems.findIndex(i => i._raw_id === rawId);
            if (idx !== -1) {
                if (phone) finalItems[idx].phone = phone;
                finalItems[idx].posted_at     = posted_at;
                finalItems[idx].posted_at_iso = posted_at_iso;
                finalItems[idx].bedrooms      = bedrooms  || finalItems[idx].bedrooms;
                finalItems[idx].bathrooms     = bathrooms || finalItems[idx].bathrooms;
                finalItems[idx].owner_name    = owner_name || finalItems[idx].owner_name;
                finalItems[idx].is_verified   = is_verified;
                finalItems[idx].rega_license  = rega_license || finalItems[idx].rega_license;

                reqLog.info(`✅ ${finalItems[idx].name.slice(0, 40)} | ${finalItems[idx].priceSar} ريال | ${finalItems[idx].phone || 'لا جوال'}`);
            }
        }
    },

    async failedRequestHandler({ request }, error) {
        log.error(`❌ فشل: ${request.url} — ${error.message}`);
    },
});

// ── التحقق من صحة المدخلات قبل فتح أي متصفح أو دفع أي تكلفة ─────────────
const validationErrors = validateInputs();
if (validationErrors.length > 0) {
    log.error('❌ توقف التشغيل قبل البدء بسبب أخطاء في المدخلات:');
    for (const err of validationErrors) {
        log.error(`   • ${err}`);
    }
    log.error('مثال صحيح كامل: search=فلل-للبيع، city=الرياض، subArea=شمال-الرياض، district=حي-الياسمين');
    log.error('أو الأسهل: الصق رابط بحث جاهز من متصفحك في حقل startUrl.');
    await Actor.exit();
    process.exit(0);
}

const initialUrl = buildListUrl();
log.info(`🔗 رابط البحث المُركّب: ${initialUrl}`);

await crawler.run([{
    url: initialUrl,
    userData: { label: 'LIST', pageNum: 1, baseUrl: initialUrl },
}]);

for (const item of finalItems) {
    await Actor.pushData(item);
}

log.info(`🎉 اكتمل! تم استخراج ${finalItems.length} إعلان.`);

if (finalItems.length === 0) {
    log.warning('⚠️ لم يتم استخراج أي إعلان. تأكد من صحة تركيب الرابط: نوع-البحث/المدينة/المنطقة-الفرعية/الحي مثل: فلل-للبيع/الرياض/شمال-الرياض/حي-الياسمين — أو استخدم حقل startUrl لصق رابط جاهز من الموقع.');
}

if (webhookUrl && webhookUrl.trim()) {
    try {
        const datasetId = process.env.APIFY_DEFAULT_DATASET_ID;
        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                status: 'success',
                search,
                city,
                itemsCount: finalItems.length,
                downloadUrl: `https://api.apify.com/v2/datasets/${datasetId}/items?format=json`,
            }),
        });
        log.info('✅ Webhook أُرسل بنجاح.');
    } catch (err) {
        log.error(`❌ فشل Webhook: ${err.message}`);
    }
}

await Actor.exit();
