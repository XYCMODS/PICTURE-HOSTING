# Pic Hosting (God UI) — ABHISHEK X MODS

Advanced image hosting project (Express + Sharp) with a polished frontend. Ready for GitHub → Render deployment.

## Features
- POST `/api/upload` (multipart form field `image`)
- GET `/api/list` (returns latest images)
- DELETE `/api/delete/:file?key=ADMIN_KEY` (optional)
- Local storage (uploads/) or S3 (STORAGE=s3)
- Thumbnails generated via Sharp
- Rate limiting, helmet, CORS
- Frontend: drag&drop upload, gallery, lightbox, copy URL

## Quick start (local)
```bash
git clone <repo>
cd pic-hosting-god
npm install
# Optional: set env vars in .env
# Example .env:
# STORAGE=local
# MAX_FILE_SIZE_BYTES=5242880
# RATE_LIMIT_MAX=30
# ADMIN_KEY=your_admin_key
node server.js
# open http://localhost:3000
