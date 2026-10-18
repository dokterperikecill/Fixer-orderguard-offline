# PRD — D'Fixer OrderGuard Manifest

**Nama produk:** D'Fixer OrderGuard Manifest  
**Versi dokumen:** 1.0  
**Status:** Draft siap untuk estimasi dan implementasi  
**Bahasa:** Indonesia  
**Model produk:** SaaS multi-tenant  
**Platform:** Web responsif untuk admin + PWA/antarmuka scanner untuk HP Android  
**Fokus:** Import Excel/CSV, pencocokan manifest, rekonsiliasi jumlah paket, dan bukti serah terima kurir.

---

## 1. Ringkasan Eksekutif

D'Fixer OrderGuard Manifest adalah aplikasi untuk membantu banyak online shop mencocokkan daftar paket yang direncanakan dengan paket yang benar-benar dipindai dan diserahkan kepada kurir. Data masuk melalui file Excel/CSV; integrasi marketplace bukan persyaratan MVP.

Produk ini berfokus pada kontrol serah terima dan bukti transaksi. Produk tidak bertanggung jawab memverifikasi isi fisik paket atau status pengiriman eksternal kecuali fitur tersebut ditambahkan di masa depan.

### 1.1 Masalah
- Jumlah paket yang disiapkan berbeda dari manifest.
- Paket yang seharusnya diserahkan tidak ikut terbawa.
- Paket di luar manifest ikut dipindai.
- Resi terduplikasi atau kosong.
- Catatan gudang dan kurir tidak cocok.
- Bukti penerimaan tidak lengkap.
- Sulit menelusuri paket yang diterima sebagian atau diserahkan pada beberapa tahap.

### 1.2 Solusi
Alur utama:

**Import Excel/CSV → Pratinjau dan validasi → Buat manifest → Pindai paket → Rekonsiliasi → Konfirmasi serah terima → Laporan dan penanganan selisih.**

### 1.3 Prinsip
1. Manifest adalah daftar rencana, bukan bukti bahwa paket sudah diterima.
2. Bukti penerimaan berasal dari catatan paket aktual dan konfirmasi pihak yang berwenang.
3. Paket di luar manifest tidak otomatis dianggap sah.
4. Serah terima sebagian harus didukung.
5. Riwayat serah terima yang telah dikonfirmasi tidak boleh ditimpa.
6. Data tenant terisolasi.
7. Semua pengecualian dan koreksi harus memiliki alasan serta audit trail.
8. CSV/XLSX menjadi sumber data MVP; API eksternal adalah pengembangan opsional.

---

## 2. Tujuan dan Indikator Keberhasilan

### 2.1 Tujuan
- Mencocokkan jumlah paket rencana dan paket aktual.
- Mendeteksi paket yang belum dipindai, di luar manifest, atau terduplikasi.
- Mencatat paket yang benar-benar diterima kurir.
- Menyediakan bukti serah terima yang dapat ditelusuri.
- Mengelola serah terima sebagian dan selisih.
- Memberi laporan per toko, manifest, kurir, petugas, dan periode.
- Menyediakan fondasi SaaS untuk banyak online shop.

### 2.2 KPI pilot
Target awal untuk pengujian:
- 100% paket yang tercatat diserahkan memiliki catatan serah terima.
- 100% manifest yang ditutup memiliki hasil rekonsiliasi.
- Semua nomor resi duplikat dalam cakupan validasi dapat ditandai.
- Semua paket di luar manifest dapat diidentifikasi.
- Seluruh koreksi transaksi penting tercatat di audit log.
- Tidak ditemukan akses lintas tenant yang tidak sah.
- Selisih paket dapat dilacak ke nomor resi dan sesi serah terima terkait.

---

## 3. Pengguna dan Hak Akses

| Peran | Hak akses utama |
|---|---|
| Platform Super Admin | Mengelola konfigurasi platform; akses tenant dibatasi, diaudit, dan hanya jika diperlukan. |
| Organization Owner | Mengelola organisasi, toko, anggota, pengaturan, dan laporan. |
| Store Admin | Mengimpor data, memperbaiki baris gagal, membuat manifest, dan melihat laporan toko. |
| Handover Staff | Membuka manifest, memindai paket, dan menyiapkan rekonsiliasi. |
| Supervisor | Meninjau selisih, menyetujui pengecualian, dan mengelola koreksi sesuai kebijakan. |
| Courier/Receiver | Melihat manifest yang ditugaskan dan mengonfirmasi paket yang benar-benar diterima. |
| Read-only Auditor | Melihat laporan/audit log yang diizinkan tanpa mengubah data. |

Semua otorisasi wajib diperiksa di server/database. Pembatasan UI saja tidak cukup.

---

## 4. Ruang Lingkup

### 4.1 MVP
- Autentikasi.
- Organisasi multi-tenant.
- Pengelolaan toko.
- Manajemen pengguna dan role.
- Impor CSV/XLSX.
- Pemetaan kolom dan pratinjau.
- Validasi data dan laporan baris gagal.
- Deteksi resi duplikat.
- Pembuatan manifest.
- Pemindaian barcode/QR melalui kamera atau scanner kompatibel.
- Pencocokan hasil pemindaian dengan manifest.
- Deteksi paket belum dipindai.
- Deteksi paket di luar manifest.
- Deteksi pemindaian duplikat.
- Rekonsiliasi jumlah.
- Serah terima sebagian.
- Konfirmasi penerimaan kurir.
- Bukti foto jika diwajibkan.
- Penanganan insiden/selisih.
- Dashboard, filter, dan ekspor CSV.
- Audit log.
- Backup dan prosedur pemulihan.

### 4.2 Di luar MVP
- Integrasi langsung marketplace.
- Integrasi API ekspedisi dan pelacakan status.
- Verifikasi isi paket melalui SKU.
- Proses picking/packing lengkap.
- OCR/AI wajib.
- Aplikasi Android native.
- Integrasi timbangan/printer otomatis.
- Billing SaaS otomatis.
- Notifikasi multi-kanal lanjutan.

---

## 5. Format Impor dan Validasi

### 5.1 Kolom standar
| Kolom | Wajib | Keterangan |
|---|---|---|
| Nomor pesanan | Ya | ID pesanan dari sumber |
| Nomor resi | Ya | ID pengiriman untuk dipindai |
| Toko | Wajib jika file berisi beberapa toko | Identitas toko pemilik paket |
| Kurir/ekspedisi | Ya | Pihak/layanan yang akan menerima paket |
| Tanggal rencana serah terima | Disarankan | Jadwal operasional |
| Jumlah paket | Ya | Umumnya satu baris mewakili satu paket; aturan harus dikonfirmasi saat pemetaan |
| Catatan | Tidak | Informasi tambahan nonkritis |

Sistem harus memungkinkan admin memetakan nama kolom yang berbeda ke skema standar. Data pelanggan yang tidak dibutuhkan tidak perlu diimpor.

### 5.2 Pratinjau impor
Sebelum menyimpan, pengguna melihat:
- Jumlah baris total.
- Baris valid.
- Baris ditolak.
- Nomor resi kosong.
- Duplikasi di file.
- Duplikasi terhadap data yang sudah ada.
- Toko/kurir yang tidak dikenal.
- Kolom yang belum dipetakan.

Pengguna harus mengonfirmasi hasil pemetaan. Sistem tidak boleh diam-diam menghapus atau menggabungkan baris.

### 5.3 Aturan validasi
- Nomor pesanan dan nomor resi wajib tersedia sesuai konfigurasi.
- Nomor resi harus unik pada cakupan yang ditentukan, setidaknya dalam manifest aktif.
- Resi duplikat ditandai untuk peninjauan; jangan otomatis membuang baris.
- Setiap baris memiliki hasil validasi.
- Impor ulang yang sama tidak boleh membuat entri ganda.
- Baris gagal dapat diunduh atau diperbaiki lalu diimpor ulang.
- Data mentah impor dapat disimpan secara terbatas untuk audit sesuai kebijakan retensi.

---

## 6. Alur Operasional

### 6.1 Import
Admin mengunggah CSV/XLSX, memetakan kolom, melihat pratinjau, dan menjalankan validasi. Hanya baris yang lolos aturan yang dapat dipakai untuk membuat manifest. Baris gagal tetap terlihat dalam laporan impor.

### 6.2 Pembuatan manifest
Manifest dikelompokkan menurut toko atau kelompok toko yang diizinkan, ekspedisi/kurir, lokasi, dan tanggal/jadwal.
Informasi manifest:
- ID manifest unik.
- Organisasi dan cakupan toko.
- Kurir/ekspedisi.
- Lokasi.
- Waktu dibuat.
- Pembuat.
- Daftar paket.
- Jumlah yang diharapkan.
- Status.

Manifest dapat berada pada status draft sebelum dibuka untuk pemindaian. Paket yang sudah berada dalam manifest aktif lain tidak boleh ditambahkan tanpa prosedur pemindahan yang tercatat.

### 6.3 Pemindaian paket
Petugas membuka manifest dan memindai barcode/QR atau memasukkan nomor resi secara manual jika diizinkan.

Hasil pemindaian:
- `MATCH`: paket ada dalam manifest dan belum dipindai.
- `DUPLICATE_SCAN`: paket sudah dipindai pada sesi/manifest yang sama.
- `NOT_IN_MANIFEST`: paket tidak tercantum dalam manifest.
- `ALREADY_HANDED_OVER`: paket telah dicatat diterima pada serah terima sebelumnya.
- `INVALID_PACKAGE`: kode tidak dikenal atau tidak valid.
- `CANCELLED`: paket dibatalkan dan tidak boleh diserahkan dalam alur normal.

Paket `NOT_IN_MANIFEST` tidak boleh otomatis menambah jumlah yang sah. Supervisor harus menyelesaikan masalah melalui proses terkontrol.

### 6.4 Rekonsiliasi
Sistem membandingkan:
- Jumlah paket yang diharapkan.
- Paket unik yang berhasil dipindai.
- Paket yang belum dipindai.
- Paket di luar manifest.
- Pemindaian duplikat.
- Paket yang sebelumnya telah diserahkan.

Contoh:
| Kategori | Jumlah |
|---|---:|
| Direncanakan | 200 |
| Dipindai unik | 196 |
| Belum dipindai | 4 |
| Di luar manifest | 2 |
| Pemindaian duplikat | 1 |

Kategori di atas tidak boleh dijumlahkan begitu saja sebagai paket unik karena duplikasi dan paket di luar manifest bukan paket rencana yang sah. Dashboard harus menjelaskan perbedaan kategori.

### 6.5 Serah terima sebagian
Sistem harus mendukung beberapa sesi serah terima untuk satu manifest jika paket diambil bertahap.
Setiap sesi memiliki:
- ID sesi.
- Manifest.
- Daftar paket aktual.
- Petugas penyerah.
- Penerima/kurir.
- Waktu.
- Bukti.
- Hasil konfirmasi.
- Catatan selisih.

Catatan sesi sebelumnya tidak boleh ditimpa oleh sesi berikutnya. Manifest hanya dapat ditutup setelah kebijakan rekonsiliasi terpenuhi atau pengecualian disetujui dan dicatat.

### 6.6 Konfirmasi penerimaan
Konfirmasi menyimpan daftar paket yang benar-benar diterima, bukan hanya angka total yang diketik.
Bukti dapat meliputi:
- Identitas petugas gudang.
- Identitas penerima/kurir.
- Waktu konfirmasi.
- ID manifest dan sesi.
- Daftar nomor resi.
- Jumlah paket aktual.
- Foto dan/atau tanda tangan digital jika diwajibkan.
- Catatan paket ditolak atau tidak ikut diambil.

Jika kurir menolak sebagian paket, paket tersebut tidak boleh diberi status `HANDED_OVER`.

### 6.7 Penanganan insiden
Kategori:
- Paket kurang.
- Paket berlebih.
- Resi duplikat.
- Paket di luar manifest.
- Paket ditolak kurir.
- Kesalahan impor.
- Paket telah diserahkan sebelumnya.
- Kesalahan pemindaian.
- Masalah lain.

Setiap insiden menyimpan kategori, deskripsi, paket/manifest terkait, pelapor, waktu, bukti, penanggung jawab, status, dan tindakan perbaikan.

---

## 7. Status

### 7.1 Status manifest
- `DRAFT`
- `READY`
- `OPEN`
- `HANDOVER_IN_PROGRESS`
- `RECONCILIATION_REQUIRED`
- `PARTIALLY_HANDED_OVER`
- `READY_FOR_CONFIRMATION`
- `CONFIRMED`
- `CLOSED`
- `CANCELLED`

### 7.2 Status paket dalam manifest
- `EXPECTED`
- `SCANNED`
- `EXCEPTION`
- `HANDED_OVER`
- `REJECTED`
- `CANCELLED`

Status harus dikendalikan backend dan perubahan harus mematuhi aturan transisi. Status pada level manifest tidak boleh menggantikan catatan per paket dan per sesi.

---

## 8. Kebutuhan Fungsional

| ID | Kebutuhan | Prioritas | Kriteria penerimaan ringkas |
|---|---|---|---|
| FR-001 | Organisasi dan toko | Must | Data terisolasi per organisasi dan cakupan toko. |
| FR-002 | Role dan otorisasi | Must | Server menolak tindakan tanpa izin. |
| FR-003 | Impor CSV/XLSX | Must | Ada pemetaan kolom, pratinjau, validasi, dan laporan baris gagal. |
| FR-004 | Deteksi duplikasi | Must | Duplikasi file/database ditandai tanpa penghapusan diam-diam. |
| FR-005 | Pembuatan manifest | Must | ID unik dan daftar paket yang dapat ditelusuri. |
| FR-006 | Pemindaian paket | Must | Sistem membedakan match, duplikat, di luar manifest, dan sudah diserahkan. |
| FR-007 | Rekonsiliasi | Must | Jumlah dihitung dari paket unik dan catatan transaksi. |
| FR-008 | Serah terima sebagian | Must | Setiap sesi menyimpan paket aktual dan bukti sendiri. |
| FR-009 | Konfirmasi kurir | Must | Identitas, waktu, daftar paket, dan hasil tersimpan. |
| FR-010 | Insiden | Must | Selisih dapat ditugaskan, ditindaklanjuti, dan ditutup dengan audit. |
| FR-011 | Dashboard/laporan | Must | Data dapat difilter per tanggal, toko, kurir, manifest, status, dan petugas. |
| FR-012 | Ekspor CSV | Must | Ekspor mematuhi hak akses dan meminimalkan data pelanggan. |
| FR-013 | Audit log | Must | Perubahan penting memiliki aktor, waktu, tindakan, dan objek. |
| FR-014 | Bukti foto | Should | Akses terbatas dan file terkait ke manifest/sesi. |
| FR-015 | AI pemetaan impor | Could | Saran pemetaan wajib dikonfirmasi sebelum impor. |
| FR-016 | Deteksi anomali AI | Could | Temuan AI berupa indikasi, bukan bukti kesalahan individu. |
| FR-017 | Integrasi ekspedisi | Could | Hanya jika API/sumber resmi tersedia dan diizinkan. |

---

## 9. Dashboard dan Laporan

### Dashboard
- Paket yang direncanakan.
- Paket unik yang dipindai.
- Paket belum dipindai.
- Paket di luar manifest.
- Pemindaian duplikat.
- Manifest terbuka.
- Manifest dengan selisih.
- Paket diterima sebagian.
- Insiden yang belum selesai.

### Filter laporan
- Tanggal/periode.
- Organisasi dan toko.
- Kurir/ekspedisi.
- Manifest.
- Status.
- Petugas penyerah.
- Penerima/kurir.

### Laporan
- Hasil impor dan baris gagal.
- Rekonsiliasi per manifest.
- Daftar paket yang belum diserahkan.
- Paket di luar manifest.
- Serah terima per sesi.
- Selisih dan insiden.
- Riwayat audit.

---

## 10. AI Assistant (Opsional)

AI tidak diperlukan agar MVP berfungsi. Fitur dapat ditambahkan setelah alur inti stabil.

### 10.1 Bantuan pemetaan kolom
AI menyarankan pemetaan nama kolom seperti `Tracking Number` ke `Nomor Resi`. Pengguna wajib meninjau dan menyetujui saran sebelum impor.

### 10.2 Deteksi anomali
AI dapat menandai manifest yang sering mengalami selisih, kenaikan pemindaian duplikat, atau pola operasional tidak biasa. Temuan harus dijelaskan sebagai indikasi untuk ditinjau, bukan kesimpulan tentang kesalahan atau kecurangan.

### 10.3 Ringkasan laporan
AI menyusun ringkasan dari angka yang sudah dihitung database. Angka operasional tidak boleh berasal dari perkiraan model.

### Batasan
- AI tidak boleh mengonfirmasi paket diterima.
- AI tidak boleh mengubah bukti atau audit log.
- AI tidak boleh mengakses data lintas tenant.
- Pengiriman data ke penyedia AI harus mengikuti kebijakan privasi dan konfigurasi yang disetujui.
- Semua saran AI dapat ditinjau dan diabaikan oleh pengguna berwenang.

---

## 11. Model Data Konseptual

Entitas minimum:
- `organizations`
- `organization_members`
- `stores`
- `couriers` atau `shipping_providers`
- `import_jobs`
- `import_rows` atau tabel hasil validasi impor
- `manifests`
- `manifest_parcels`
- `handover_sessions`
- `handover_items`
- `incidents`
- `incident_evidence`
- `attachments`
- `audit_logs`

Gunakan ID internal unik. Nomor resi tidak boleh menjadi primary key global karena aturan keunikan dapat berbeda menurut penyedia dan periode. Setiap entitas bisnis harus terhubung ke tenant secara aman. Terapkan foreign key, unique constraint, indeks, dan transaksi untuk mencegah duplikasi serta kondisi balapan saat dua petugas memindai paket yang sama.

---

## 12. Persyaratan Nonfungsional

### Keamanan dan privasi
- Isolasi tenant di server/database.
- Jika memakai Supabase, RLS harus aktif dan diuji untuk semua tabel yang diakses client.
- Kredensial dan secret tidak boleh berada di frontend.
- Bukti foto disimpan di storage privat dengan kontrol akses.
- Data pelanggan yang tidak diperlukan tidak diimpor atau ditampilkan.
- Audit log tidak dapat diubah pengguna biasa.
- Validasi input dan pengelolaan sesi harus aman.

### Integritas transaksi
- Pemindaian paket dan konfirmasi memakai transaksi atau constraint yang aman terhadap permintaan bersamaan.
- Impor harus idempoten.
- Serah terima yang dikonfirmasi tidak boleh ditimpa.
- Koreksi dibuat sebagai catatan tambahan dengan alasan dan aktor.
- Jumlah pada dashboard dihitung dari data transaksi, bukan disimpan sebagai angka bebas yang dapat berbeda dari daftar paket.

### Kinerja dan keandalan
- Respons pemindaian jelas dan cepat pada perangkat yang didukung.
- Daftar besar mendukung pagination dan filter.
- Kegagalan impor memiliki pesan yang dapat ditindaklanjuti.
- Backup terjadwal dan uji pemulihan tersedia.
- Target kapasitas final ditetapkan setelah volume paket diketahui.

### Perangkat
- Web responsif untuk admin.
- PWA/halaman scanner yang nyaman digunakan di Android.
- Kamera atau scanner eksternal harus diuji pada perangkat target.
- Jika kamera tidak tersedia, input manual dapat digunakan sesuai hak akses.
- Mode offline penuh tidak termasuk MVP.

---

## 13. Integrasi dan Ketergantungan

- Format ekspor marketplace yang dipakai pelanggan.
- Kamera/scanner yang kompatibel dengan browser.
- Penyimpanan foto.
- Email/notifikasi jika diaktifkan.
- Penyedia hosting/database.
- Penyedia AI jika fitur opsional diaktifkan.

Integrasi langsung marketplace dan ekspedisi tidak diasumsikan tersedia. CSV/XLSX tetap menjadi jalur utama MVP.

---

## 14. Pengujian dan Kriteria Rilis

Wajib diuji:
- CSV/XLSX valid, rusak, kosong, dan dengan kolom berbeda.
- Baris dengan resi kosong atau duplikat.
- Impor file yang sama berulang kali.
- Paket yang cocok dengan manifest.
- Paket duplikat dipindai.
- Paket di luar manifest.
- Paket yang sudah diserahkan sebelumnya.
- Serah terima sebagian dan beberapa sesi.
- Dua operator memindai paket sama secara bersamaan.
- Paket ditolak kurir.
- Koreksi dan penutupan manifest.
- Akses lintas tenant dan pembatasan role.
- Akses bukti foto.
- Audit log.
- Backup dan pemulihan.

Rilis tidak boleh dilakukan jika jumlah paket dapat dimanipulasi tanpa jejak, konfirmasi penerimaan dapat dibuat tanpa otorisasi, atau data tenant dapat diakses pihak yang tidak berhak.

---

## 15. Tahapan Implementasi

### Fase 1 — Fondasi
Autentikasi, organisasi, toko, role, database, dan audit log.

### Fase 2 — Impor dan validasi
CSV/XLSX, pemetaan kolom, pratinjau, laporan baris gagal, dan pencegahan duplikasi.

### Fase 3 — Manifest dan scanner
Pembuatan manifest, pemindaian, pencocokan, rekonsiliasi, dan serah terima sebagian.

### Fase 4 — Bukti dan pelaporan
Konfirmasi penerimaan, foto opsional, insiden, dashboard, ekspor, backup, dan penguatan keamanan.

### Fase 5 — Pengembangan lanjutan
AI pemetaan kolom, deteksi anomali, notifikasi, dan integrasi API jika dibutuhkan.

---

## 16. Keputusan yang Masih Harus Ditetapkan

- Format Excel/CSV pertama yang harus didukung.
- Apakah satu baris file selalu mewakili satu paket.
- Apakah nomor resi unik per toko, per ekspedisi, atau per periode.
- Apakah kurir mengonfirmasi lewat akun sendiri, PIN, atau konfirmasi bersama.
- Apakah foto/tanda tangan wajib.
- Apakah satu manifest boleh mencakup beberapa toko.
- Volume paket harian dan jumlah pengguna bersamaan.
- Retensi file impor, foto, dan data pelanggan.
- Hosting/database final.
- Model harga dan kuota SaaS.

Keputusan tersebut perlu ditetapkan sebelum implementasi detail yang bergantung padanya.
