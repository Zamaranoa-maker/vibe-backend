# VIBE Backend 🔒

سيرفر التطبيق (Node خالص بدون مكتبات خارجية).

## التشغيل
```
cd vibe-backend
node server.js
```
- API: http://localhost:3000/api/health
- لوحة التحكم: http://localhost:3000/admin

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
