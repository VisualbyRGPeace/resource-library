# Resource Library

Website thư viện tài nguyên thiết kế: bạn kéo-thả file vào trang **/admin**, file tự lưu vào Cloudflare R2, và tự xuất hiện trên trang public để mọi người xem trước và tải xuống. Không cần sửa code, sửa JSON hay deploy lại khi thêm file.

```
Trình duyệt ──► Cloudflare Worker (API + phục vụ giao diện) ──► R2 (file)  +  D1 (metadata)
```

## Điểm khác so với bản yêu cầu ban đầu (và lý do)

| Yêu cầu | Thực tế trong dự án | Lý do |
|---|---|---|
| Frontend trên Cloudflare Pages, API trên Workers | **Một Worker duy nhất** phục vụ cả giao diện (Workers Static Assets) lẫn API | Cloudflare hiện hướng dẫn dùng Workers + Static Assets cho site mới. Chung một origin nên không cần CORS, ít thứ phải cấu hình, 1 lệnh deploy. |
| Signed/presigned upload | **Multipart upload qua R2 binding của Worker**, mỗi part 10 MB | Không cần tạo R2 access key cho việc upload, không cần cấu hình CORS bucket. File 2 GB = ~200 part, có tiến trình, thử lại từng part. Giới hạn hiện tại: 5 GB/file (chỉnh `MAX_FILE_SIZE` trong `src/util.js`). |
| Download trực tiếp từ R2 | **Có** nếu bạn bật bước tuỳ chọn (presigned URL, link hết hạn sau 1 giờ). Nếu chưa bật, Worker **stream** file từ R2 (không buffer, hỗ trợ Range) | Mặc định chạy được ngay; bật tuỳ chọn khi muốn file lớn đi thẳng từ R2. |
| Thumbnail | Tạo **ngay trên trình duyệt của admin** (WebP, cạnh dài 640 px) | Không cần dịch vụ xử lý ảnh ở server, miễn phí. Gallery chỉ tải thumbnail. |

## Cấu trúc thư mục

```
public/            Giao diện (HTML/CSS/JS thuần, không cần build)
  index.html         Trang public
  admin/index.html   Trang admin (/admin)
  assets/            style.css, app.js (public), admin.js, common.js
src/               Worker: index.js (API), auth.js, util.js
schema.sql         Cấu trúc database D1
wrangler.jsonc     Cấu hình Cloudflare (binding R2, D1, assets)
scripts/hash-password.mjs   Tạo mật khẩu băm cho admin
.env.example       Mẫu biến môi trường (KHÔNG chứa bí mật thật)
```

## Cài đặt từng bước

Cần: [Node.js 20+](https://nodejs.org) và một tài khoản Cloudflare.

### Bước 1 — Tạo tài khoản Cloudflare và cài dự án
1. Đăng ký tại https://dash.cloudflare.com/sign-up (miễn phí). R2 yêu cầu bật thanh toán (thêm thẻ) dù có free tier — xem trang Pricing của R2 để biết hạn mức hiện tại.
2. Trong thư mục dự án:
```bash
npm install
npx wrangler login
```

### Bước 2 — Tạo R2 bucket
```bash
npx wrangler r2 bucket create resource-library-files
```
Nếu bạn đặt tên khác, sửa `bucket_name` và `R2_BUCKET_NAME` trong `wrangler.jsonc`.

### Bước 3 — Tạo database D1
```bash
npx wrangler d1 create resource-library-db
```
Lệnh in ra `database_id`. Mở `wrangler.jsonc`, thay `PASTE_YOUR_D1_DATABASE_ID_HERE` bằng giá trị đó. Sau đó tạo bảng:
```bash
npm run db:init
```

### Bước 4 — Deploy Worker (đồng thời deploy giao diện — Bước 6)
```bash
npm run deploy
```
Cuối lệnh sẽ in địa chỉ dạng `https://resource-library.<tên-bạn>.workers.dev`. Giao diện public (`/`) và admin (`/admin`) nằm chung trong lần deploy này nên **không có bước deploy frontend riêng**.

### Bước 5 — Đặt bí mật (secrets)
Tạo mật khẩu admin (nhập 2 lần, không hiện khi gõ, tối thiểu 10 ký tự):
```bash
npm run hash-password
```
Lệnh in ra `ADMIN_PASSWORD_HASH=...` và `SESSION_SECRET=...`. Đặt 3 secret (mỗi lệnh sẽ hỏi giá trị, dán vào rồi Enter):
```bash
npx wrangler secret put ADMIN_EMAIL           # email đăng nhập của bạn
npx wrangler secret put ADMIN_PASSWORD_HASH   # dán chuỗi pbkdf2:100000:...
npx wrangler secret put SESSION_SECRET        # dán chuỗi ngẫu nhiên đã in
```

### Bước 6 — Frontend
Đã xong ở Bước 4.

### Bước 7 — Tài khoản admin
Chính là email + mật khẩu ở Bước 5. Chỉ có một tài khoản, không có đăng ký. Muốn đổi mật khẩu: chạy lại `npm run hash-password` rồi `wrangler secret put ADMIN_PASSWORD_HASH`.

### Bước 8 — Đăng nhập
Mở `https://<địa-chỉ-worker>/admin` (hoặc `/admin/login`), đăng nhập.

### Bước 9 — Upload file
Kéo nhiều file vào khung "Drop files here" → bấm **Upload N files**. Mỗi file có thanh tiến trình riêng. Tên resource tự lấy từ tên file ("summer-poster-final.png" → "Summer Poster Final"); kích thước, loại file, số đo ảnh và thumbnail tự động. Có thể chọn sẵn "Category for this batch" cho cả lô. Sửa tên, mô tả, tags, đổi thumbnail sau bằng **Edit** (với PSD/AI/ZIP, dùng Edit → Change để gắn ảnh preview).

### Bước 10 — Kiểm tra trang public
Mở `https://<địa-chỉ-worker>/` — resource vừa upload đã hiện, bấm ảnh để xem trước, bấm **Download** để tải.

## Tuỳ chọn A — Tải file lớn thẳng từ R2

Mặc định Worker stream file từ R2 (vẫn nhanh và không giới hạn dung lượng). Nếu muốn trình duyệt tải thẳng từ R2:
1. Cloudflare Dashboard → R2 → *Manage R2 API Tokens* → tạo token **Object Read only**, giới hạn đúng bucket `resource-library-files`. Ghi lại Access Key ID và Secret.
2. Trong `wrangler.jsonc`, điền `R2_ACCOUNT_ID` (Account ID hiển thị ở trang R2).
3. Đặt secret rồi deploy lại:
```bash
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npm run deploy
```
Token chỉ có quyền đọc nên nếu lộ cũng không ai ghi/xoá được file. Upload và xoá luôn đi qua Worker đã xác thực.

## Chạy thử trên máy

```bash
cp .env.example .dev.vars        # Windows: copy .env.example .dev.vars
# điền ADMIN_EMAIL, ADMIN_PASSWORD_HASH, SESSION_SECRET vào .dev.vars
npm run db:init:local
npm run dev                      # mở http://localhost:8787
```
Chạy local dùng R2/D1 giả lập cục bộ, không đụng dữ liệu thật.

## Đưa lên GitHub và tự deploy

```bash
git init && git add . && git commit -m "Resource Library"
```
Đẩy lên GitHub. Trong Cloudflare Dashboard → *Workers & Pages* → *Create* → *Import a repository* (Workers Builds), chọn repo; lệnh deploy là `npx wrangler deploy`. Secrets vẫn đặt trong Dashboard (Settings → Variables and Secrets) hoặc bằng `wrangler secret put`. `.gitignore` đã loại `.dev.vars`/`.env`, nên bí mật không bị commit. **Push code chỉ cần khi sửa code; thêm resource thì không cần.**

Nên gắn **tên miền riêng** (Worker → Settings → Domains & Routes): thumbnail và file tĩnh sẽ được cache ở edge (Cache API không hoạt động trên `*.workers.dev`).

## API

| Phương thức | Đường dẫn | Quyền |
|---|---|---|
| GET | `/api/resources?q=&category=&sort=&page=&limit=` | public |
| GET | `/api/resources/:id` · `/thumb` · `/preview` · `/download` · `/file` | public |
| GET | `/api/categories` · `/api/config` | public |
| POST | `/api/auth/login` · `/api/auth/logout` · GET `/api/auth/me` | — |
| POST | `/api/admin/uploads/init` → PUT `/part` → POST `/complete` (hoặc `/abort`) | admin |
| PUT | `/api/admin/resources/:id` (sửa) · `/:id/thumbnail` | admin |
| DELETE | `/api/admin/resources/:id` · POST `/api/admin/resources/bulk-delete` | admin |

`sort` nhận: `newest` (mặc định), `oldest`, `name_asc`, `name_desc`, `size_desc`, `size_asc`.

## Bảo mật

- Không có secret nào trong frontend hoặc repo. R2/D1 truy cập qua binding của Worker.
- Mật khẩu lưu dạng băm PBKDF2-SHA256 (100.000 vòng — mức tối đa Cloudflare Workers cho phép). Phiên là cookie `HttpOnly`, `SameSite=Strict`, `Secure` (trên HTTPS), ký HMAC, hết hạn sau 7 ngày.
- Đăng nhập sai quá 5 lần/15 phút từ một IP sẽ bị khoá tạm.
- Mọi request ghi dữ liệu phải có header `X-Requested-With` và `Origin` cùng site (chống CSRF).
- API public không bao giờ trả `file_key`/đường dẫn R2. Chặn upload file thực thi (`.exe`, `.msi`, `.bat`, … — danh sách trong `src/util.js`).
- SVG được xem trước dưới dạng `<img>` kèm CSP `sandbox`, nên script trong SVG không chạy. File tải về luôn là `attachment` + `nosniff`.
- `public/_headers` thiết lập CSP nghiêm ngặt cho các trang.
- Tải file là công khai theo thiết kế (ai có link đều tải được). Đừng upload thứ không muốn công khai.

## Giới hạn cần biết

- Mỗi part đi qua Worker (10 MB/request), nằm dưới giới hạn body 100 MB của gói Free. Không đổi `PART_SIZE` lên quá ~90 MB.
- Upload dở (đóng tab giữa chừng) để lại phần multipart chưa hoàn tất trong R2; R2 tự dọn các upload dở theo chính sách mặc định, và nút ✕ trong hàng đợi sẽ huỷ ngay.
- Tìm kiếm dùng `LIKE` trên D1, đủ nhanh cho hàng nghìn resource. Danh sách phân trang 48 mục/lần ("Load more").
- Ảnh không giải mã được trong trình duyệt (TIFF, HEIC…) sẽ dùng placeholder cho đến khi bạn gắn thumbnail bằng Edit.

## Xử lý sự cố

| Triệu chứng | Cách xử lý |
|---|---|
| Đăng nhập báo "Server is not configured" | Chưa đặt đủ 3 secret ở Bước 5. |
| `wrangler deploy` báo lỗi D1 / database_id | Chưa thay `PASTE_YOUR_D1_DATABASE_ID_HERE` (Bước 3). |
| Báo lỗi bảng không tồn tại | Chạy `npm run db:init` (production) hoặc `npm run db:init:local` (local). |
| Một file upload lỗi | Bấm **Retry** cạnh file đó hoặc **Retry failed**; các part đã lên được giữ lại, không phải upload lại từ đầu. |
| "Download unavailable." | File không còn trong R2 hoặc R2 không phản hồi; thử lại sau, kiểm tra Dashboard → R2. |
