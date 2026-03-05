# 🖼️ Archie Image — Roblox Image Uploader

Batch upload gambar ke Roblox, export Lua table siap pakai.

---

## Deploy ke Railway

**1. Push ke GitHub**
```bash
git init && git add . && git commit -m "init"
git remote add origin https://github.com/username/archie-image.git
git push -u origin main
```

**2. Railway setup**
- railway.app → New Project → Deploy from GitHub
- New → Database → PostgreSQL (DATABASE_URL otomatis tersedia)

**3. Environment Variables**
```
SESSION_SECRET=random_string_panjang_bebas
ENCRYPT_KEY=tepat_32_karakter_disini!!!!!
UPLOAD_DIR=./uploads
NODE_ENV=production
```

**4. Akses Setup**
- Buka `https://yoursite.railway.app/setup.html`
- Buat akun admin pertama

---

## Cara Pakai

1. **Tambah Roblox Account** — masukkan API key dari create.roblox.com/credentials (permission: Assets Read+Write)
2. **Upload** — drag gambar (PNG/JPG/GIF), nama file = nama asset di Roblox
3. **Tunggu** — antrian diproses otomatis, cek status di Jobs
4. **Export Lua** — salin tabel yang sudah siap

---

## Format Output

```lua
return {
    ["rbxassetid://99488084756007"] = "Asah Golok",
    ["rbxassetid://104954843331362"] = "Udang Rebus",
}
```

---

**Made by Archie**
