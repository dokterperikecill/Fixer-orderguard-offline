# D'Fixer OrderGuard

PWA offline-first untuk impor paket, manifest, pemindaian, rekonsiliasi, sesi serah-terima, insiden, dan audit lokal.

## Menjalankan lokal

```sh
npm install
python3 -m http.server 4173 --bind 0.0.0.0
```

Buka `http://localhost:4173/`. Kunjungan pertama harus online agar service worker dapat menyimpan shell aplikasi dan paket XLSX/Supabase. Setelah ter-cache, data bisnis tetap dapat dicatat pada perangkat tanpa internet.

## Build APK Android

Build APK memakai Capacitor dan workflow GitHub Actions `.github/workflows/android-apk.yml`.

- Push ke `main`, pull request, atau jalankan workflow secara manual untuk membuat APK debug.
- Unduh APK dari bagian **Actions → Build Android APK → Artifacts**.
- Buat dan push tag versi, misalnya `v1.0.0`, untuk menerbitkan APK ke GitHub Release.
- Build lokal: `npm ci` lalu `npm run build:android`. APK berada di `android/app/build/outputs/apk/debug/app-debug.apk`.

APK debug ditandatangani dengan debug key dan ditujukan untuk instalasi/pengujian langsung, bukan publikasi Google Play. Publikasi Play Store memerlukan konfigurasi signing release yang aman melalui GitHub Secrets.

## Mengaktifkan akun dan sinkronisasi

1. Buat proyek Supabase dan aktifkan Auth email/password.
2. Jalankan seluruh `supabase-schema.sql` di SQL Editor proyek. Script membuat organizations, membership, RLS, RPC sinkronisasi, bucket bukti privat, dan kebijakan akses bucket.
3. Deploy static app bersama aset `node_modules/@e965/xlsx/dist/xlsx.full.min.js` dan `node_modules/@supabase/supabase-js/dist/umd/supabase.js`. Jangan menaruh `service_role` key di browser.
4. Buka Pengaturan, masukkan project URL serta publishable/anon key, lalu simpan. Login, buat organisasi atau pilih membership yang sudah ada, kemudian gunakan tombol sinkronisasi.
5. Untuk organisasi yang dibuat lewat aplikasi, user pertama menjadi `owner`. Penambahan user dan perubahan role dilakukan oleh administrator proyek melalui prosedur server tepercaya; jangan memberi hak tulis membership ke anon key.

Setiap perubahan bisnis ditulis ke IndexedDB dan outbox dalam transaksi lokal yang sama. Ketika online dan login, perubahan dikirim per batch, server memeriksa membership/role dan versi record, kemudian data tenant yang belum memiliki perubahan lokal ditarik ke perangkat. Konflik ditampilkan untuk pilihan eksplisit, bukan ditimpa otomatis.

## Catatan keamanan dan operasional

- Data yang belum sinkron hanya ada di browser/perangkat tersebut. Backup JSON tetap perlu dijadwalkan sampai pemulihan cloud dan perangkat diuji.
- Saat offline, perubahan belum mendapat persetujuan server. Pemeriksaan role server akan berlaku setelah sinkronisasi; perangkat yang dipakai bersama perlu akses fisik yang dibatasi.
- Audit lokal append-only melalui aplikasi, lalu disimpan server dengan actor dan waktu penerimaan. Pemilik browser tetap dapat mengubah data lokal lewat developer tools.
- Foto bukti dikompresi dan disimpan lokal sampai berhasil diunggah ke bucket privat. Foto cloud menggunakan signed URL singkat saat dilihat.
- Scan kamera memerlukan HTTPS/localhost dan browser yang mendukung `BarcodeDetector`; scanner USB/Bluetooth yang mengirim input keyboard dan input manual tetap tersedia sebagai fallback.
- `sync_records` adalah payload JSON berversi untuk fondasi sinkronisasi. Sebelum produksi, lakukan review keamanan SQL di proyek target, tambah logging/monitoring, tetapkan backup-retention, dan uji pemulihan serta aturan retensi foto.
- Satu baris impor mewakili satu paket. Untuk XLSX, sheet pertama digunakan.

## Pengujian

```sh
npm test
npm audit
```

Tes mencakup transaksi outbox IndexedDB, isolasi tenant lokal, RLS, batas role, audit append-only, bukti penerimaan paket, serta deteksi konflik versi pada skema PostgreSQL embedded.