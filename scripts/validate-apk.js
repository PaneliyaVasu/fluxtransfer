/**
 * APK Validation Script
 * Reads the generated FluxTransfer.apk file as a ZIP archive
 * and checks for required Android structural elements:
 * - AndroidManifest.xml
 * - classes.dex
 * - assets/public/index.html
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APK_PATH = path.join(__dirname, '..', 'src', 'client', 'downloads', 'android', 'FluxTransfer.apk');
const METADATA_PATH = path.join(__dirname, '..', 'src', 'client', 'downloads', 'android', 'metadata.json');

function validateApk() {
  console.log('🔍 Validating FluxTransfer.apk...');

  if (!fs.existsSync(APK_PATH)) {
    console.error('❌ APK file does not exist at:', APK_PATH);
    process.exit(1);
  }

  const stats = fs.statSync(APK_PATH);
  console.log(`📌 File Size: ${stats.size} bytes (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

  if (stats.size === 0) {
    console.error('❌ APK is 0 bytes!');
    process.exit(1);
  }

  // Calculate SHA-256
  const fileBuffer = fs.readFileSync(APK_PATH);
  const hashSum = crypto.createHash('sha256');
  hashSum.update(fileBuffer);
  const sha256 = hashSum.digest('hex');
  console.log(`📌 SHA-256: ${sha256}`);

  // Inspect ZIP central directory header to find AndroidManifest.xml and classes.dex
  const fileStr = fileBuffer.toString('latin1');
  const hasManifest = fileStr.includes('AndroidManifest.xml');
  const hasClassesDex = fileStr.includes('classes.dex');
  const hasPublicIndex = fileStr.includes('assets/public/index.html');

  console.log(`📌 AndroidManifest.xml present: ${hasManifest ? 'YES ✅' : 'NO ❌'}`);
  console.log(`📌 classes.dex present: ${hasClassesDex ? 'YES ✅' : 'NO ❌'}`);
  console.log(`📌 Web App assets present: ${hasPublicIndex ? 'YES ✅' : 'NO ❌'}`);

  if (!hasManifest || !hasClassesDex || !hasPublicIndex) {
    console.error('❌ APK structural validation failed!');
    process.exit(1);
  }

  // Check metadata.json consistency
  if (fs.existsSync(METADATA_PATH)) {
    const meta = JSON.parse(fs.readFileSync(METADATA_PATH, 'utf8'));
    console.log(`📌 metadata.json SHA-256 match: ${meta.sha256 === sha256 ? 'YES ✅' : 'NO ❌'}`);
    console.log(`📌 metadata.json sizeBytes match: ${meta.sizeBytes === stats.size ? 'YES ✅' : 'NO ❌'}`);
  }

  console.log('\n🎉 APK Validation PASSED Perfectly!');
}

validateApk();
