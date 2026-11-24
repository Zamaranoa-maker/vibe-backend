@echo off
echo ============================================
echo   VIBE - رفع الكود على GitHub
echo ============================================
echo.
echo لازم تكون عملت repo جديد على GitHub باسم: vibe-backend
echo ونسخ الرابط اللي يظهرلك (https://github.com/USERNAME/vibe-backend.git)
echo.
set /p REPO="الصق الرابط هنا: "
echo.
echo جاري الإضافة...
git remote remove origin 2>nul
git remote add origin %REPO%
git add -A
git commit -m "VIBE Control Center - live dashboard" 2>nul
git push -u origin main
echo.
echo ✅ تم الرفع! روح Render واعمل Web Service من الـ repo.
pause
