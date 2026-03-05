const fs    = require('fs');
const path  = require('path');
const https = require('https');
const { fetch } = require('undici');
const { decrypt } = require('./crypto');

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function pollOperation(apiKey, operationPath) {
  const opId = operationPath.split('/').pop();
  const url  = `https://apis.roblox.com/assets/v1/operations/${opId}`;

  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const res  = await fetch(url, { headers: { 'x-api-key': apiKey } });
    const data = await res.json();
    console.log(`[Roblox] Poll ${i + 1}:`, JSON.stringify(data));

    if (data.done) {
      const assetId = data.response?.assetId || data.response?.asset?.assetId || data.response?.id;
      if (!assetId) throw new Error('Done tapi assetId tidak ada: ' + JSON.stringify(data));
      return assetId;
    }
    if (data.error) throw new Error('Operation error: ' + JSON.stringify(data.error));
  }
  throw new Error('Timeout menunggu upload selesai');
}

async function uploadImage(filePath, title, groupId, encryptedApiKey, robloxUserId) {
  if (!fs.existsSync(filePath)) throw new Error('File tidak ditemukan: ' + filePath);
  if (!encryptedApiKey)         throw new Error('API key belum diisi');

  const apiKey     = decrypt(encryptedApiKey).trim();
  const fileBuffer = fs.readFileSync(filePath);
  const filename   = path.basename(filePath);
  const ext        = path.extname(filename).toLowerCase();

  const mimeType = ext === '.png'  ? 'image/png'
                 : ext === '.jpg'  ? 'image/jpeg'
                 : ext === '.jpeg' ? 'image/jpeg'
                 : ext === '.gif'  ? 'image/gif'
                 : ext === '.bmp'  ? 'image/bmp'
                 : ext === '.webp' ? 'image/webp'
                 : 'image/png';

  console.log(`[Roblox] Uploading image "${title}" (${fileBuffer.length} bytes)`);

  const requestJson = JSON.stringify({
    assetType:   'Decal',
    displayName: title,
    description: 'Uploaded via Archie Image',
    creationContext: {
      creator: groupId
        ? { groupId: String(groupId) }
        : { userId: String(robloxUserId) }
    }
  });

  const boundary = 'ArchieBoundary' + Date.now();
  const nl       = '\r\n';

  const partRequest = Buffer.from(
    `--${boundary}${nl}` +
    `Content-Disposition: form-data; name="request"${nl}${nl}` +
    `${requestJson}${nl}`
  );
  const partFileHeader = Buffer.from(
    `--${boundary}${nl}` +
    `Content-Disposition: form-data; name="fileContent"; filename="${filename}"${nl}` +
    `Content-Type: ${mimeType}${nl}${nl}`
  );
  const partClose = Buffer.from(`${nl}--${boundary}--${nl}`);
  const body      = Buffer.concat([partRequest, partFileHeader, fileBuffer, partClose]);

  const result = await httpsRequest({
    hostname: 'apis.roblox.com',
    path:     '/assets/v1/assets',
    method:   'POST',
    headers: {
      'x-api-key':      apiKey,
      'Content-Type':   `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
      'Accept':         'application/json'
    }
  }, body);

  console.log(`[Roblox] Response (${result.status}): ${result.text}`);

  let data;
  try { data = JSON.parse(result.text); }
  catch { throw new Error('Response bukan JSON: ' + result.text); }

  if (result.status !== 200 && result.status !== 201) {
    const msg = data?.message || data?.errors?.[0]?.message || result.text;
    throw new Error(`Upload gagal (${result.status}): ${msg}`);
  }

  const operationPath = data.path || data.operationId;
  if (operationPath) return await pollOperation(apiKey, operationPath);

  const assetId = data.assetId || data.id;
  if (!assetId) throw new Error('Asset ID tidak ada: ' + result.text);
  return assetId;
}

module.exports = { uploadImage };
