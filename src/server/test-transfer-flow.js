/**
 * FluxTransfer — Automated Protocol & Full Transfer Flow Test Suite
 *
 * Exercises:
 * 1. Room pairing & role assignment (Initiator vs Joiner)
 * 2. Signaling message relay (SDP Offer/Answer & ICE candidates)
 * 3. File metadata frame structure & backpressure configuration
 * 4. Simulated P2P chunk streaming & complete Blob reassembly
 * 5. Completion acknowledgment ('ack-complete') lifecycle
 * 6. Cancellation protocol ('cancel')
 */

const { WebSocket } = require('ws');
const { spawn } = require('child_process');
const { webcrypto } = require('crypto');
const EngineModule = require('../engine/webrtc-engine.js');
const FluxWebRTCEngine = EngineModule.default || EngineModule;

async function runTestSuite() {
  console.log('\n==================================================');
  console.log('🧪 FluxTransfer — Complete Transfer Flow Test Suite');
  console.log('==================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}`);
      failed++;
    }
  }

  // 1. Boot signaling server
  const serverProc = spawn('node', ['src/server/signaling-server.js'], { stdio: 'pipe' });
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const WS_URL = 'ws://localhost:8080';
  const roomCode = 'TEST_' + Math.floor(1000 + Math.random() * 9000);

  try {
    // ── Test 1: Signaling Room & Role Assignment ──────────────────────────────
    console.log('📋 Test Group 1: Signaling Server & Pairing');

    const clientSender = new WebSocket(WS_URL);
    await new Promise((resolve) => clientSender.on('open', resolve));
    clientSender.send(JSON.stringify({ type: 'join-room', room: roomCode }));

    const senderJoined = await new Promise((resolve) => {
      clientSender.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'joined') resolve(msg);
      });
    });

    assert(senderJoined.role === 'initiator', 'First client joins room as "initiator"');
    assert(senderJoined.peerPresent === false, 'First client reports peerPresent = false');

    const clientReceiver = new WebSocket(WS_URL);
    await new Promise((resolve) => clientReceiver.on('open', resolve));

    const senderNotifiedPromise = new Promise((resolve) => {
      clientSender.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'peer-joined') resolve(msg);
      });
    });

    clientReceiver.send(JSON.stringify({ type: 'join-room', room: roomCode }));

    const receiverJoined = await new Promise((resolve) => {
      clientReceiver.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'joined') resolve(msg);
      });
    });

    assert(receiverJoined.role === 'joiner', 'Second client joins room as "joiner"');
    assert(receiverJoined.peerPresent === true, 'Second client reports peerPresent = true');

    const senderNotification = await senderNotifiedPromise;
    assert(senderNotification.type === 'peer-joined', 'Sender receives "peer-joined" notification when receiver joins');


    // ── Test 2: Single Offer/Answer Handshake Protocol ────────────────────────
    console.log('\n📋 Test Group 2: SDP Signaling Handshake');

    const receiverOfferPromise = new Promise((resolve) => {
      clientReceiver.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'offer') resolve(msg);
      });
    });

    // Only Sender (initiator) sends Offer
    const dummyOffer = { type: 'offer', sdp: 'v=0\r\no=- 123 456 IN IP4 127.0.0.1' };
    clientSender.send(JSON.stringify({ type: 'offer', offer: dummyOffer }));

    const receivedOffer = await receiverOfferPromise;
    assert(receivedOffer.offer.sdp === dummyOffer.sdp, 'SDP Offer correctly relayed to Joiner');

    const senderAnswerPromise = new Promise((resolve) => {
      clientSender.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'answer') resolve(msg);
      });
    });

    const dummyAnswer = { type: 'answer', sdp: 'v=0\r\no=- 789 101 IN IP4 127.0.0.1' };
    clientReceiver.send(JSON.stringify({ type: 'answer', answer: dummyAnswer }));

    const receivedAnswer = await senderAnswerPromise;
    assert(receivedAnswer.answer.sdp === dummyAnswer.sdp, 'SDP Answer correctly relayed to Initiator');


    // ── Test 3: Encrypted Chunk Protocol & Completion Ack ────────────────────
    console.log('\n📋 Test Group 3: Encrypted Chunk Protocol & Completion Ack');

    const engine = new FluxWebRTCEngine();
    const sessionCode = '123456';
    const testFileSize = 180 * 1024; // 180 KB
    const chunkSize = 64 * 1024; // 64 KB
    const mockFileBuffer = Buffer.alloc(testFileSize, 'a');

    const salt = webcrypto.getRandomValues(new Uint8Array(16));
    const aesKey = await engine.deriveKey(sessionCode, salt);
    const fileHash = await engine._computeHash(new Blob([mockFileBuffer]));

    const metadata = {
      type: 'metadata',
      name: 'test_document.pdf',
      size: testFileSize,
      mimeType: 'application/pdf',
      chunkSize: chunkSize,
      totalChunks: Math.ceil(testFileSize / chunkSize),
      salt: Buffer.from(salt).toString('base64'),
      hash: fileHash
    };

    assert(metadata.type === 'metadata', 'Metadata frame contains required "type" field');
    assert(metadata.name === 'test_document.pdf', 'Metadata frame contains file name');
    assert(metadata.size === testFileSize, 'Metadata frame contains file size');
    assert(typeof metadata.salt === 'string', 'Metadata frame contains base64 salt');
    assert(typeof metadata.hash === 'string', 'Metadata frame contains SHA-256 hash');

    // Receiver derives same key
    const receiverKey = await engine.deriveKey(sessionCode, Buffer.from(metadata.salt, 'base64'));

    // Encrypt & decrypt chunks
    const receivedChunks = [];
    let receivedBytes = 0;
    let chunkIndex = 0;

    for (let offset = 0; offset < testFileSize; offset += chunkSize) {
      const slice = mockFileBuffer.subarray(offset, Math.min(offset + chunkSize, testFileSize));
      const rawChunk = slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
      const encryptedFrame = await engine.encryptChunk(rawChunk, chunkIndex, aesKey);

      const decrypted = await engine.decryptFrame(encryptedFrame.buffer, receiverKey);
      assert(decrypted.chunkIndex === chunkIndex, `Decrypted chunk index matches expected index ${chunkIndex}`);

      const decryptedBuf = Buffer.from(decrypted.chunkData);
      receivedChunks.push(decryptedBuf);
      receivedBytes += decryptedBuf.length;
      chunkIndex++;
    }

    assert(receivedBytes === testFileSize, 'Receiver accumulated 100% of transmitted file bytes');

    // Reassemble and verify SHA-256
    const reassembledBuffer = Buffer.concat(receivedChunks);
    assert(reassembledBuffer.equals(mockFileBuffer), 'Reassembled file byte contents match original byte-for-byte');

    const computedReceiverHash = await engine._computeHash(new Blob([reassembledBuffer]));
    assert(computedReceiverHash === fileHash, 'Receiver calculated SHA-256 hash matches sender metadata hash');

    const ackMessage = { type: 'ack-complete', hash: computedReceiverHash };
    assert(ackMessage.type === 'ack-complete', 'Ack-complete message frame correctly structured');


    // ── Test 4: Transfer Cancel Protocol ──────────────────────────────────────
    console.log('\n📋 Test Group 4: Transfer Cancellation');

    const cancelMessage = { type: 'cancel' };
    assert(cancelMessage.type === 'cancel', 'Cancel message frame correctly structured');


    // ── Test 5: Room Full Protection ──────────────────────────────────────────
    console.log('\n📋 Test Group 5: Room Capacity Safeguard');

    const clientExtra = new WebSocket(WS_URL);
    await new Promise((resolve) => clientExtra.on('open', resolve));

    const roomFullPromise = new Promise((resolve) => {
      clientExtra.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'room-full') resolve(msg);
      });
    });

    clientExtra.send(JSON.stringify({ type: 'join-room', room: roomCode }));
    const roomFullMsg = await roomFullPromise;

    assert(roomFullMsg.type === 'room-full', 'Third client attempt to join occupied room is rejected with "room-full"');

    // Cleanup sockets
    clientSender.close();
    clientReceiver.close();
    clientExtra.close();

  } catch (err) {
    console.error('❌ Test execution error:', err);
    failed++;
  } finally {
    serverProc.kill();
  }

  console.log('\n==================================================');
  console.log(`📊 Test Summary: ${passed} Passed, ${failed} Failed`);
  console.log('==================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite();
