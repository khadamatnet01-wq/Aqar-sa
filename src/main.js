// -*- coding: utf-8 -*-
// أكتور Apify لاستخراج إعلانات عقار (sa.aqar.fm)
// وضع "اليوم فقط": يتوقف تلقائياً بمجرد الوصول لأول إعلان أقدم من اليوم،
// لأن الموقع يرتب النتائج بالأحدث أولاً — فلا داعي لمتابعة الزحف بعد ذلك.

import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    startUrl = '',
    search = 'شقق-للبيع',
    city = 'الرياض',
    subArea = '',
    district = '',
    maxResults = 20,
    fetchPhoneFromDetail = true,
    todayOnly = false,          // ⭐ الميزة الجديدة: جلب إعلانات اليوم فقط
    proxyConfiguration: proxyInput,
    webhookUrl = '',
} = input;

// 🔍 تشخيص: يطبع القيمة الفعلية المُستلمة من Apify لهذا الحقل تحديداً،
// لكشف ما إذا كان الخيار وصل فعلاً كـ true أو أنه لم يُستلم أصلاً (undefined/false)
log.info(`🔍 تشخيص المدخلات: todayOnly المُستلم = ${JSON.stringify(input.todayOnly)} (النوع: ${typeof input.todayOnly}) — القيمة الفعلية المستخدمة = ${todayOnly}`);
log.info(`🔍 تشخيص روابط: startUrl="${input.startUrl || '(فارغ)'}" | search="${input.search || '(فارغ)'}" | city="${input.city || '(فارغ)'}" | subArea="${input.subArea || '(فارغ)'}" | district="${input.district || '(فارغ)'}"`);

const proxyConfiguration = await Actor.createProxyConfiguration(
    proxyInput || { useApifyProxy: true, groups: ['RESIDENTIAL'] },
);

const finalItems = [];
const seenIds = new Set();

// تاريخ اليوم بتوقيت الرياض بصيغة YYYY-MM-DD للمقارنة
function getTodayRiyadh() {
    const now = new Date();
    const riyadhStr = now.toLocaleString('en-US', { timeZone: 'Asia/Riyadh' });
    const riyadhDate = new Date(riyadhStr);
    const y = riyadhDate.getFullYear();
    const m = String(riyadhDate.getMonth() + 1).padStart(2, '0');
    const d = String(riyadhDate.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}
const TODAY_RIYADH = getTodayRiyadh();

// مقارنة تاريخ ISO مع تاريخ اليوم (بتوقيت الرياض)
function isFromToday(isoDate) {
    if (!isoDate) return false;
    const d = new Date(isoDate);
    if (isNaN(d.getTime())) return false;
    const dateStr = d.toLocaleString('en-US', { timeZone: 'Asia/Riyadh' });
    const dd = new Date(dateStr);
    const y = dd.getFullYear();
    const m = String(dd.getMonth() + 1).padStart(2, '0');
    const day = String(dd.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}` === TODAY_RIYADH;
}

// هل التاريخ أقدم من اليوم؟ (وليس اليوم نفسه ولا في المستقبل)
function isOlderThanToday(isoDate) {
    if (!isoDate) return false;
    const d = new Date(isoDate);
    if (isNaN(d.getTime())) return false;
    const dateStr = d.toLocaleString('en-US', { timeZone: 'Asia/Riyadh' });
    const dd = new Date(dateStr);
    const y = dd.getFullYear();
    const m = String(dd.getMonth() + 1).padStart(2, '0');
    const day = String(dd.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}` < TODAY_RIYADH;
}

function normalizeSegment(text) {
    if (!text) return '';
    return text.trim().replace(/\s+/g, '-').replace(/^-+|-+$/g, '');
}

function buildListUrl() {
    if (startUrl && startUrl.trim()) return startUrl.trim();

    const parts = [normalizeSegment(search), normalizeSegment(city)];
    const normSubArea = normalizeSegment(subArea);
    const normDistrict = normalizeSegment(district);
    if (normSubArea) parts.push(normSubArea);
    if (normDistrict) parts.push(normDistrict);

    const path = parts.filter(Boolean).map(p => encodeURI(p)).join('/');
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

// استخراج بطاقات صفحة القائمة (بدون تفاصيل الجوال/التاريخ الدقيق)
async function extractListCards(page) {
    return await page.evaluate(() => {
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
}

// فتح صفحة تفاصيل إعلان واحد وجلب الجوال + تاريخ النشر
async function fetchDetail(page, url, reqLog) {
    await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['image', 'media', 'font'].includes(type)) {
            route.abort();
        } else {
            route.continue();
        }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1200);

    if (fetchPhoneFromDetail) {
        try {
            const callBtn = await page.$('button:has-text("اتصال"), a:has-text("اتصال"), [class*="call"], [class*="phone"]');
            if (callBtn) {
                await callBtn.click({ timeout: 3000 }).catch(() => {});
                await page.waitForTimeout(1200);
            }
        } catch { /* تجاهل */ }
    }

    const pageText = await page.evaluate(() => document.body.innerText || '');
    let phone = fetchPhoneFromDetail ? extractPhone(pageText) : '';

    if (fetchPhoneFromDetail && !phone) {
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

    // 🔍 تشخيص لمرة واحدة فقط: يفحص أول إعلان بعمق لمعرفة أين يقع التاريخ فعلاً
    if (!global.__dateDebugDone) {
        global.__dateDebugDone = true;
        reqLog.info(`🔬 [تشخيص عميق - إعلان واحد فقط] __NEXT_DATA__ موجود؟ ${!!nextDataText} | الحجم: ${nextDataText ? nextDataText.length : 0} حرف`);

        if (nextDataText) {
            try {
                const debugData = JSON.parse(nextDataText);
                const dateLikeFindings = [];
                const seenPaths = new Set();

                const scanForDates = (obj, path = '', depth = 0) => {
                    if (depth > 12 || !obj || typeof obj !== 'object') return;
                    for (const [key, value] of Object.entries(obj)) {
                        const fullPath = path ? `${path}.${key}` : key;
                        if (/date|created|publish|time|added|posted|updated|issue/i.test(key)) {
                            if (!seenPaths.has(fullPath) && (typeof value === 'string' || typeof value === 'number')) {
                                seenPaths.add(fullPath);
                                dateLikeFindings.push(`${fullPath} = ${JSON.stringify(value)}`);
                            }
                        }
                        if (value && typeof value === 'object' && dateLikeFindings.length < 40) {
                            scanForDates(value, fullPath, depth + 1);
                        }
                    }
                };
                scanForDates(debugData);

                if (dateLikeFindings.length > 0) {
                    reqLog.info(`🔬 حقول تشبه التاريخ وُجدت في __NEXT_DATA__ (${dateLikeFindings.length}):`);
                    for (const f of dateLikeFindings.slice(0, 30)) {
                        reqLog.info(`   • ${f}`);
                    }
                } else {
                    reqLog.info('🔬 لا يوجد أي حقل يشبه التاريخ في __NEXT_DATA__ إطلاقاً.');
                }
            } catch (e) {
                reqLog.warning(`🔬 فشل تحليل __NEXT_DATA__ أثناء التشخيص: ${e.message}`);
            }
        }

        // فحص DOM أيضاً عن أي نص يحتوي كلمات دالة على تاريخ النشر
        const domDateHints = await page.evaluate(() => {
            const hints = [];
            const all = document.querySelectorAll('*');
            const re = /نُشر|تاريخ النشر|تاريخ الإضافة|منذ|added|posted/i;
            for (const el of all) {
                if (el.children.length === 0 && el.textContent && re.test(el.textContent) && el.textContent.length < 60) {
                    hints.push(`<${el.tagName.toLowerCase()} class="${el.className}"> = "${el.textContent.trim()}"`);
                    if (hints.length >= 15) break;
                }
            }
            return hints;
        });
        if (domDateHints.length > 0) {
            reqLog.info(`🔬 عناصر DOM تحتوي كلمات دالة على تاريخ (${domDateHints.length}):`);
            for (const h of domDateHints) reqLog.info(`   • ${h}`);
        } else {
            reqLog.info('🔬 لا يوجد عنصر DOM ظاهر يحتوي كلمات دالة على تاريخ النشر.');
        }
    }

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

                if (fetchPhoneFromDetail) {
                    const nextPhone = propObj.phone || propObj.mobile || propObj.contact_phone || '';
                    if (nextPhone && !phone) phone = extractPhone(String(nextPhone)) || String(nextPhone);
                }

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

    return { phone, posted_at, posted_at_iso, bedrooms, bathrooms, owner_name, is_verified, rega_license };
}

let stopCrawling = false; // علم يوقف الزحف بالكامل عند بلوغ إعلان أقدم من اليوم

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: 1, // ⭐ تسلسلي إجبارياً في وضع اليوم لضمان التوقف الدقيق عند أول إعلان قديم
    maxRequestsPerCrawl: todayOnly ? 300 : maxResults + 60,
    requestHandlerTimeoutSecs: 600,
    navigationTimeoutSecs: 60,

    async requestHandler({ page, request, log: reqLog }) {

        if (stopCrawling) return;

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
                reqLog.error(`⚠️ الرابط أعاد حالة ${status}: ${listUrl}`);
                return;
            }

            const noResultsFound = await page.evaluate(() => {
                const text = document.body.innerText || '';
                return /لا توجد نتائج|لم يتم العثور|no results/i.test(text);
            });
            if (noResultsFound) {
                reqLog.warning(`⚠️ لا نتائج في: ${listUrl}`);
                return;
            }

            try {
                await page.waitForSelector('a[href*="-"]', { timeout: 15000 });
            } catch {
                reqLog.warning('لم تظهر بطاقات، سيتم المتابعة...');
            }
            await page.waitForTimeout(1500);

            const cards = await extractListCards(page);

            if (cards.length === 0) {
                reqLog.warning(`⚠️ لا بطاقات في هذه الصفحة: ${listUrl}`);
                return;
            }

            reqLog.info(`وُجدت ${cards.length} بطاقة في صفحة ${pageNum}`);

            // ==========================================
            // وضع "اليوم فقط": نفتح كل إعلان بالتسلسل داخل نفس معالج الصفحة
            // ونتوقف فوراً عند أول إعلان أقدم من اليوم
            // ==========================================
            if (todayOnly) {
                let sawOlderThanToday = false;

                for (const card of cards) {
                    if (finalItems.length >= maxResults) {
                        stopCrawling = true;
                        break;
                    }
                    if (seenIds.has(card._raw_id)) continue;

                    const detail = await fetchDetail(page, card.url, reqLog);

                    // إن لم يوجد تاريخ نشر إطلاقاً، لا يمكن الحكم — نتجاهل الإعلان بدل تخمين قبوله
                    if (!detail.posted_at_iso) {
                        reqLog.warning(`⚠️ لا يوجد تاريخ نشر واضح، تم تجاوز الإعلان: ${card.url}`);
                        continue;
                    }

                    if (isOlderThanToday(detail.posted_at_iso)) {
                        reqLog.info(`⏹️ وُصل لإعلان أقدم من اليوم (${detail.posted_at}) — إيقاف الزحف.`);
                        sawOlderThanToday = true;
                        break;
                    }

                    if (!isFromToday(detail.posted_at_iso)) {
                        // تاريخ في المستقبل أو غير متوقع — نتجاوزه بحذر دون إيقاف الزحف
                        reqLog.warning(`⚠️ تاريخ غير متوقع (${detail.posted_at})، تم تجاوز الإعلان.`);
                        continue;
                    }

                    // الإعلان من اليوم فعلاً ← نحتفظ به
                    seenIds.add(card._raw_id);
                    card.source = 'aqar';
                    card.phone = detail.phone || card.phone;
                    card.posted_at = detail.posted_at;
                    card.posted_at_iso = detail.posted_at_iso;
                    card.bedrooms = detail.bedrooms;
                    card.bathrooms = detail.bathrooms;
                    card.owner_name = detail.owner_name;
                    card.is_verified = detail.is_verified;
                    card.rega_license = detail.rega_license || '';
                    card.scanned_at = new Date().toISOString();

                    const licenseMatch = card.description.match(/(?:رخصة فال|رخصه فال|ترخيص)\s*:?\s*(\d{6,})/);
                    if (!card.rega_license && licenseMatch) card.rega_license = licenseMatch[1];

                    finalItems.push(card);
                    reqLog.info(`✅ [اليوم] ${card.name.slice(0, 40)} | ${card.priceSar} ريال | ${card.phone || 'لا جوال'} | ${card.posted_at}`);
                }

                if (sawOlderThanToday || stopCrawling) {
                    return; // لا ننتقل للصفحة التالية إطلاقاً
                }

                // كل بطاقات هذه الصفحة كانت من اليوم → قد توجد المزيد في الصفحة التالية
                if (finalItems.length < maxResults && pageNum < 50) {
                    await crawler.addRequests([{
                        url: `${baseUrl}#page${pageNum + 1}`,
                        uniqueKey: `list-page-${pageNum + 1}`,
                        userData: { label: 'LIST', pageNum: pageNum + 1, baseUrl },
                    }]);
                }

            // ==========================================
            // الوضع العادي (بدون فلترة تاريخ)
            // ==========================================
            } else {
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

                reqLog.info(`تم جمع ${finalItems.length} إعلان حتى الآن (صفحة ${pageNum})`);

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
            }

        // ==========================================
        // مسار 2: صفحة تفاصيل الإعلان (الوضع العادي فقط)
        // ==========================================
        } else if (request.userData.label === 'DETAIL') {

            const rawId = request.userData.rawId;
            reqLog.info(`فتح تفاصيل الإعلان ${rawId}`);

            const detail = await fetchDetail(page, request.url, reqLog);

            const idx = finalItems.findIndex(i => i._raw_id === rawId);
            if (idx !== -1) {
                if (detail.phone) finalItems[idx].phone = detail.phone;
                finalItems[idx].posted_at     = detail.posted_at;
                finalItems[idx].posted_at_iso = detail.posted_at_iso;
                finalItems[idx].bedrooms      = detail.bedrooms  || finalItems[idx].bedrooms;
                finalItems[idx].bathrooms     = detail.bathrooms || finalItems[idx].bathrooms;
                finalItems[idx].owner_name    = detail.owner_name || finalItems[idx].owner_name;
                finalItems[idx].is_verified   = detail.is_verified;
                finalItems[idx].rega_license  = detail.rega_license || finalItems[idx].rega_license;

                reqLog.info(`✅ ${finalItems[idx].name.slice(0, 40)} | ${finalItems[idx].priceSar} ريال | ${finalItems[idx].phone || 'لا جوال'}`);
            }
        }
    },

    async failedRequestHandler({ request }, error) {
        log.error(`❌ فشل: ${request.url} — ${error.message}`);
    },
});

const initialUrl = buildListUrl();
log.info(`🔗 رابط البحث المُركّب: ${initialUrl}`);
if (todayOnly) {
    log.info(`📅 وضع "اليوم فقط" مُفعّل — التاريخ المستهدف: ${TODAY_RIYADH} (توقيت الرياض)`);
}

await crawler.run([{
    url: initialUrl,
    userData: { label: 'LIST', pageNum: 1, baseUrl: initialUrl },
}]);

for (const item of finalItems) {
    await Actor.pushData(item);
}

log.info(`🎉 اكتمل! تم استخراج ${finalItems.length} إعلان${todayOnly ? ' من اليوم' : ''}.`);

if (finalItems.length === 0) {
    log.warning('⚠️ لم يتم استخراج أي إعلان. تأكد من صحة الرابط، أو أن وضع "اليوم فقط" لم يكن صارماً جداً لهذا البحث.');
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
