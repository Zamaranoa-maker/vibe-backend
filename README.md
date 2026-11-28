# VIBE Backend 🔒

سيرفر التطبيق (Node خالص بدون مكتبات خارجية).

## التشغيل
```
cd vibe-backend
node server.js
```
- API: http://localhost:3000/api/health
- لوحة التحكم: http://localhost:3000/admin

## الاختبارات ( فصل الإنتاج عن الاختبار )
الاختبارات **ما بتشتغلش على قاعدة الإنتاج أبداً**. لازم تحط في `.env`:
```
DATABASE_URL=<قاعدة الإنتاج>
TEST_DATABASE_URL=<قاعدة اختبار منفصلة — مشروع Supabase تاني>
```
بعدين:
```
npm test
```
`run-tests.js` بيعمل الآتي قبل أي اختبار:
- يرفض التشغيل لو `TEST_DATABASE_URL` ناقص، أو مساوي لـ `DATABASE_URL`، أو نفسه **host**، أو نفسه **Supabase project ref** (`postgres.<ref>` أو `db.<ref>.supabase.co`) — حتى لو الباسورد أو الـ host مختلف. كمان بيرفض لو أي ref مش قابل للاستخراج.
- يطبّق الـ migrations على قاعدة الاختبار فقط.
- يقلّب سيرفر اختبار على `TEST_PORT` (افتراضي 3100) بـ `DATABASE_URL=TEST_DATABASE_URL`.
- بيشغّل كل ملفات `test-*.js`، وبعدين ينظّف قاعدة الاختبار (`cleanup-test-db.js`).

مفيش اختبار يقدر ينشئ أدمن في أي قاعدة غير قاعدة الاختبار، و`make-owner.js` محلي فقط بـ `ALLOW_LOCAL_ADMIN=1`.

## الصحة والإحصائيات
- `GET /api/health` بيرجع `{"ok":true}` بس — مفيش أي عدّادات أو بيانات داخلية.
- الإحصائيات كلها خلف `GET /api/admin/stats` (لأدمن بس).

## الأمان المطبّق
- ✅ Rate limiting (150 طلب/دقيقة لكل IP)
- ✅ CORS مقيّد (localhost + file فقط — يمنع المواقع الخبيثة)
- ✅ هيدرات حماية (nosniff, DENY frame, XSS, referrer, permissions)
- ✅ تحقق من نوع الفيديو برمجياً (ftyp/webm magic bytes)
- ✅ تنظيف النصوص من XSS (esc)
- ✅ مصادقة بالـ token لكل مستخدم
- ✅ منع تكرار المكافآت (cooldown + حد يومي 2 ج.م)
- ✅ تخزين ذري للبيانات (tmp + rename)

## Api endpoints
| Endpoint | الوظيفة |
|---|---|
| POST /api/auth | تسجيل/دخول بالجهاز |
| GET /api/me | الملف + المحفظة |
| POST /api/videos | رفع فيديو (base64) |
| GET /api/videos | عرض الفيديوهات |
| GET /api/video/:id | تشغيل الفيديو |
| POST /api/videos/:id/view | تسجيل مشاهدة + مكافأة |
| POST /api/videos/:id/like | إعجاب + مكافأة |
| POST /api/wallet/claim | مكافأة يومية |
| GET /api/admin/stats | إحصائيات + ربح/مصروف |

## ملاحظة مهمة
الأرباح **محاكاة محلية**. عشان فلوس حقيقية لازم تربط AdMob + بوابة دفع + سيرفر استضافة (مش localhost).
