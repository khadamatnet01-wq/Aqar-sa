// -*- coding: utf-8 -*-
// أكتور Apify لاستخراج إعلانات عقار (sa.aqar.fm)
// الاستراتيجية: استخراج كل البيانات من صفحة القائمة مباشرة (تحتوي كل الحقول)
// ثم فتح صفحة الإعلان فقط عند الحاجة لجوال محجوب بجافاسكريبت

import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    search = 'شقق-للبيع',   // مثال: شقق-للبيع, فلل-للإيجار, أراضي-للبيع
    city = 'الرياض',
    maxResults = 20,
    fetchPhoneFromDetail = true, // فتح صفحة التفاصيل لمحاولة جلب الجوال المحجوب
    proxyConfiguration: proxyInput,
    webhookUrl = '',
} = input;

const proxyConfiguration = await Actor.createProxyConfiguration(
    proxyInput || { useApifyProxy: true, groups: ['RESIDENTIAL'] },
);

const finalItems = [];
const seenIds = new Set();

// استخراج أول جوال سعودي من أي نص
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
        // مسار 1: صفحة القائمة — استخراج البيانات من كل بطاقة
        // ==========================================
        if (request.userData.label === 'LIST') {

            const pageNum = request.userData.pageNum || 1;
            const listUrl = pageNum === 1
                ? `https://sa.aqar.fm/${encodeURI(search)}/${encodeURI(city)}`
                : `https://sa.aqar.fm/${encodeURI(search)}/${encodeURI(city)}/${pageNum}`;

            reqLog.info(`فتح صفحة القائمة رقم ${pageNum}: ${listUrl}`);
            await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

            try {
                await page.waitForSelector('a[href*="-"]', { timeout: 15000 });
            } catch {
                reqLog.warning('لم تظهر بطاقات، سيتم المتابعة...');
            }
            await page.waitForTimeout(1500);

            // استخراج بطاقات الإعلانات من الصفحة
            const cards = await page.evaluate(() => {
                const results = [];
                const seen = new Set();

                // كل بطاقة تنتهي برقم في نهاية الرابط (معرف الإعلان)
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

                    // السطر الأول عادة هو العنوان الكامل
                    const title = lines[0] || '';

                    // السعر: أول رقم يليه § أو "سنوي"
                    const priceMatch = fullText.match(/([\d,]+(?:\.\d+)?)\s*§/);
                    const price = priceMatch ? priceMatch[1].replace(/,/g, '') : '';
                    const isRent = /سنوي/.test(fullText);

                    // المساحة
                    const areaMatch = fullText.match(/([\d,]+)\s*م²/);
                    const area = areaMatch ? areaMatch[1].replace(/,/g, '') : '';

                    // استخراج الحي والمدينة من العنوان (نمط: ... حي X, مدينة Y)
                    const districtMatch = title.match(/حي\s+([^\,،]+)/);
                    const cityMatch = title.match(/مدينة\s+([^\,،]+)/);
                    const district = districtMatch ? districtMatch[1].trim() : '';
                    const cityName = cityMatch ? cityMatch[1].trim() : '';

                    // نوع العقار من بداية العنوان
                    const propTypeMatch = title.match(/^([\u0600-\u06FF]+)\s+(?:للبيع|للإيجار)/);
                    const propertyType = propTypeMatch ? propTypeMatch[1].trim() : '';

                    // الوصف الكامل (باقي الأسطر بعد استبعاد الأرقام والعنوان)
                    const description = lines.slice(1).join(' ').trim();

                    // الجوال إن وُجد صراحة في النص (بعض الإعلانات القديمة)
                    const phone = extractPhoneInline(fullText);

                    // الصورة
                    const imgEl = link.querySelector('img');
                    const imgSrc = imgEl?.src || imgEl?.getAttribute('data-src') || '';

                    results.push({
                        _raw_id: id,
                        name: title,
                        priceSar: price,
                        listing_type: isRent ? 'rent' : 'sale',
                        area_sqm: area,
                        district,
                        city: cityName,
                        property_type: propertyType,
                        description,
                        phone,
                        has_image: !!imgSrc,
                        images: imgSrc ? [imgSrc] : [],
                        url: href,
                    });

                    function extractPhoneInline(text) {
                        const m = text.match(/(?:\+?966|0)5[0-9]{8}/);
                        if (!m) return '';
                        let p = m[0].replace(/\s|-/g, '');
                        if (p.startsWith('+9665')) p = '0' + p.slice(4);
                        if (p.startsWith('9665'))  p = '0' + p.slice(3);
                        if (p.startsWith('5'))     p = '0' + p;
                        return p;
                    }
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

                // استخراج رخصة فال إن وجدت في الوصف
                const licenseMatch = card.description.match(/(?:رخصة فال|رخصه فال|ترخيص)\s*:?\s*(\d{6,})/);
                if (licenseMatch) card.rega_license = licenseMatch[1];

                finalItems.push(card);
                newCount++;
            }

            reqLog.info(`تم جمع ${finalItems.length} إعلان حتى الآن (صفحة ${pageNum})...`);

            // الانتقال للصفحة التالية إذا لم نصل للحد المطلوب
            if (finalItems.length < maxResults && newCount > 0 && pageNum < 50) {
                await crawler.addRequests([{
                    url: `${listUrl}#page${pageNum + 1}`,
                    uniqueKey: `list-page-${pageNum + 1}`,
                    userData: { label: 'LIST', pageNum: pageNum + 1 },
                }]);
            }

            // فتح صفحة كل إعلان لا يحتوي على جوال، لمحاولة كشفه
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
        // مسار 2: صفحة تفاصيل الإعلان — محاولة كشف الجوال المحجوب + تاريخ النشر
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

            // محاولة الضغط على زر "اتصال" لكشف الرقم
            try {
                const callBtn = await page.$('button:has-text("اتصال"), a:has-text("اتصال"), [class*="call"], [class*="phone"]');
                if (callBtn) {
                    await callBtn.click({ timeout: 3000 }).catch(() => {});
                    await page.waitForTimeout(1500);
                }
            } catch { /* تجاهل */ }

            // قراءة كل نص الصفحة بعد محاولة الكشف
            const pageText = await page.evaluate(() => document.body.innerText || '');
            let phone = extractPhone(pageText);

            // Fallback: من رابط tel:
            if (!phone) {
                const telHref = await page.evaluate(() => {
                    const el = document.querySelector('a[href^="tel:"]');
                    return el ? el.href : '';
                });
                if (telHref) phone = telHref.replace('tel:', '').trim();
            }

            // البحث عن __NEXT_DATA__ لتاريخ النشر ومعلومات إضافية
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

            // Fallback لتاريخ النشر من DOM
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

await crawler.run([{
    url: `https://sa.aqar.fm/${encodeURI(search)}/${encodeURI(city)}`,
    userData: { label: 'LIST', pageNum: 1 },
}]);

// دفع كل العناصر النهائية للـ dataset (بعد اكتمال كل المحاولات)
for (const item of finalItems) {
    await Actor.pushData(item);
}

log.info(`🎉 اكتمل! تم استخراج ${finalItems.length} إعلان.`);

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
      
