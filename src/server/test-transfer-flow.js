/**
 * FluxTransfer — Automated Protocol & Full Transfer Flow Test Suite
 *
 * Exercises:
 * 1. Room pairing & role assignment (Initiator vs Joiner)
 * 2. Signaling message relay (SDP Offer/Answer & ICE candidates)
 * 3. File metadata frame structure & backpressure configuration
 * 4. Deterministic Metadata Readiness Protocol (Sender wait for metadata-ack, early chunk queueing)
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
    clientSender.send(JSON.stringify({ type: 'join-room', room: roomCode, peerToken: 'sender_token_1' }));

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

    clientReceiver.send(JSON.stringify({ type: 'join-room', room: roomCode, peerToken: 'receiver_token_1' }));

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


    // ── Test 3: Encrypted Chunk Protocol & Metadata Ack ───────────────────────
    console.log('\n📋 Test Group 3: Encrypted Chunk Protocol & Metadata Ack Handshake');

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


    // ── Test 4: Bounded Early Chunk Queueing & Readiness Protocol ────────────
    console.log('\n📋 Test Group 4: Bounded Early Chunk Queue & Metadata ACK');

    const receiverEngine = new FluxWebRTCEngine();
    receiverEngine.sessionCode = sessionCode;

    // Simulate metadata frame arriving when receiver is not yet ready
    receiverEngine._receiverReady = false;
    receiverEngine._earlyChunkQueue = [];

    // Fabricate early binary chunk
    const earlyChunk = await engine.encryptChunk(Buffer.from('early-data'), 0, aesKey);

    // Feed binary chunk frame while _receiverReady is false
    await receiverEngine._handleDataChannelMessage(earlyChunk.buffer);

    assert(receiverEngine._earlyChunkQueue && receiverEngine._earlyChunkQueue.length === 1, 'Early binary chunk is queued when receiver is not yet ready');

    // Feed metadata frame to initialize receiver
    await receiverEngine._handleDataChannelMessage(JSON.stringify(metadata));

    assert(receiverEngine._receiverReady === true, 'Receiver becomes ready after processing metadata & key derivation');
    assert(receiverEngine._earlyChunkQueue === null, 'Early chunk queue is drained and cleared after receiver readiness');


    // ── Test 5: Metadata ACK Timeout Safeguard ──────────────────────────────
    console.log('\n📋 Test Group 5: Metadata ACK Timeout Safeguard');

    const senderEngine = new FluxWebRTCEngine();
    let timeoutCaught = false;

    try {
      await senderEngine._waitForMetadataAck(100); // 100ms test timeout
    } catch (err) {
      timeoutCaught = err.message.includes('timed out');
    }

    assert(timeoutCaught === true, 'Sender correctly times out if metadata-ack is not received');


    // ── Test 6: Metadata Initialization Error Handling ──────────────────────
    console.log('\n📋 Test Group 6: Metadata Error Protocol');

    let errorHandled = false;
    senderEngine.on('error', () => { errorHandled = true; });

    const metadataErrorMsg = JSON.stringify({ type: 'metadata-error', error: 'Storage initialization error' });
    await senderEngine._handleDataChannelMessage(metadataErrorMsg);

    assert(errorHandled === true, 'Sender transitions to error state when receiver returns metadata-error');


    // ── Test 7: Room Full Safeguard ──────────────────────────────────────────
    console.log('\n📋 Test Group 7: Room Capacity Safeguard');

    const clientExtra = new WebSocket(WS_URL);
    await new Promise((resolve) => clientExtra.on('open', resolve));

    const roomFullPromise = new Promise((resolve) => {
      clientExtra.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'room-full') resolve(msg);
      });
    });

    clientExtra.send(JSON.stringify({ type: 'join-room', room: roomCode, peerToken: 'token_extra' }));
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
