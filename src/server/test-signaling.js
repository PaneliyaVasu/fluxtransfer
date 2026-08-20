/**
 * Automated test script for FluxTransfer WebSocket Signaling Server
 */
const { WebSocket } = require('ws');
const { spawn } = require('child_process');

async function runTests() {
  console.log('🧪 Starting Signaling Server Automated Tests...');

  // Start server process
  const serverProc = spawn('node', ['src/server/signaling-server.js'], {
    stdio: 'pipe'
  });

  serverProc.stdout.on('data', (data) => {
    // console.log(`[Server]: ${data}`);
  });

  // Wait 1 sec for server to boot
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const WS_URL = 'ws://localhost:8080';
  const testRoom = 'TEST_' + Math.floor(1000 + Math.random() * 9000);

  try {
    // Client 1 (Initiator)
    const client1 = new WebSocket(WS_URL);
    await new Promise((resolve) => client1.on('open', resolve));
    console.log('✓ Client 1 connected');

    // Client 1 joins room
    client1.send(JSON.stringify({ type: 'join-room', room: testRoom }));

    const c1Joined = await new Promise((resolve) => {
      client1.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'joined') resolve(msg);
      });
    });

    console.log(`✓ Client 1 joined room as ${c1Joined.role}`);

    // Client 2 (Joiner)
    const client2 = new WebSocket(WS_URL);
    await new Promise((resolve) => client2.on('open', resolve));
    console.log('✓ Client 2 connected');

    // Listen for peer-joined notification on Client 1
    const p1NotifiedPromise = new Promise((resolve) => {
      client1.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'peer-joined') resolve(msg);
      });
    });

    // Client 2 joins room
    client2.send(JSON.stringify({ type: 'join-room', room: testRoom }));

    const c2Joined = await new Promise((resolve) => {
      client2.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'joined') resolve(msg);
      });
    });

    console.log(`✓ Client 2 joined room as ${c2Joined.role}`);
    await p1NotifiedPromise;
    console.log('✓ Client 1 received peer-joined notification');

    // Test SDP Offer Relay
    const offerPromise = new Promise((resolve) => {
      client2.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'offer') resolve(msg);
      });
    });

    client1.send(JSON.stringify({ type: 'offer', offer: { type: 'offer', sdp: 'fake-sdp-offer' } }));
    const receivedOffer = await offerPromise;
    console.log('✓ SDP Offer relayed successfully to Client 2:', receivedOffer.offer.sdp);

    // Test SDP Answer Relay
    const answerPromise = new Promise((resolve) => {
      client1.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'answer') resolve(msg);
      });
    });

    client2.send(JSON.stringify({ type: 'answer', answer: { type: 'answer', sdp: 'fake-sdp-answer' } }));
    const receivedAnswer = await answerPromise;
    console.log('✓ SDP Answer relayed successfully to Client 1:', receivedAnswer.answer.sdp);

    // Test Room Full (Client 3)
    const client3 = new WebSocket(WS_URL);
    await new Promise((resolve) => client3.on('open', resolve));
    client3.send(JSON.stringify({ type: 'join-room', room: testRoom }));

    const c3Response = await new Promise((resolve) => {
      client3.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'room-full') resolve(msg);
      });
    });
    console.log(`✓ Client 3 rejected: Room full (${c3Response.room})`);

    // Clean up connections
    client1.close();
    client2.close();
    client3.close();

    console.log('\n🎉 ALL SIGNALING SERVER TESTS PASSED SUCCESSFULLY!\n');
  } catch (err) {
    console.error('❌ Test failed:', err);
  } finally {
    serverProc.kill();
  }
}

runTests();
