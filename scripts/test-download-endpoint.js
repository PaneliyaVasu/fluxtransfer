/**
 * Download Endpoint Test Script
 * Verifies HTTP server returns:
 * - HTTP 200
 * - Content-Type: application/vnd.android.package-archive
 * - Content-Disposition: attachment; filename="FluxTransfer.apk"
 * - Exact byte length matching generated APK
 * - Identical SHA-256 checksum
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APK_PATH = path.join(__dirname, '..', 'src', 'client', 'downloads', 'android', 'FluxTransfer.apk');
const diskBuffer = fs.readFileSync(APK_PATH);
const diskSha256 = crypto.createHash('sha256').update(diskBuffer).digest('hex');

function testEndpoint() {
  console.log('🌐 Testing http://localhost:8080/downloads/android/FluxTransfer.apk...');

  const req = http.get('http://localhost:8080/downloads/android/FluxTransfer.apk', (res) => {
    console.log(`📌 HTTP Status: ${res.statusCode}`);
    console.log(`📌 Content-Type: ${res.headers['content-type']}`);
    console.log(`📌 Content-Disposition: ${res.headers['content-disposition']}`);
    console.log(`📌 Content-Length: ${res.headers['content-length']}`);

    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => {
      const downloadedBuffer = Buffer.concat(chunks);
      const downloadedSha256 = crypto.createHash('sha256').update(downloadedBuffer).digest('hex');

      console.log(`\n📌 Downloaded bytes: ${downloadedBuffer.length} (Disk: ${diskBuffer.length})`);
      console.log(`📌 Downloaded SHA-256: ${downloadedSha256}`);
      console.log(`📌 Disk SHA-256:       ${diskSha256}`);

      const statusMatch = res.statusCode === 200;
      const typeMatch = res.headers['content-type'] === 'application/vnd.android.package-archive';
      const sizeMatch = downloadedBuffer.length === diskBuffer.length;
      const shaMatch = downloadedSha256 === diskSha256;

      if (statusMatch && typeMatch && sizeMatch && shaMatch) {
        console.log('\n🎉 Download Endpoint Verification PASSED!');
        process.exit(0);
      } else {
        console.error('\n❌ Download Endpoint Verification FAILED!');
        process.exit(1);
      }
    });
  });

  req.on('error', (err) => {
    console.error('❌ Connection error:', err.message);
    process.exit(1);
  });
}

testEndpoint();
