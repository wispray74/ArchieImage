const CryptoJS = require('crypto-js');
const KEY = process.env.ENCRYPT_KEY || 'default_key_change_in_production!!';

function encrypt(text) { return CryptoJS.AES.encrypt(text, KEY).toString(); }
function decrypt(cipher) { return CryptoJS.AES.decrypt(cipher, KEY).toString(CryptoJS.enc.Utf8); }

module.exports = { encrypt, decrypt };
